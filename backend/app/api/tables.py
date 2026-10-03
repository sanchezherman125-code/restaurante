from uuid import UUID

from fastapi import APIRouter

from app.core.deps import AdminUser, DbSession, StaffUser
from app.core.errors import ConflictError, NotFoundError
from app.models import Order, RestaurantTable
from app.models.enums import OrderStatus
from app.schemas.menu import TableCreate, TableOut, TableUpdate
from app.ws.hub import hub

router = APIRouter(prefix="/tables", tags=["tables"])

OPEN_STATUSES = [
    OrderStatus.OPEN,
    OrderStatus.IN_PREPARATION,
    OrderStatus.READY,
    OrderStatus.DELIVERED,
]


def _with_status(db, tables: list[RestaurantTable]) -> list[TableOut]:
    if not tables:
        return []
    open_orders = (
        db.query(Order.table_id, Order.id).filter(Order.table_id.isnot(None), Order.status.in_(OPEN_STATUSES)).all()
    )
    order_by_table = {row.table_id: row.id for row in open_orders}
    out: list[TableOut] = []
    for table in tables:
        item = TableOut.model_validate(table)
        order_id = order_by_table.get(table.id)
        item.order_id = order_id
        item.status = "OPEN" if order_id else "FREE"
        out.append(item)
    return out


@router.get("", response_model=list[TableOut])
def list_tables(db: DbSession, _: StaffUser) -> list[TableOut]:
    tables = db.query(RestaurantTable).order_by(RestaurantTable.number.asc()).all()
    return _with_status(db, tables)


@router.post("", response_model=TableOut, status_code=201)
def create_table(payload: TableCreate, db: DbSession, _: AdminUser) -> TableOut:
    exists = db.query(RestaurantTable).filter(RestaurantTable.number == payload.number).first()
    if exists is not None:
        raise ConflictError("TABLE_NUMBER_TAKEN", "Ya existe una mesa con ese número.")
    table = RestaurantTable(name=payload.name, number=payload.number, is_active=payload.is_active)
    db.add(table)
    db.commit()
    db.refresh(table)
    hub.broadcast("tables.changed", {"table_id": str(table.id)}, {"admin", "waiters"})
    return _with_status(db, [table])[0]


@router.patch("/{table_id}", response_model=TableOut)
def update_table(table_id: UUID, payload: TableUpdate, db: DbSession, _: AdminUser) -> TableOut:
    table = db.get(RestaurantTable, table_id)
    if table is None:
        raise NotFoundError("TABLE_NOT_FOUND", "Mesa no encontrada.")
    data = payload.model_dump(exclude_unset=True)
    if "number" in data:
        conflict = (
            db.query(RestaurantTable)
            .filter(RestaurantTable.number == data["number"], RestaurantTable.id != table_id)
            .first()
        )
        if conflict is not None:
            raise ConflictError("TABLE_NUMBER_TAKEN", "Ya existe una mesa con ese número.")
    for key, value in data.items():
        setattr(table, key, value)
    db.commit()
    db.refresh(table)
    hub.broadcast("tables.changed", {"table_id": str(table.id)}, {"admin", "waiters"})
    return _with_status(db, [table])[0]
