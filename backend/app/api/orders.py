from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, Query
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError

from app.core import audit as audit_actions
from app.core.deps import (
    CurrentUser,
    DbSession,
    OpenShift,
    StaffUser,
    WaiterUser,
    ensure_order_in_open_shift,
)
from app.core.errors import ConflictError, ForbiddenError, NotFoundError, ValidationAppError
from app.core.idempotency import execute_idempotent
from app.models import Order, OrderItem, User
from app.models.enums import ItemStatus, PreparationArea
from app.schemas.orders import (
    CommandCreate,
    CommandOut,
    ItemCancelRequest,
    ItemStatusRequest,
    ItemUpdate,
    OrderCreate,
    OrderOut,
)
from app.services import orders as order_service

router = APIRouter(prefix="/orders", tags=["orders"])

IdempotencyKeyHeader = Annotated[UUID | None, Header(alias="Idempotency-Key")]


def _serialize(order: Order) -> dict:
    return order_service.serialize_order(order)


def _authorize_order_read(user: User, order: Order) -> None:
    if user.role == "ADMIN":
        return
    if user.role == "WAITER" and order.created_by_waiter_id == user.id:
        return
    raise ForbiddenError("ORDER_ACCESS_FORBIDDEN", "No tiene permiso para ver este pedido.")


def _authorize_cancellation(user: User, order: Order, item: OrderItem) -> None:
    if user.role == "ADMIN":
        return
    if user.role == "WAITER" and order.created_by_waiter_id == user.id:
        return
    if user.role == "KITCHEN" and item.preparation_area == PreparationArea.KITCHEN:
        return
    if user.role == "GRILL" and item.preparation_area == PreparationArea.GRILL:
        return
    raise ForbiddenError("ITEM_CANCEL_FORBIDDEN", "No tiene permiso para cancelar este producto.")


@router.get("/active")
def list_active(
    db: DbSession,
    user: CurrentUser,
    area: Annotated[str | None, Query(pattern="^(KITCHEN|GRILL|WAITER)$")] = None,
) -> list[dict]:
    if user.role in ("KITCHEN", "GRILL"):
        raise ForbiddenError("ORDER_LIST_FORBIDDEN", "Use el tablero de preparación asignado a su área.")
    if user.role == "WAITER" and area is not None:
        raise ForbiddenError("ORDER_AREA_FORBIDDEN", "El mesero no puede consultar pedidos por área de preparación.")
    query = order_service.active_orders_query(db, area)
    if user.role == "WAITER" and area is None:
        query = query.filter(Order.created_by_waiter_id == user.id)
    orders = query.all()
    return [_serialize(o) for o in orders]


@router.post("")
def create_order(
    payload: OrderCreate,
    db: DbSession,
    user: WaiterUser,
    shift: OpenShift,
    idem_key: IdempotencyKeyHeader = None,
    device_id: Annotated[str | None, Header(alias="X-Device-Id")] = None,
) -> JSONResponse:
    key = payload.client_operation_id or idem_key

    def operation() -> tuple[int, dict]:
        ensure_order_in_open_shift(db, shift.id)
        order = order_service.create_order(
            db,
            user,
            order_type=payload.order_type,
            table_id=payload.table_id,
            persons_count=payload.persons_count,
            notes=payload.notes,
            shift_id=shift.id,
        )
        audit_actions.audit(
            db,
            user_id=user.id,
            action=audit_actions.ORDER_CREATED,
            entity_type="orders",
            entity_id=order.id,
            after_data={"order_type": order.order_type, "table_id": str(order.table_id or "")},
            device_id=device_id,
        )
        body = _serialize(order)
        return 201, body

    try:
        status, body = execute_idempotent(db, key, user.id, "CREATE_ORDER", operation)
    except IntegrityError as exc:
        raise ConflictError("TABLE_ALREADY_OPEN", "La mesa ya tiene un pedido abierto.") from exc
    return JSONResponse(status_code=status, content=body)


@router.get("/{order_id}", response_model=OrderOut)
def get_order(order_id: UUID, db: DbSession, _: StaffUser) -> OrderOut:
    order = order_service.get_active_order(db, order_id)
    _authorize_order_read(_, order)
    return OrderOut.model_validate(order)


def _create_command_impl(
    db,
    user: User,
    order: Order,
    items: list[dict],
    notes: str | None,
    key: UUID | None,
    device_id: str | None,
) -> tuple[int, dict]:
    def operation() -> tuple[int, dict]:
        ensure_order_in_open_shift(db, order.shift_id)
        order_service.ensure_order_modifiable(order)
        command = order_service.create_command(
            db,
            user,
            order,
            items=items,
            notes=notes,
            client_operation_id=key,
        )
        audit_actions.audit(
            db,
            user_id=user.id,
            action=audit_actions.COMMAND_CREATED,
            entity_type="commands",
            entity_id=command.id,
            after_data={
                "order_id": str(order.id),
                "sequence_number": command.sequence_number,
                "items": len(command.items),
            },
            device_id=device_id,
        )
        for item in command.items:
            audit_actions.audit(
                db,
                user_id=user.id,
                action=audit_actions.ITEM_ADDED,
                entity_type="order_items",
                entity_id=item.id,
                after_data={
                    "name": item.menu_item_name_snapshot,
                    "quantity": item.quantity,
                    "area": item.preparation_area,
                },
                device_id=device_id,
            )
        body = CommandOut.model_validate(command).model_dump(mode="json")
        body["order"] = _serialize(order)
        return 201, body

    return execute_idempotent(db, key, user.id, "CREATE_COMMAND", operation)


@router.post("/{order_id}/commands")
def create_command(
    order_id: UUID,
    payload: CommandCreate,
    db: DbSession,
    user: WaiterUser,
    idem_key: IdempotencyKeyHeader = None,
    device_id: Annotated[str | None, Header(alias="X-Device-Id")] = None,
) -> JSONResponse:
    order = order_service.get_active_order(db, order_id)
    _authorize_order_read(user, order)
    key = payload.client_operation_id or idem_key
    items = [i.model_dump() for i in payload.items]
    status, body = _create_command_impl(db, user, order, items, payload.notes, key, device_id)
    return JSONResponse(status_code=status, content=body)


@router.post("/{order_id}/items")
def add_items(
    order_id: UUID,
    payload: CommandCreate,
    db: DbSession,
    user: WaiterUser,
    idem_key: IdempotencyKeyHeader = None,
    device_id: Annotated[str | None, Header(alias="X-Device-Id")] = None,
) -> JSONResponse:
    """Agrega productos nuevos a un pedido existente creando una comanda nueva."""
    order = order_service.get_active_order(db, order_id)
    _authorize_order_read(user, order)
    ensure_order_in_open_shift(db, order.shift_id)
    key = payload.client_operation_id or idem_key
    items = [i.model_dump() for i in payload.items]
    status, body = _create_command_impl(db, user, order, items, payload.notes, key, device_id)
    return JSONResponse(status_code=status, content=body)


@router.patch("/{order_id}/items/{item_id}", response_model=OrderOut)
def update_item(
    order_id: UUID,
    item_id: UUID,
    payload: ItemUpdate,
    db: DbSession,
    user: WaiterUser,
) -> OrderOut:
    order = order_service.get_active_order(db, order_id)
    _authorize_order_read(user, order)
    ensure_order_in_open_shift(db, order.shift_id)
    order_service.ensure_order_modifiable(order)
    item = db.get(OrderItem, item_id)
    if item is None or item.order_id != order.id:
        raise NotFoundError("ITEM_NOT_FOUND", "Producto no encontrado en este pedido.")
    if item.status not in (ItemStatus.PENDING,):
        raise ValidationAppError(
            "ITEM_NOT_EDITABLE",
            "Solo puede modificarse un producto que aún no comenzó a prepararse.",
        )
    data = payload.model_dump(exclude_unset=True)
    if "quantity" in data and data["quantity"] is not None:
        item.quantity = data["quantity"]
    if "notes" in data:
        item.notes = data["notes"]
    if "replacement_description" in data:
        item.replacement_description = data["replacement_description"]
    order_service.recompute_totals(order)
    order_service.apply_status(order)
    db.commit()
    return OrderOut.model_validate(order)


@router.post("/{order_id}/items/{item_id}/cancel", response_model=OrderOut)
def cancel_item(
    order_id: UUID,
    item_id: UUID,
    payload: ItemCancelRequest,
    db: DbSession,
    user: CurrentUser,
    device_id: Annotated[str | None, Header(alias="X-Device-Id")] = None,
) -> OrderOut:
    order = order_service.get_active_order(db, order_id)
    item = db.get(OrderItem, item_id)
    if item is None or item.order_id != order.id:
        raise NotFoundError("ITEM_NOT_FOUND", "Producto no encontrado en este pedido.")
    _authorize_cancellation(user, order, item)
    ensure_order_in_open_shift(db, order.shift_id)
    before = {"status": item.status}
    order_service.cancel_item(db, user, item, payload.reason)
    audit_actions.audit(
        db,
        user_id=user.id,
        action=audit_actions.ITEM_CANCELLED,
        entity_type="order_items",
        entity_id=item.id,
        before_data=before,
        after_data={
            "status": item.status,
            "reason": payload.reason,
            "after_preparation_started": item.cancelled_after_preparation_started,
        },
        device_id=device_id,
    )
    db.commit()
    return OrderOut.model_validate(order)


@router.post("/{order_id}/items/{item_id}/status")
def change_status(
    order_id: UUID,
    item_id: UUID,
    payload: ItemStatusRequest,
    db: DbSession,
    user: CurrentUser,
    idem_key: IdempotencyKeyHeader = None,
    device_id: Annotated[str | None, Header(alias="X-Device-Id")] = None,
) -> JSONResponse:
    order = order_service.get_active_order(db, order_id)
    item = db.get(OrderItem, item_id)
    if item is None or item.order_id != order.id:
        raise NotFoundError("ITEM_NOT_FOUND", "Producto no encontrado en este pedido.")

    key = payload.client_operation_id or idem_key

    def operation() -> tuple[int, dict]:
        ensure_order_in_open_shift(db, order.shift_id)
        _authorize_status_change(user, item, payload.status)
        before = {"status": item.status}
        order_service.change_item_status(db, user, item, payload.status)
        audit_actions.audit(
            db,
            user_id=user.id,
            action=audit_actions.ITEM_STATUS_CHANGED,
            entity_type="order_items",
            entity_id=item.id,
            before_data=before,
            after_data={"status": item.status},
            device_id=device_id,
        )
        return 200, OrderOut.model_validate(order).model_dump(mode="json")

    status, body = execute_idempotent(db, key, user.id, "UPDATE_ORDER_ITEM_STATUS", operation)
    return JSONResponse(status_code=status, content=body)


def _authorize_status_change(user: User, item: OrderItem, new_status: ItemStatus) -> None:
    if user.role == "ADMIN":
        return
    if not item.requires_preparation:
        if user.role == "WAITER" and new_status == ItemStatus.DELIVERED:
            return
        raise ForbiddenError("ITEM_STATUS_FORBIDDEN", "Solo un mesero entrega productos directos.")
    area_role = {
        PreparationArea.KITCHEN: "KITCHEN",
        PreparationArea.GRILL: "GRILL",
    }[PreparationArea(item.preparation_area)]

    if new_status == ItemStatus.DELIVERED:
        if user.role in (area_role, "WAITER"):
            return
        raise ForbiddenError("ITEM_DELIVERY_FORBIDDEN", "Solo meseros o el área pueden marcar entrega.")
    if user.role == area_role:
        return
    raise ForbiddenError(
        "ITEM_STATUS_FORBIDDEN",
        f"Este producto pertenece al área {item.preparation_area}.",
    )
