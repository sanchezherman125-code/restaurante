from datetime import UTC, datetime

from fastapi import APIRouter

from app.core.deps import DbSession, GrillUser, KitchenUser
from app.models import Order, OrderItem
from app.models.enums import ItemStatus, OrderStatus, PreparationArea
from app.schemas.orders import ItemGroupOut, OrderItemOut
from app.services import orders as order_service

router = APIRouter(prefix="/preparation", tags=["preparation"])

VISIBLE_STATUSES = [ItemStatus.PENDING, ItemStatus.PREPARING, ItemStatus.READY]
OPEN_STATUSES = [
    OrderStatus.OPEN,
    OrderStatus.IN_PREPARATION,
    OrderStatus.READY,
    OrderStatus.DELIVERED,
]


def _area_summary(items: list[OrderItem]) -> str:
    active = [i for i in items if i.status != ItemStatus.CANCELLED]
    if not active:
        return "EMPTY"
    statuses = {i.status for i in active}
    if statuses <= {ItemStatus.READY, ItemStatus.DELIVERED}:
        return "READY"
    if ItemStatus.PREPARING in statuses:
        return "PREPARING"
    return "PENDING"


def _build_view(db, area: PreparationArea) -> list[ItemGroupOut]:
    now = datetime.now(UTC)
    orders = (
        db.query(Order)
        .join(OrderItem, OrderItem.order_id == Order.id)
        .filter(
            Order.status.in_(OPEN_STATUSES),
            OrderItem.requires_preparation.is_(True),
            OrderItem.preparation_area == area.value,
            OrderItem.status.in_(VISIBLE_STATUSES),
        )
        .order_by(Order.created_at.asc())
        .distinct()
        .all()
    )

    result: list[ItemGroupOut] = []
    for order in orders:
        for command in sorted(order.commands, key=lambda c: c.sequence_number):
            area_items = [
                i
                for i in command.items
                if i.requires_preparation and i.preparation_area == area.value and i.status in VISIBLE_STATUSES
            ]
            if not area_items:
                continue
            other_areas: dict[str, str] = {}
            for other in (PreparationArea.KITCHEN, PreparationArea.GRILL):
                if other == area:
                    continue
                other_items = [
                    i for i in command.items if i.requires_preparation and i.preparation_area == other.value
                ]
                other_areas[other.value] = _area_summary(other_items)

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
                    items=[OrderItemOut.model_validate(i) for i in area_items],
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
