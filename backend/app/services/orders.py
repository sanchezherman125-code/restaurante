import logging
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationAppError
from app.models import Command, MenuCategory, MenuItem, Order, OrderItem, User
from app.models.enums import ItemStatus, OrderStatus, OrderType, PreparationArea
from app.ws.hub import hub

logger = logging.getLogger("app.orders")

ACTIVE_ITEM_STATUSES = {ItemStatus.PENDING, ItemStatus.PREPARING, ItemStatus.READY, ItemStatus.DELIVERED}

ALLOWED_TRANSITIONS: dict[str, set[str]] = {
    ItemStatus.PENDING: {ItemStatus.PREPARING, ItemStatus.DELIVERED, ItemStatus.CANCELLED},
    ItemStatus.PREPARING: {ItemStatus.READY, ItemStatus.CANCELLED},
    ItemStatus.READY: {ItemStatus.DELIVERED},
    ItemStatus.DELIVERED: set(),
    ItemStatus.CANCELLED: set(),
}


def utcnow() -> datetime:
    return datetime.now(UTC)


def recompute_totals(order: Order) -> None:
    subtotal = Decimal("0.00")
    for item in order.items:
        if item.status != ItemStatus.CANCELLED:
            subtotal += Decimal(item.unit_price_snapshot) * item.quantity
    order.subtotal = subtotal
    order.total = subtotal


def compute_status(order: Order) -> str:
    if order.status == OrderStatus.CLOSED:
        return OrderStatus.CLOSED
    if order.paid_amount is not None and order.total is not None and order.total > 0:
        if order.paid_amount >= order.total:
            return OrderStatus.PAID

    active = [i for i in order.items if i.status != ItemStatus.CANCELLED]
    if not active:
        return order.status if order.status in (OrderStatus.PAID, OrderStatus.CLOSED) else OrderStatus.OPEN

    prep_items = [i for i in active if i.requires_preparation]
    if any(i.status == ItemStatus.PREPARING for i in prep_items):
        return OrderStatus.IN_PREPARATION
    if all(i.status == ItemStatus.DELIVERED for i in active):
        return OrderStatus.DELIVERED
    if any(i.status == ItemStatus.PENDING for i in prep_items):
        return OrderStatus.OPEN
    return OrderStatus.READY


def apply_status(order: Order) -> str:
    order.status = compute_status(order)
    return order.status


def broadcast_order_ready(order: Order) -> None:
    hub.broadcast(
        "order.ready",
        {
            "order_id": str(order.id),
            "table_name": order.table_name,
            "table_number": order.table_number,
            "message": f"{order.table_name or f'Mesa {order.table_number}'} — Pedido listo",
        },
        {"waiters", "admin"},
    )


def order_event_payload(order: Order) -> dict:
    return {
        "order_id": str(order.id),
        "table_id": str(order.table_id) if order.table_id else None,
        "table_name": order.table_name,
        "table_number": order.table_number,
        "status": order.status,
        "order_type": order.order_type,
        "persons_count": order.persons_count,
        "total": str(order.total),
        "paid_amount": str(order.paid_amount),
        "created_by_waiter_id": str(order.created_by_waiter_id),
        "created_by_waiter_name": order.created_by_waiter_name,
        "updated_at": order.updated_at.isoformat() if order.updated_at else None,
    }


def item_event_payload(item: OrderItem) -> dict:
    return {
        "item_id": str(item.id),
        "order_id": str(item.order_id),
        "command_id": str(item.command_id),
        "name": item.menu_item_name_snapshot,
        "quantity": item.quantity,
        "status": item.status,
        "requires_preparation": item.requires_preparation,
        "preparation_area": item.preparation_area,
        "expected_prep_minutes": item.expected_prep_minutes_snapshot,
        "preparation_started_at": item.preparation_started_at.isoformat() if item.preparation_started_at else None,
        "ready_at": item.ready_at.isoformat() if item.ready_at else None,
        "cancelled_after_preparation_started": item.cancelled_after_preparation_started,
    }


def get_active_order(db: Session, order_id: UUID) -> Order:
    order = db.get(Order, order_id)
    if order is None:
        raise NotFoundError("ORDER_NOT_FOUND", "Pedido no encontrado.")
    return order


def ensure_order_modifiable(order: Order) -> None:
    if order.status == OrderStatus.CLOSED:
        raise ConflictError("ORDER_ALREADY_CLOSED", "El pedido ya está cerrado.")
    if order.status == OrderStatus.PAID:
        raise ConflictError("ORDER_ALREADY_PAID", "El pedido ya está pagado.")


def ensure_table_free(db: Session, table_id: UUID) -> None:
    existing = (
        db.query(Order)
        .filter(
            Order.table_id == table_id,
            Order.status.in_([OrderStatus.OPEN, OrderStatus.IN_PREPARATION, OrderStatus.READY, OrderStatus.DELIVERED]),
        )
        .first()
    )
    if existing is not None:
        raise ConflictError(
            "TABLE_ALREADY_OPEN",
            "La mesa ya tiene un pedido abierto.",
            {"order_id": str(existing.id)},
        )


def create_order(
    db: Session,
    user: User,
    *,
    order_type: OrderType,
    table_id: UUID | None,
    persons_count: int | None,
    notes: str | None,
    shift_id: UUID,
) -> Order:
    if order_type == OrderType.DINE_IN:
        if table_id is None:
            raise ValidationAppError("TABLE_REQUIRED", "La mesa es obligatoria para pedidos en mesa.")
        if persons_count is None or persons_count < 1:
            raise ValidationAppError(
                "PERSONS_COUNT_REQUIRED",
                "Debe registrar la cantidad de personas.",
            )
        ensure_table_free(db, table_id)

    order = Order(
        shift_id=shift_id,
        table_id=table_id,
        order_type=order_type,
        persons_count=persons_count,
        created_by_waiter_id=user.id,
        status=OrderStatus.OPEN,
        notes=notes,
        subtotal=Decimal("0.00"),
        total=Decimal("0.00"),
        paid_amount=Decimal("0.00"),
        opened_at=utcnow(),
    )
    db.add(order)
    db.flush()
    hub.broadcast("order.created", order_event_payload(order), {"waiters", "admin"})
    return order


def _next_sequence(db: Session, order_id: UUID) -> int:
    last = db.query(Command).filter(Command.order_id == order_id).order_by(Command.sequence_number.desc()).first()
    return (last.sequence_number + 1) if last else 1


def create_command(
    db: Session,
    user: User,
    order: Order,
    *,
    items: list[dict],
    notes: str | None,
    client_operation_id: UUID | None = None,
) -> Command:
    ensure_order_modifiable(order)

    if client_operation_id is not None:
        existing = db.query(Command).filter(Command.client_operation_id == client_operation_id).first()
        if existing is not None:
            return existing

    resolved: list[tuple[MenuItem, dict]] = []
    for entry in items:
        menu_item = db.get(MenuItem, entry["menu_item_id"])
        if menu_item is None or not menu_item.is_active:
            raise NotFoundError("MENU_ITEM_NOT_FOUND", "El producto solicitado no existe.")
        if not menu_item.is_available:
            raise ConflictError(
                "ITEM_SOLD_OUT",
                f"'{menu_item.name}' está agotado y no puede agregarse.",
                {"menu_item_id": str(menu_item.id)},
            )
        resolved.append((menu_item, entry))

    command = Command(
        order_id=order.id,
        sequence_number=_next_sequence(db, order.id),
        created_by_user_id=user.id,
        client_operation_id=client_operation_id,
        notes=notes,
        created_at=utcnow(),
    )
    db.add(command)
    db.flush()

    for menu_item, entry in resolved:
        item = OrderItem(
            command_id=command.id,
            order_id=order.id,
            menu_item_id=menu_item.id,
            menu_item_name_snapshot=menu_item.name,
            unit_price_snapshot=menu_item.price,
            quantity=entry.get("quantity", 1),
            requires_preparation=menu_item.requires_preparation,
            preparation_area=menu_item.preparation_area,
            status=ItemStatus.PENDING,
            notes=entry.get("notes"),
            replacement_description=entry.get("replacement_description"),
            expected_prep_minutes_snapshot=menu_item.expected_prep_minutes,
        )
        db.add(item)

    db.flush()
    db.expire(order, ["items", "commands"])
    recompute_totals(order)
    previous_order_status = order.status
    apply_status(order)
    db.flush()

    command.items  # noqa: B018 - carga la relación para la respuesta
    hub.broadcast(
        "command.created",
        {
            "order_id": str(order.id),
            "command_id": str(command.id),
            "sequence_number": command.sequence_number,
            "table_name": order.table_name,
            "table_number": order.table_number,
            "created_at": command.created_at.isoformat() if command.created_at else None,
            "areas": sorted({i.preparation_area for i in command.items if i.preparation_area}),
        },
        {"kitchen", "grill", "admin", "waiters"},
    )
    hub.broadcast("order.updated", order_event_payload(order), {"waiters", "admin"})
    if order.status == OrderStatus.READY and previous_order_status != OrderStatus.READY:
        broadcast_order_ready(order)
    return command


def validate_transition(current: ItemStatus, new: ItemStatus, requires_preparation: bool) -> None:
    allowed = set(ALLOWED_TRANSITIONS.get(current, set()))
    if not requires_preparation:
        # Los productos de entrega directa no pasan por preparación.
        allowed = {ItemStatus.DELIVERED, ItemStatus.CANCELLED} if current == ItemStatus.PENDING else set()
    elif new == ItemStatus.DELIVERED and current == ItemStatus.PENDING:
        # Un producto de área de preparación debe prepararse y estar listo antes de entregarse.
        allowed.discard(ItemStatus.DELIVERED)
    if new not in allowed:
        raise ConflictError(
            "INVALID_STATUS_TRANSITION",
            f"Transición no permitida: {current} → {new}.",
            {"current": current, "requested": new},
        )


def change_item_status(
    db: Session,
    user: User,
    item: OrderItem,
    new_status: ItemStatus,
) -> OrderItem:
    current = ItemStatus(item.status)
    if new_status == ItemStatus.CANCELLED:
        raise ValidationAppError("USE_CANCEL_ENDPOINT", "Use el endpoint de cancelación.")
    validate_transition(current, new_status, item.requires_preparation)

    now = utcnow()
    if new_status == ItemStatus.PREPARING:
        if item.preparation_started_at is None:
            item.preparation_started_at = now
    elif new_status == ItemStatus.READY:
        if item.preparation_started_at is None:
            item.preparation_started_at = now
        item.ready_at = now
    elif new_status == ItemStatus.DELIVERED:
        if item.preparation_started_at is None and item.requires_preparation:
            item.preparation_started_at = now
        if item.ready_at is None and item.requires_preparation:
            item.ready_at = now
        item.delivered_at = now

    item.status = new_status
    db.flush()

    order = item.order
    previous_order_status = order.status
    apply_status(order)
    db.flush()

    hub.broadcast("order_item.updated", item_event_payload(item), {"admin"})
    area_channel = {
        PreparationArea.KITCHEN: "kitchen",
        PreparationArea.GRILL: "grill",
    }.get(PreparationArea(item.preparation_area), "admin") if item.requires_preparation else "waiters"
    hub.broadcast("order_item.updated", item_event_payload(item), {area_channel})

    if new_status == ItemStatus.READY:
        hub.broadcast("order_item.ready", item_event_payload(item), {"waiters", "admin", "kitchen", "grill"})
    if order.status == OrderStatus.READY and previous_order_status != OrderStatus.READY:
        broadcast_order_ready(order)
    return item


def cancel_item(
    db: Session,
    user: User,
    item: OrderItem,
    reason: str | None,
) -> OrderItem:
    current = ItemStatus(item.status)
    if current not in (ItemStatus.PENDING, ItemStatus.PREPARING):
        raise ConflictError(
            "ITEM_NOT_CANCELLABLE",
            f"Un item en estado {current} no puede cancelarse.",
        )
    item.status = ItemStatus.CANCELLED
    item.cancelled_at = utcnow()
    item.cancelled_by = user.id
    item.cancelled_after_preparation_started = current == ItemStatus.PREPARING
    item.cancellation_reason = reason
    db.flush()

    order = item.order
    previous_order_status = order.status
    recompute_totals(order)
    apply_status(order)
    db.flush()

    hub.broadcast("order_item.updated", item_event_payload(item), {"admin", "kitchen", "grill", "waiters"})
    hub.broadcast("order.updated", order_event_payload(order), {"waiters", "admin"})
    if order.status == OrderStatus.READY and previous_order_status != OrderStatus.READY:
        broadcast_order_ready(order)
    return item


def serialize_order(order: Order) -> dict:
    from app.schemas.orders import OrderOut

    return OrderOut.model_validate(order).model_dump(mode="json")


def active_orders_query(db: Session, area: str | None = None):
    query = db.query(Order).filter(
        Order.status.in_(
            [
                OrderStatus.OPEN,
                OrderStatus.IN_PREPARATION,
                OrderStatus.READY,
                OrderStatus.DELIVERED,
            ]
        )
    )
    if area and area in {a.value for a in PreparationArea}:
        query = query.join(OrderItem, OrderItem.order_id == Order.id).filter(
            OrderItem.preparation_area == area,
            OrderItem.status.notin_([ItemStatus.CANCELLED, ItemStatus.DELIVERED]),
        )
    return query.order_by(Order.created_at.asc()).distinct()


def menu_category_names(db: Session) -> dict[UUID, str]:
    return {c.id: c.name for c in db.query(MenuCategory).all()}
