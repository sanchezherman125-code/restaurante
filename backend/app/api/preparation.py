from datetime import UTC, datetime

from fastapi import APIRouter

from app.core.deps import DbSession, GrillUser, KitchenUser
from app.models import Order, OrderItem, OrderItemPreparationTask
from app.models.enums import ItemStatus, OrderStatus, PreparationArea, TaskStatus
from app.schemas.orders import BoardTaskOut, ItemGroupOut, OrderItemOut, SiblingTaskOut
from app.services import orders as order_service

router = APIRouter(prefix="/preparation", tags=["preparation"])

VISIBLE_TASK_STATUSES = [TaskStatus.PENDING.value, TaskStatus.PREPARING.value, TaskStatus.READY.value]
# El tablero se rige por el trabajo de preparación, no por el estado financiero del pedido:
# un pedido PAID con platos sin terminar debe seguir visible.
VISIBLE_ITEM_STATUSES = [ItemStatus.PENDING, ItemStatus.PREPARING, ItemStatus.READY]


def _area_summary(tasks: list[OrderItemPreparationTask]) -> str:
    live = [t for t in tasks if t.status != TaskStatus.CANCELLED]
    if not live:
        return "EMPTY"
    statuses = {t.status for t in live}
    if statuses <= {TaskStatus.READY.value}:
        return "READY"
    if statuses - {TaskStatus.PENDING.value}:
        return "PREPARING"
    return "PENDING"


def _board_task(task: OrderItemPreparationTask, item: OrderItem) -> BoardTaskOut:
    return BoardTaskOut(
        id=task.id,
        order_item_id=item.id,
        order_id=item.order_id,
        command_id=item.command_id,
        name=task.name,
        item_name=item.menu_item_name_snapshot,
        quantity=item.quantity,
        notes=item.notes,
        replacement_description=item.replacement_description,
        area=PreparationArea(task.area),
        status=TaskStatus(task.status),
        expected_minutes=task.expected_minutes,
        started_at=task.started_at,
        ready_at=task.ready_at,
        created_at=item.created_at,
        item_status=ItemStatus(item.status),
        other_tasks=[
            SiblingTaskOut(id=o.id, name=o.name, area=PreparationArea(o.area), status=TaskStatus(o.status))
            for o in item.tasks
            if o.id != task.id and o.status != TaskStatus.CANCELLED
        ],
    )


def _build_view(db, area: PreparationArea) -> list[ItemGroupOut]:
    now = datetime.now(UTC)
    orders = (
        db.query(Order)
        .join(OrderItem, OrderItem.order_id == Order.id)
        .join(OrderItemPreparationTask, OrderItemPreparationTask.order_item_id == OrderItem.id)
        .filter(
            Order.status != OrderStatus.CLOSED,
            OrderItem.requires_preparation.is_(True),
            OrderItem.status.in_(VISIBLE_ITEM_STATUSES),
            OrderItemPreparationTask.area == area.value,
            OrderItemPreparationTask.status.in_(VISIBLE_TASK_STATUSES),
        )
        .order_by(Order.created_at.asc())
        .distinct()
        .all()
    )

    result: list[ItemGroupOut] = []
    for order in orders:
        for command in sorted(order.commands, key=lambda c: c.sequence_number):
            dishes = [
                i for i in command.items
                if i.requires_preparation and i.status in VISIBLE_ITEM_STATUSES
                and any(t.area == area.value and t.status in VISIBLE_TASK_STATUSES for t in i.tasks)
            ]
            if not dishes:
                continue
            board_tasks = [
                _board_task(t, i)
                for i in dishes
                for t in i.tasks
                if t.area == area.value and t.status in VISIBLE_TASK_STATUSES
            ]
            other_areas: dict[str, str] = {}
            for other in (PreparationArea.KITCHEN, PreparationArea.GRILL):
                if other == area:
                    continue
                other_tasks = [
                    t
                    for i in command.items
                    if i.status != ItemStatus.CANCELLED
                    for t in i.tasks
                    if t.area == other.value
                ]
                other_areas[other.value] = _area_summary(other_tasks)

            created = command.created_at
            if created.tzinfo is None:
                created = created.replace(tzinfo=UTC)
            result.append(
                ItemGroupOut(
                    order_id=order.id,
                    command_id=command.id,
                    sequence_number=command.sequence_number,
                    table_name=order.table_name,
                    table_number=order.table_number,
                    order_type=order.order_type,
                    persons_count=order.persons_count,
                    notes=order.notes,
                    command_notes=command.notes,
                    created_at=command.created_at,
                    waiter_name=order.created_by_waiter_name,
                    tasks=board_tasks,
                    items=[OrderItemOut.model_validate(i) for i in dishes],
                    other_areas=other_areas,
                    order_general_status=order_service.compute_status(order),
                    elapsed_seconds=max(0, int((now - created).total_seconds())),
                )
            )
    result.sort(key=lambda g: (g.created_at, g.sequence_number))
    return result


@router.get("/kitchen", response_model=list[ItemGroupOut])
def kitchen_view(db: DbSession, _: KitchenUser) -> list[ItemGroupOut]:
    return _build_view(db, PreparationArea.KITCHEN)


@router.get("/grill", response_model=list[ItemGroupOut])
def grill_view(db: DbSession, _: GrillUser) -> list[ItemGroupOut]:
    return _build_view(db, PreparationArea.GRILL)
