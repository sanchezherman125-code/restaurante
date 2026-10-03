from uuid import UUID

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from sqlalchemy.orm import Session

from app.core import audit as audit_actions
from app.core.deps import AdminUser, CurrentUser, DbSession, OpenShift, StaffUser, ensure_order_in_open_shift
from app.core.errors import ForbiddenError, NotFoundError
from app.core.idempotency import execute_idempotent
from app.models import Expense, PurchaseListItem, User
from app.schemas.ops import (
    ExpenseCreate,
    ExpenseOut,
    PurchaseItemCreate,
    PurchaseItemOut,
)
from app.ws.hub import hub

expenses_router = APIRouter(prefix="/expenses", tags=["expenses"])
purchase_router = APIRouter(prefix="/purchase-list", tags=["purchase-list"])


def _expense_out(db: Session, expense: Expense) -> ExpenseOut:
    out = ExpenseOut.model_validate(expense)
    creator = db.get(User, expense.created_by_user_id)
    out.created_by_name = creator.display_name if creator else None
    return out


@expenses_router.get("/current-shift", response_model=list[ExpenseOut])
def current_shift_expenses(db: DbSession, shift: OpenShift, user: StaffUser) -> list[ExpenseOut]:
    query = db.query(Expense).filter(Expense.shift_id == shift.id)
    if user.role != "ADMIN":
        query = query.filter(Expense.created_by_user_id == user.id)
    rows = query.order_by(Expense.created_at.desc()).all()
    return [_expense_out(db, e) for e in rows]


@expenses_router.get("", response_model=list[ExpenseOut])
def history_expenses(
    db: DbSession,
    _: AdminUser,
    shift_id: UUID | None = Query(default=None),
) -> list[ExpenseOut]:
    query = db.query(Expense).order_by(Expense.created_at.desc())
    if shift_id is not None:
        query = query.filter(Expense.shift_id == shift_id)
    return [_expense_out(db, e) for e in query.all()]


@expenses_router.post("", response_model=ExpenseOut, status_code=201)
def create_expense(payload: ExpenseCreate, db: DbSession, user: StaffUser, shift: OpenShift) -> JSONResponse:
    def operation():
        ensure_order_in_open_shift(db, shift.id)
        expense = Expense(
            shift_id=shift.id,
            created_by_user_id=user.id,
            amount=payload.amount,
            description=payload.description,
            receipt_url=payload.receipt_url,
        )
        db.add(expense)
        db.flush()
        audit_actions.audit(
            db,
            user_id=user.id,
            action=audit_actions.EXPENSE_CREATED,
            entity_type="expenses",
            entity_id=expense.id,
            after_data={"amount": str(payload.amount), "description": payload.description},
        )
        return 201, _expense_out(db, expense).model_dump(mode="json")

    status, body = execute_idempotent(db, payload.client_operation_id, user.id, "REGISTER_EXPENSE", operation)
    return JSONResponse(status_code=status, content=body)


@expenses_router.get("/{expense_id}", response_model=ExpenseOut)
def get_expense(expense_id: UUID, db: DbSession, user: CurrentUser) -> ExpenseOut:
    expense = db.get(Expense, expense_id)
    if expense is None:
        raise NotFoundError("EXPENSE_NOT_FOUND", "Gasto no encontrado.")
    if user.role != "ADMIN" and expense.created_by_user_id != user.id:
        raise ForbiddenError("EXPENSE_ACCESS_FORBIDDEN", "No tiene permiso para ver este gasto.")
    return _expense_out(db, expense)


@purchase_router.get("/current", response_model=list[PurchaseItemOut])
def current_purchase_list(db: DbSession, shift: OpenShift, _: StaffUser) -> list[PurchaseItemOut]:
    rows = (
        db.query(PurchaseListItem)
        .filter(PurchaseListItem.shift_id == shift.id)
        .order_by(PurchaseListItem.created_at.asc())
        .all()
    )
    return [PurchaseItemOut.model_validate(r) for r in rows]


@purchase_router.post("", response_model=PurchaseItemOut, status_code=201)
def add_purchase_item(payload: PurchaseItemCreate, db: DbSession, user: StaffUser, shift: OpenShift) -> PurchaseItemOut:
    if user.role not in ("KITCHEN", "GRILL", "ADMIN"):
        raise ForbiddenError("PURCHASE_FORBIDDEN", "Solo cocina, parrilla o administrador.")
    ensure_order_in_open_shift(db, shift.id)
    item = PurchaseListItem(
        shift_id=shift.id,
        area=payload.area.value,
        description=payload.description,
        quantity_text=payload.quantity_text,
        created_by_user_id=user.id,
    )
    db.add(item)
    db.commit()
    db.refresh(item)
    hub.broadcast("purchase_list.changed", {"id": str(item.id)}, {"admin"})
    return PurchaseItemOut.model_validate(item)


@purchase_router.delete("/{item_id}", status_code=204)
def delete_purchase_item(item_id: UUID, db: DbSession, user: StaffUser) -> None:
    if user.role not in ("KITCHEN", "GRILL", "ADMIN"):
        raise ForbiddenError("PURCHASE_FORBIDDEN", "Solo cocina, parrilla o administrador.")
    item = db.get(PurchaseListItem, item_id)
    if item is None:
        raise NotFoundError("PURCHASE_ITEM_NOT_FOUND", "Elemento no encontrado.")
    ensure_order_in_open_shift(db, item.shift_id)
    db.delete(item)
    db.commit()
