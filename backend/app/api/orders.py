from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Header, Query
from fastapi.responses import JSONResponse
from sqlalchemy.exc import IntegrityError

from app.core import audit as audit_actions
from app.core.deps import (
    CurrentUser,
    DbSession,
    StaffUser,
    WaiterUser,
    ensure_order_in_open_shift,
    ensure_origin_shift,
    get_open_shift,
)
from app.core.errors import ConflictError, ForbiddenError, NotFoundError, ValidationAppError
from app.core.idempotency import execute_idempotent
from app.models import Order, OrderItem, OrderItemPreparationTask, User
from app.models.enums import ItemStatus, OrderStatus, OrderType
from app.schemas.orders import (
    CommandCreate,
    CommandOut,
    ItemCancelRequest,
    ItemStatusRequest,
    ItemUpdate,
    OrderCancelRequest,
    OrderCreate,
    OrderItemOut,
    OrderOpenWithCommand,
    OrderOut,
    TaskStatusRequest,
)
from app.services import orders as order_service
from app.services import preparation as prep
from app.ws.hub import hub

router = APIRouter(prefix="/orders", tags=["orders"])

IdempotencyKeyHeader = Annotated[UUID | None, Header(alias="Idempotency-Key")]


def _serialize(order: Order) -> dict:
    return order_service.serialize_order(order)


def _mutation_response(user: User, order: Order) -> dict:
    if user.role in {"KITCHEN", "GRILL"}:
        area = prep.ROLE_AREA[user.role]
        return {
            "id": str(order.id), "status": order.status,
            "items": [OrderItemOut.model_validate(item).model_dump(mode="json")
                      for item in order.items if area in prep.all_item_areas(item)],
        }
    return OrderOut.model_validate(order).model_dump(mode="json")


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
    if user.role in prep.ROLE_AREA and prep.ROLE_AREA[user.role] in prep.authorized_areas(item):
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


def _lock_operation_shift(db, origin_shift_id: UUID | None):
    """Turno abierto, bloqueado, para una operación nueva (las respuestas idempotentes se devuelven antes).

    Una operación generada en un turno anterior (cola offline) se rechaza con 409 ``SHIFT_MISMATCH``.
    """
    shift = get_open_shift(db)
    ensure_order_in_open_shift(db, shift.id)
    ensure_origin_shift(origin_shift_id, shift.id)
    return shift


@router.post("")
def create_order(
    payload: OrderCreate,
    db: DbSession,
    user: WaiterUser,
    idem_key: IdempotencyKeyHeader = None,
    device_id: Annotated[str | None, Header(alias="X-Device-Id")] = None,
) -> JSONResponse:
    key = payload.client_operation_id or idem_key

    def operation() -> tuple[int, dict]:
        shift = _lock_operation_shift(db, payload.shift_id)
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


def _audit_command(db, user: User, order: Order, command, device_id: str | None) -> None:
    audit_actions.audit(
        db,
        user_id=user.id,
        action=audit_actions.COMMAND_CREATED,
        entity_type="commands",
        entity_id=command.id,
        after_data={"order_id": str(order.id), "sequence_number": command.sequence_number, "items": len(command.items)},
        device_id=device_id,
    )
    for item in command.items:
        audit_actions.audit(
            db,
            user_id=user.id,
            action=audit_actions.ITEM_ADDED,
            entity_type="order_items",
            entity_id=item.id,
            after_data={"name": item.menu_item_name_snapshot, "quantity": item.quantity, "area": item.preparation_area},
            device_id=device_id,
        )


@router.post("/open-with-command")
def open_table_with_command(
    payload: OrderOpenWithCommand,
    db: DbSession,
    user: WaiterUser,
    idem_key: IdempotencyKeyHeader = None,
    device_id: Annotated[str | None, Header(alias="X-Device-Id")] = None,
) -> JSONResponse:
    """Crea el pedido de una mesa y su primera comanda en UNA transacción.

    Si algo falla (producto agotado, mesa ya ocupada, error del servidor) no queda ningún pedido: nunca
    existe un pedido vacío ocupando la mesa por un fallo entre dos solicitudes. La clave de idempotencia
    se confirma junto con ambas filas, así que un reintento devuelve el mismo resultado sin duplicar nada.
    """
    key = payload.client_operation_id or idem_key

    def operation() -> tuple[int, dict]:
        shift = _lock_operation_shift(db, payload.shift_id)
        order = order_service.create_order(
            db,
            user,
            order_type=OrderType.DINE_IN,
            table_id=payload.table_id,
            persons_count=payload.persons_count,
            notes=payload.order_notes,
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
        command = order_service.create_command(
            db, user, order, items=[i.model_dump() for i in payload.items], notes=payload.notes
        )
        _audit_command(db, user, order, command, device_id)
        body = _serialize(order)  # "id" es el del pedido: la cola offline lo usa para encadenar comandas
        body["command"] = CommandOut.model_validate(command).model_dump(mode="json")
        return 201, body

    try:
        status, body = execute_idempotent(db, key, user.id, "OPEN_TABLE_WITH_COMMAND", operation)
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
    origin_shift_id: UUID | None = None,
) -> tuple[int, dict]:
    def operation() -> tuple[int, dict]:
        ensure_order_in_open_shift(db, order.shift_id)
        ensure_origin_shift(origin_shift_id, order.shift_id)
        order_service.ensure_order_modifiable(order)
        command = order_service.create_command(
            db,
            user,
            order,
            items=items,
            notes=notes,
            client_operation_id=key,
        )
        _audit_command(db, user, order, command, device_id)
        body = CommandOut.model_validate(command).model_dump(mode="json")
        body["order"] = _serialize(order)
        return 201, body

    return execute_idempotent(db, key, user.id, "CREATE_COMMAND", operation, scope=str(order.id))


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
    status, body = _create_command_impl(db, user, order, items, payload.notes, key, device_id, payload.shift_id)
    return JSONResponse(status_code=status, content=body)


@router.post("/{order_id}/cancel")
def cancel_empty_order(
    order_id: UUID,
    db: DbSession,
    user: WaiterUser,
    payload: OrderCancelRequest | None = None,
    idem_key: IdempotencyKeyHeader = None,
    device_id: Annotated[str | None, Header(alias="X-Device-Id")] = None,
) -> JSONResponse:
    """Anula un pedido sin productos activos ni pagos (mesa abierta sin pedir) y libera la mesa."""
    order = order_service.get_active_order(db, order_id)
    _authorize_order_read(user, order)

    def operation() -> tuple[int, dict]:
        shift, locked = order_service.lock_order_and_shift(db, order.id, order.shift_id)
        order_service.ensure_shift_open(shift)
        if locked.status == OrderStatus.CANCELLED:
            return 200, _serialize(locked)
        order_service.ensure_order_modifiable(locked)
        if locked.paid_amount > 0 or any(item.status != ItemStatus.CANCELLED for item in locked.items):
            raise ConflictError(
                "ORDER_NOT_EMPTY",
                "Solo se puede liberar una mesa sin productos ni pagos. Cancele los productos o cobre el pedido.",
            )
        before = locked.status
        locked.status = OrderStatus.CANCELLED
        locked.closed_at = order_service.utcnow()
        db.flush()
        audit_actions.audit(
            db, user_id=user.id, action=audit_actions.ORDER_CANCELLED,
            entity_type="orders", entity_id=locked.id,
            before_data={"status": before}, after_data={"status": locked.status, "reason": "empty_order_released"},
            device_id=device_id,
        )
        hub.after_commit(db, "order.updated", order_service.order_event_payload(locked), {"waiters", "admin"})
        hub.after_commit(db, "tables.changed", {"table_id": str(locked.table_id) if locked.table_id else None},
                         {"waiters", "admin"})
        return 200, _serialize(locked)

    key = (payload.client_operation_id if payload else None) or idem_key
    status, body = execute_idempotent(db, key, user.id, "CANCEL_EMPTY_ORDER", operation, scope=str(order_id))
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
    status, body = _create_command_impl(db, user, order, items, payload.notes, key, device_id, payload.shift_id)
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
    # Cocina/parrilla (áreas del plato), mesero dueño y admin deben ver al instante la cantidad o nota nueva.
    hub.after_commit(db, "order_item.updated", order_service.item_event_payload(item),
                     prep.item_channels(item) | {"waiters"})
    hub.after_commit(db, "order.updated", order_service.order_event_payload(order), {"waiters", "admin"})
    db.commit()
    return OrderOut.model_validate(order)


@router.post("/{order_id}/items/{item_id}/cancel")
def cancel_item(
    order_id: UUID,
    item_id: UUID,
    payload: ItemCancelRequest,
    db: DbSession,
    user: CurrentUser,
    idem_key: IdempotencyKeyHeader = None,
    device_id: Annotated[str | None, Header(alias="X-Device-Id")] = None,
) -> JSONResponse:
    order = order_service.get_active_order(db, order_id)

    def operation() -> tuple[int, dict]:
        shift, locked_order = order_service.lock_order_and_shift(db, order.id, order.shift_id)
        item = order_service.lock_order_item(db, locked_order.id, item_id)
        _authorize_cancellation(user, locked_order, item)
        order_service.ensure_order_cancellable(locked_order)
        order_service.ensure_shift_open(shift)
        before = {"status": item.status}
        previous_order_status = locked_order.status
        order_service.cancel_item(db, user, item, payload.reason)
        audit_actions.audit(
            db, user_id=user.id, action=audit_actions.ITEM_CANCELLED,
            entity_type="order_items", entity_id=item.id, before_data=before,
            after_data={"status": item.status, "reason": payload.reason,
                        "after_preparation_started": item.cancelled_after_preparation_started},
            device_id=device_id,
        )
        if locked_order.status == OrderStatus.CANCELLED:
            # Último producto cancelado: el pedido termina de forma explícita (sin pagos, total 0.00).
            audit_actions.audit(
                db, user_id=user.id, action=audit_actions.ORDER_CANCELLED,
                entity_type="orders", entity_id=locked_order.id,
                before_data={"status": previous_order_status}, after_data={"status": locked_order.status,
                                                                          "total": str(locked_order.total)},
                device_id=device_id,
            )
        return 200, _mutation_response(user, locked_order)

    status, body = execute_idempotent(
        db, payload.client_operation_id or idem_key, user.id, "CANCEL_ORDER_ITEM", operation, scope=str(item_id),
    )
    return JSONResponse(status_code=status, content=body)


def _locked_item_operation(db, order: Order, item_id: UUID):
    shift, locked_order = order_service.lock_order_and_shift(db, order.id, order.shift_id)
    order_service.ensure_shift_open(shift)
    item = order_service.lock_order_item(db, locked_order.id, item_id)
    return locked_order, item


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
    """Estado a nivel de plato. Para áreas, PREPARING/READY actúa sobre las tareas de su propia área."""
    order = order_service.get_active_order(db, order_id)
    item = db.get(OrderItem, item_id)
    if item is None or item.order_id != order.id:
        raise NotFoundError("ITEM_NOT_FOUND", "Producto no encontrado en este pedido.")
    if user.role == "WAITER":
        _authorize_order_read(user, order)
    _authorize_status_change(user, item, payload.status)

    key = payload.client_operation_id or idem_key

    def operation() -> tuple[int, dict]:
        locked_order, locked_item = _locked_item_operation(db, order, item_id)
        before = {"status": locked_item.status}
        if order_service.change_item_status(db, user, locked_item, payload.status):
            audit_actions.audit(
                db,
                user_id=user.id,
                action=audit_actions.ITEM_STATUS_CHANGED,
                entity_type="order_items",
                entity_id=locked_item.id,
                before_data=before,
                after_data={"status": locked_item.status, "requested": payload.status.value},
                device_id=device_id,
            )
        return 200, _mutation_response(user, locked_order)

    status, body = execute_idempotent(db, key, user.id, "UPDATE_ORDER_ITEM_STATUS", operation, scope=str(item.id))
    return JSONResponse(status_code=status, content=body)


@router.post("/{order_id}/items/{item_id}/tasks/{task_id}/status")
def change_task_status(
    order_id: UUID,
    item_id: UUID,
    task_id: UUID,
    payload: TaskStatusRequest,
    db: DbSession,
    user: CurrentUser,
    idem_key: IdempotencyKeyHeader = None,
    device_id: Annotated[str | None, Header(alias="X-Device-Id")] = None,
) -> JSONResponse:
    """Avanza una tarea de preparación. Cada área solo modifica las tareas de su área."""
    order = order_service.get_active_order(db, order_id)
    item = db.get(OrderItem, item_id)
    task = db.get(OrderItemPreparationTask, task_id)
    if item is None or item.order_id != order.id or task is None or task.order_item_id != item.id:
        raise NotFoundError("TASK_NOT_FOUND", "Tarea no encontrada en este producto.")
    _authorize_task_change(user, task)

    key = payload.client_operation_id or idem_key

    def operation() -> tuple[int, dict]:
        locked_order, locked_item = _locked_item_operation(db, order, item_id)
        prep.lock_item_tasks(db, locked_item.id)
        locked_task = next((t for t in locked_item.tasks if t.id == task_id), None)
        if locked_task is None:
            raise NotFoundError("TASK_NOT_FOUND", "Tarea no encontrada en este producto.")
        before = {"task_status": locked_task.status, "item_status": locked_item.status}
        changed = order_service.change_task_statuses(db, locked_item, [locked_task], payload.status)
        if changed:
            audit_actions.audit(
                db,
                user_id=user.id,
                action=audit_actions.TASK_STATUS_CHANGED,
                entity_type="order_item_preparation_tasks",
                entity_id=locked_task.id,
                before_data=before,
                after_data={"task_status": locked_task.status, "item_status": locked_item.status},
                device_id=device_id,
            )
        return 200, _mutation_response(user, locked_order)

    status, body = execute_idempotent(db, key, user.id, "UPDATE_PREPARATION_TASK", operation, scope=str(task_id))
    return JSONResponse(status_code=status, content=body)


def _authorize_task_change(user: User, task: OrderItemPreparationTask) -> None:
    if user.role == "ADMIN":
        return
    if prep.ROLE_AREA.get(user.role) == task.area:
        return
    raise ForbiddenError("TASK_STATUS_FORBIDDEN", f"Esta tarea pertenece al área {task.area}.")


def _authorize_status_change(user: User, item: OrderItem, new_status: ItemStatus) -> None:
    if user.role == "ADMIN":
        return
    if not item.requires_preparation:
        if user.role == "WAITER" and new_status == ItemStatus.DELIVERED:
            return
        raise ForbiddenError("ITEM_STATUS_FORBIDDEN", "Solo un mesero entrega productos directos.")
    areas = prep.authorized_areas(item)
    own_area = prep.ROLE_AREA.get(user.role)

    if new_status == ItemStatus.DELIVERED:
        if user.role == "WAITER" or own_area in areas:
            return
        raise ForbiddenError("ITEM_DELIVERY_FORBIDDEN", "Solo meseros o el área pueden marcar entrega.")
    if own_area in areas:
        return
    raise ForbiddenError(
        "ITEM_STATUS_FORBIDDEN",
        f"Este producto pertenece al área {', '.join(sorted(areas)) or item.preparation_area}.",
    )
