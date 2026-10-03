from datetime import UTC, date, datetime
from uuid import UUID

from fastapi import APIRouter, Query

from app.core import audit as audit_actions
from app.core.deps import AdminUser, DbSession, StaffUser
from app.core.errors import ConflictError, NotFoundError
from app.models import Order, Shift
from app.models.enums import OrderStatus, ShiftStatus
from app.schemas.ops import ShiftOut
from app.schemas.reports import (
    ShiftReport,
)
from app.services import reports as report_service
from app.ws.hub import hub

router = APIRouter(prefix="/shifts", tags=["shifts"])

OPEN_ORDER_STATUSES = [
    OrderStatus.OPEN,
    OrderStatus.IN_PREPARATION,
    OrderStatus.READY,
    OrderStatus.DELIVERED,
]


@router.get("/current", response_model=ShiftOut | None)
def current_shift(db: DbSession, _: StaffUser) -> ShiftOut | None:
    shift = db.query(Shift).filter(Shift.status == "OPEN").order_by(Shift.opened_at.desc()).first()
    return ShiftOut.model_validate(shift) if shift else None


@router.post("/open", response_model=ShiftOut, status_code=201)
def open_shift(db: DbSession, admin: AdminUser) -> ShiftOut:
    existing = db.query(Shift).filter(Shift.status == "OPEN").first()
    if existing is not None:
        raise ConflictError("SHIFT_ALREADY_OPEN", "Ya hay un turno abierto.")
    shift = Shift(opened_at=datetime.now(UTC), opened_by=admin.id, status="OPEN")
    db.add(shift)
    db.commit()
    db.refresh(shift)
    hub.broadcast("shift.opened", {"shift_id": str(shift.id)}, {"admin", "waiters", "kitchen", "grill"})
    return ShiftOut.model_validate(shift)


@router.post("/{shift_id}/close", response_model=ShiftOut)
def close_shift(shift_id: UUID, db: DbSession, admin: AdminUser) -> ShiftOut:
    shift = db.query(Shift).filter(Shift.id == shift_id).with_for_update().one_or_none()
    if shift is None:
        raise NotFoundError("SHIFT_NOT_FOUND", "Turno no encontrado.")
    if shift.status == ShiftStatus.CLOSED:
        raise ConflictError("SHIFT_ALREADY_CLOSED", "El turno ya está cerrado.")

    open_orders = len(
        db.query(Order.id)
        .filter(Order.shift_id == shift.id, Order.status.in_(OPEN_ORDER_STATUSES))
        .with_for_update()
        .all()
    )
    if open_orders:
        raise ConflictError(
            "SHIFT_HAS_OPEN_ORDERS",
            "Hay pedidos sin finalizar. Cierre o pague los pedidos antes de cerrar el turno.",
            {"open_orders": int(open_orders)},
        )

    snapshot = report_service.build_shift_snapshot(db, shift)
    shift.snapshot = snapshot
    shift.closed_at = datetime.now(UTC)
    shift.closed_by = admin.id
    shift.status = ShiftStatus.CLOSED.value

    audit_actions.audit(
        db,
        user_id=admin.id,
        action=audit_actions.SHIFT_CLOSED,
        entity_type="shifts",
        entity_id=shift.id,
        after_data={"total_sales": snapshot["total_sales"], "net_result": snapshot["net_result"]},
    )
    db.commit()
    db.refresh(shift)
    hub.broadcast("shift.closed", {"shift_id": str(shift.id)}, {"admin", "waiters", "kitchen", "grill"})
    return ShiftOut.model_validate(shift)


@router.get("/history", response_model=list[ShiftOut])
def shift_history(
    db: DbSession,
    _: AdminUser,
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    waiter_id: UUID | None = Query(default=None),
) -> list[ShiftOut]:
    query = db.query(Shift).filter(Shift.status == ShiftStatus.CLOSED.value)
    if date_from:
        query = query.filter(Shift.opened_at >= datetime.combine(date_from, datetime.min.time(), tzinfo=UTC))
    if date_to:
        query = query.filter(Shift.opened_at <= datetime.combine(date_to, datetime.max.time(), tzinfo=UTC))
    shifts = query.order_by(Shift.opened_at.desc()).all()
    if waiter_id is not None:
        filtered = []
        for shift in shifts:
            has = db.query(Order.id).filter(Order.shift_id == shift.id, Order.created_by_waiter_id == waiter_id).first()
            if has is not None:
                filtered.append(shift)
        shifts = filtered
    return [ShiftOut.model_validate(s) for s in shifts]


@router.get("/{shift_id}/report", response_model=ShiftReport)
def shift_report(shift_id: UUID, db: DbSession, _: AdminUser) -> ShiftReport:
    shift = db.get(Shift, shift_id)
    if shift is None:
        raise NotFoundError("SHIFT_NOT_FOUND", "Turno no encontrado.")
    return report_service.build_shift_report(db, shift)
