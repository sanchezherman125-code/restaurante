import logging
from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.errors import ConflictError, NotFoundError, ValidationAppError
from app.models import (
    Command,
    MenuCategory,
    MenuItem,
    Order,
    OrderItem,
    OrderItemPreparationTask,
    Shift,
    User,
)
from app.models.enums import ItemStatus, OrderStatus, OrderType, PreparationArea, TaskStatus
from app.services import preparation as prep
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
    total = sum(
        (Decimal(item.unit_price_snapshot) * item.quantity
         for item in order.items if item.status != ItemStatus.CANCELLED),
        Decimal("0.00"),
    )
    if total < order.paid_amount:
        raise ConflictError("TOTAL_BELOW_PAID", "El cambio dejaría el total por debajo del monto ya cobrado.")
    order.subtotal = total
    order.total = total


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


def broadcast_order_ready(db: Session, order: Order) -> None:
    hub.after_commit(
        db,
        "order.ready",
        {
            "order_id": str(order.id),
            "created_by_waiter_id": str(order.created_by_waiter_id),
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
    order = item.order
    return {
        "item_id": str(item.id),
        "created_by_waiter_id": str(order.created_by_waiter_id) if order else None,
        "order_id": str(item.order_id),
        "table_name": order.table_name if order else None,
        "table_number": order.table_number if order else None,
        "command_id": str(item.command_id),
        "name": item.menu_item_name_snapshot,
        "quantity": item.quantity,
        "status": item.status,
        "requires_preparation": item.requires_preparation,
        "preparation_area": item.preparation_area,
        "areas": sorted(prep.item_areas(item)),
        "expected_prep_minutes": item.expected_prep_minutes_snapshot,
        "preparation_started_at": item.preparation_started_at.isoformat() if item.preparation_started_at else None,
        "ready_at": item.ready_at.isoformat() if item.ready_at else None,
        "cancelled_after_preparation_started": item.cancelled_after_preparation_started,
    }


def task_event_payload(item: OrderItem, tasks: list, status: str) -> dict:
    """Progreso de una o más tareas de un plato; sin importes ni datos del cliente."""
    return {
        **item_event_payload(item),
        "task_ids": [str(t.id) for t in tasks],
        "task_names": [t.name for t in tasks],
        "task_area": tasks[0].area if tasks else None,
        "task_status": status,
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


def ensure_order_cancellable(order: Order) -> None:
    if order.status == OrderStatus.PAID:
        raise ConflictError("ORDER_ALREADY_PAID", "No se pueden cancelar productos de un pedido pagado.")
    if order.status == OrderStatus.CLOSED:
        raise ConflictError("ORDER_ALREADY_CLOSED", "No se pueden cancelar productos de un pedido cerrado.")


def lock_order_and_shift(db: Session, order_id: UUID, shift_id: UUID) -> tuple[Shift, Order]:
    """Serializa mutaciones financieras usando el orden global turno → pedido."""
    shift = db.query(Shift).filter(Shift.id == shift_id).populate_existing().with_for_update().one_or_none()
    if shift is None:
        raise NotFoundError("SHIFT_NOT_FOUND", "El turno del pedido no existe.")
    # Dependencias pueden haber cargado el pedido antes de esperar por el bloqueo.
    db.expire_all()
    order = db.query(Order).filter(Order.id == order_id).populate_existing().with_for_update(of=Order).one_or_none()
    if order is None:
        raise NotFoundError("ORDER_NOT_FOUND", "Pedido no encontrado.")
    if order.shift_id != shift.id:
        raise ConflictError("ORDER_SHIFT_CHANGED", "El turno del pedido cambió durante la operación.")
    return shift, order


def ensure_shift_open(shift: Shift) -> None:
    if shift.status != "OPEN":
        raise ConflictError("SHIFT_CLOSED", "El turno está cerrado. No se pueden modificar pedidos.")


def lock_order_item(db: Session, order_id: UUID, item_id: UUID) -> OrderItem:
    item = (
        db.query(OrderItem)
        .filter(OrderItem.id == item_id, OrderItem.order_id == order_id)
        .populate_existing()
        .with_for_update(of=OrderItem)
        .one_or_none()
    )
    if item is None:
        raise NotFoundError("ITEM_NOT_FOUND", "Producto no encontrado en este pedido.")
    return item


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
    hub.after_commit(db, "order.created", order_event_payload(order), {"waiters", "admin"})
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

    resolved: list[tuple[MenuItem, dict, list[prep.StepSpec]]] = []
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
        specs = (
            prep.steps_for_menu_item(menu_item, prep.load_steps(db, menu_item.id))
            if menu_item.requires_preparation
            else []
        )
        resolved.append((menu_item, entry, specs))

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

    for menu_item, entry, specs in resolved:
        item = OrderItem(
            command_id=command.id,
            order_id=order.id,
            menu_item_id=menu_item.id,
            menu_item_name_snapshot=menu_item.name,
            unit_price_snapshot=menu_item.price,
            quantity=entry.get("quantity", 1),
            requires_preparation=menu_item.requires_preparation,
            preparation_area=None,
            status=ItemStatus.PENDING,
            notes=entry.get("notes"),
            replacement_description=entry.get("replacement_description"),
            expected_prep_minutes_snapshot=None,
        )
        if specs:
            # Congela la receta vigente: cambios posteriores del catálogo no alteran esta comanda.
            prep.attach_tasks(item, specs)
        db.add(item)

    db.flush()
    db.expire(order, ["items", "commands"])
    recompute_totals(order)
    previous_order_status = order.status
    apply_status(order)
    db.flush()

    command.items  # noqa: B018 - carga la relación para la respuesta
    hub.after_commit(
        db,
        "command.created",
        {
            "order_id": str(order.id),
            "command_id": str(command.id),
            "created_by_waiter_id": str(order.created_by_waiter_id),
            "sequence_number": command.sequence_number,
            "table_name": order.table_name,
            "table_number": order.table_number,
            "created_at": command.created_at.isoformat() if command.created_at else None,
            "areas": sorted({a for i in command.items for a in prep.item_areas(i)}),
        },
        {"admin", "waiters"} | {prep.AREA_CHANNEL[a] for i in command.items for a in prep.item_areas(i)},
    )
    hub.after_commit(db, "order.updated", order_event_payload(order), {"waiters", "admin"})
    if order.status == OrderStatus.READY and previous_order_status != OrderStatus.READY:
        broadcast_order_ready(db, order)
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


def _publish_item_change(
    db: Session,
    item: OrderItem,
    previous_order_status: str,
    *,
    changed_tasks: list,
    task_status: str | None,
    refresh: prep.ItemRefresh,
    item_changed: bool,
) -> None:
    order = item.order
    channels = prep.item_channels(item)
    if changed_tasks and task_status:
        # Los tableros de ambas áreas reflejan el avance; no implica que el plato esté completo.
        hub.after_commit(db, "preparation_task.updated", task_event_payload(item, changed_tasks, task_status), channels)
    if item_changed:
        hub.after_commit(db, "order_item.updated", item_event_payload(item), channels | {"waiters"})
    order_became_ready = order.status == OrderStatus.READY and previous_order_status != OrderStatus.READY
    if refresh.became_ready:
        # Única finalización del plato: solo ocurre al cruzar PENDING/PREPARING → READY bajo bloqueo.
        # Si esa misma finalización completa el pedido, el aviso visible/Push es ``order.ready``; el evento del
        # plato se sigue emitiendo para actualizar pantallas, pero ``silent`` evita un segundo aviso al mesero.
        payload = {**item_event_payload(item), "silent": order_became_ready}
        hub.after_commit(db, "order_item.ready", payload, {"waiters", "admin"})
    if order_became_ready:
        broadcast_order_ready(db, order)


def change_task_statuses(
    db: Session,
    item: OrderItem,
    tasks: list,
    new_status: TaskStatus,
) -> list:
    """Avanza tareas de un plato y deriva el estado comercial. Devuelve las tareas que cambiaron.

    Llamar con turno, pedido y plato bloqueados. Repetir un estado ya alcanzado no cambia nada.
    """
    if item.status == ItemStatus.CANCELLED:
        raise ConflictError("ITEM_CANCELLED", "El producto fue cancelado.")
    now = utcnow()
    changed = prep.advance_tasks(tasks, new_status, now)
    if not changed:
        return []
    db.flush()
    order = item.order
    previous_order_status = order.status
    previous_item_status = item.status
    refresh = prep.refresh_item_from_tasks(item, now)
    db.flush()
    apply_status(order)
    db.flush()
    _publish_item_change(
        db,
        item,
        previous_order_status,
        changed_tasks=changed,
        task_status=new_status.value,
        refresh=refresh,
        item_changed=item.status != previous_item_status,
    )
    return changed


def change_item_status(
    db: Session,
    user: User,
    item: OrderItem,
    new_status: ItemStatus,
) -> bool:
    """Cambio a nivel de plato. PREPARING/READY avanzan las tareas del área del usuario; DELIVERED es del plato.

    Devuelve False cuando la solicitud ya estaba aplicada (reintento o mensaje atrasado).
    """
    current = ItemStatus(item.status)
    if new_status == ItemStatus.CANCELLED:
        raise ValidationAppError("USE_CANCEL_ENDPOINT", "Use el endpoint de cancelación.")

    if item.requires_preparation and new_status in (ItemStatus.PREPARING, ItemStatus.READY):
        prep.ensure_item_tasks(db, item)
        prep.lock_item_tasks(db, item.id)
        areas = prep.item_areas(item) if user.role == "ADMIN" else {prep.ROLE_AREA.get(user.role, "")}
        tasks = prep.tasks_in_areas(item, areas)
        if not tasks:
            raise ConflictError(
                "INVALID_STATUS_TRANSITION", "El producto no tiene tareas para su área.", {"current": current}
            )
        return bool(change_task_statuses(db, item, tasks, TaskStatus(new_status.value)))

    validate_transition(current, new_status, item.requires_preparation)

    now = utcnow()
    item.status = new_status
    item.delivered_at = now
    db.flush()

    order = item.order
    previous_order_status = order.status
    apply_status(order)
    db.flush()

    channels = prep.item_channels(item) if item.requires_preparation else {"admin", "waiters"}
    hub.after_commit(db, "order_item.updated", item_event_payload(item), channels | {"waiters"})
    if order.status == OrderStatus.READY and previous_order_status != OrderStatus.READY:
        broadcast_order_ready(db, order)
    return True


def cancel_item(
    db: Session,
    user: User,
    item: OrderItem,
    reason: str | None,
) -> OrderItem:
    """Cancela el plato completo y todas sus tareas, en cualquier área, como una sola operación."""
    ensure_order_cancellable(item.order)
    current = ItemStatus(item.status)
    if current not in (ItemStatus.PENDING, ItemStatus.PREPARING):
        raise ConflictError(
            "ITEM_NOT_CANCELLABLE",
            f"Un item en estado {current} no puede cancelarse.",
        )

    # Valida el total antes de cambiar o hacer flush de cualquier fila. Así un
    # pago concurrente que obtuvo primero el bloqueo nunca deja datos parciales.
    new_total = sum(
        (Decimal(other.unit_price_snapshot) * other.quantity
         for other in item.order.items if other.id != item.id and other.status != ItemStatus.CANCELLED),
        Decimal("0.00"),
    )
    if new_total < item.order.paid_amount:
        raise ConflictError("TOTAL_BELOW_PAID", "El cambio dejaría el total por debajo del monto ya cobrado.")

    prep.ensure_item_tasks(db, item)
    prep.lock_item_tasks(db, item.id)
    involved = prep.item_channels(item)
    now = utcnow()
    item.status = ItemStatus.CANCELLED
    item.cancelled_at = now
    item.cancelled_by = user.id
    item.cancelled_after_preparation_started = current == ItemStatus.PREPARING
    item.cancellation_reason = reason
    prep.cancel_tasks(item, now)
    db.flush()

    order = item.order
    previous_order_status = order.status
    order.subtotal = new_total
    order.total = new_total
    apply_status(order)
    db.flush()

    hub.after_commit(db, "order_item.updated", item_event_payload(item), involved | {"waiters"})
    hub.after_commit(db, "order.updated", order_event_payload(order), {"waiters", "admin"})
    if order.status == OrderStatus.READY and previous_order_status != OrderStatus.READY:
        broadcast_order_ready(db, order)
    return item


def serialize_order(order: Order) -> dict:
    from app.schemas.orders import OrderOut

    return OrderOut.model_validate(order).model_dump(mode="json")


def pending_preparation_exists():
    """EXISTS: el pedido aún tiene platos con preparación sin entregar (independiente del estado de pago)."""
    return (
        select(OrderItem.id)
        .where(
            OrderItem.order_id == Order.id,
            OrderItem.requires_preparation.is_(True),
            OrderItem.status.in_([ItemStatus.PENDING, ItemStatus.PREPARING, ItemStatus.READY]),
        )
        .correlate(Order)
        .exists()
    )


def active_orders_query(db: Session, area: str | None = None):
    """Pedidos con trabajo vivo; un pedido PAID sigue activo mientras queden platos por preparar o entregar."""
    query = db.query(Order).filter(
        Order.status.in_([OrderStatus.OPEN, OrderStatus.IN_PREPARATION, OrderStatus.READY, OrderStatus.DELIVERED])
        | ((Order.status == OrderStatus.PAID) & pending_preparation_exists())
    )
    if area and area in {a.value for a in PreparationArea}:
        query = (
            query.join(OrderItem, OrderItem.order_id == Order.id)
            .join(OrderItemPreparationTask, OrderItemPreparationTask.order_item_id == OrderItem.id)
            .filter(
                OrderItemPreparationTask.area == area,
                OrderItem.status.notin_([ItemStatus.CANCELLED, ItemStatus.DELIVERED]),
            )
        )
    return query.order_by(Order.created_at.asc()).distinct()


def menu_category_names(db: Session) -> dict[UUID, str]:
    return {c.id: c.name for c in db.query(MenuCategory).all()}
