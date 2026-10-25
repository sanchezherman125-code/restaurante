from uuid import UUID

from fastapi import APIRouter

from app.core.deps import AdminUser, DbSession, StaffUser
from app.core.errors import ConflictError
from app.models import Order, RestaurantTable
from app.schemas.menu import TableCreate, TableOut, TableUpdate
from app.services import orders as order_service
from app.ws.hub import hub

router = APIRouter(prefix="/tables", tags=["tables"])

def _with_status(db, tables: list[RestaurantTable]) -> list[TableOut]:
    if not tables:
        return []
    open_orders = (
        db.query(Order.table_id, Order.id).filter(Order.table_id.isnot(None), Order.occupies_table.is_(True)).all()
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
    # El bloqueo coincide con el de la apertura de pedidos: nunca se desactiva una mesa a mitad de una apertura.
    table = order_service.lock_table(db, table_id)
    data = payload.model_dump(exclude_unset=True)
    if data.get("is_active") is False and table.is_active:
        order_id = order_service.occupying_order_id(db, table.id)
        if order_id is not None:
            raise ConflictError(
                "TABLE_OCCUPIED",
                f"{table.name} tiene un pedido activo. Termine de atenderlo antes de desactivarla.",
                {"order_id": str(order_id)},
            )
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
