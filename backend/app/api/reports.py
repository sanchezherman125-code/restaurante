from datetime import UTC, date, datetime
from uuid import UUID

from fastapi import APIRouter, Query

from app.core.deps import AdminUser, DbSession
from app.core.errors import NotFoundError
from app.models import Order, Shift
from app.schemas.reports import (
    PreparationReport,
    PreparationReportLine,
    ProductReportLine,
    ProductsReport,
    SalesReport,
    ShiftReport,
)
from app.services import reports as report_service

router = APIRouter(prefix="/reports", tags=["reports"])


def _shifts_in_range(db, date_from: date | None, date_to: date | None) -> list[Shift]:
    query = db.query(Shift)
    if date_from:
        query = query.filter(Shift.opened_at >= datetime.combine(date_from, datetime.min.time(), tzinfo=UTC))
    if date_to:
        query = query.filter(Shift.opened_at <= datetime.combine(date_to, datetime.max.time(), tzinfo=UTC))
    return query.order_by(Shift.opened_at.asc()).all()


def _collect_orders(
    db,
    date_from: date | None,
    date_to: date | None,
    shift_id: UUID | None,
    waiter_id: UUID | None,
) -> list[Order]:
    if shift_id is not None:
        shifts = [s for s in [db.get(Shift, shift_id)] if s is not None]
    elif date_from or date_to:
        shifts = _shifts_in_range(db, date_from, date_to)
    else:
        current = db.query(Shift).filter(Shift.status == "OPEN").order_by(Shift.opened_at.desc()).first()
        if current is None:
            current = db.query(Shift).order_by(Shift.opened_at.desc()).first()
        shifts = [current] if current else []

    if not shifts:
        return []
    shift_ids = [s.id for s in shifts]
    query = db.query(Order).filter(Order.shift_id.in_(shift_ids))
    if waiter_id is not None:
        query = query.filter(Order.created_by_waiter_id == waiter_id)
    return query.order_by(Order.created_at.asc()).all()


def _sales_report(db, orders: list[Order], shift_ids: list[UUID]) -> SalesReport:
    sales = report_service.sales_metrics(db, orders)
    total_expenses = report_service.total_expenses_of(db, shift_ids)
    total_sales = sales["total_sales"]
    return SalesReport(
        total_sales=total_sales,
        total_expenses=total_expenses,
        net_result=total_sales - total_expenses,
        orders_count=sales["orders_count"],
        tables_served=sales["tables_served"],
        persons_served=sales["persons_served"],
        sales_by_waiter=sales["sales_by_waiter"],
        sales_by_payment_method=sales["sales_by_payment_method"],
    )


def _shift_ids(orders: list[Order]) -> list[UUID]:
    return sorted({o.shift_id for o in orders}, key=str)


@router.get("/current-shift", response_model=SalesReport)
def current_shift_sales(db: DbSession, _: AdminUser) -> SalesReport:
    orders = _collect_orders(db, None, None, None, None)
    return _sales_report(db, orders, _shift_ids(orders))


@router.get("/sales", response_model=SalesReport)
def sales_report(
    db: DbSession,
    _: AdminUser,
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    shift_id: UUID | None = Query(default=None),
    waiter_id: UUID | None = Query(default=None),
) -> SalesReport:
    orders = _collect_orders(db, date_from, date_to, shift_id, waiter_id)
    return _sales_report(db, orders, _shift_ids(orders))


@router.get("/products", response_model=ProductsReport)
def products_report(
    db: DbSession,
    _: AdminUser,
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    shift_id: UUID | None = Query(default=None),
    waiter_id: UUID | None = Query(default=None),
) -> ProductsReport:
    orders = _collect_orders(db, date_from, date_to, shift_id, waiter_id)
    data = report_service.products_metrics(orders)
    return ProductsReport(
        lines=[ProductReportLine(**line) for line in data["lines"]],
        total_items_sold=data["total_items_sold"],
    )


@router.get("/preparation", response_model=PreparationReport)
def preparation_report(
    db: DbSession,
    _: AdminUser,
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    shift_id: UUID | None = Query(default=None),
) -> PreparationReport:
    orders = _collect_orders(db, date_from, date_to, shift_id, None)
    prep = report_service.preparation_metrics(db, orders)
    lines = [
        PreparationReportLine(
            area=area,
            average_seconds=data["average_seconds"],
            items_measured=data["items_measured"],
            within_expected_percent=prep["within_expected_percent"],
        )
        for area, data in prep["by_area"].items()
    ]
    return PreparationReport(lines=lines, average_seconds=prep["average_seconds"])


@router.get("/shifts/{shift_id}", response_model=ShiftReport)
def shift_report(db: DbSession, shift_id: UUID, _: AdminUser) -> ShiftReport:
    shift = db.get(Shift, shift_id)
    if shift is None:
        raise NotFoundError("SHIFT_NOT_FOUND", "Turno no encontrado.")
    return report_service.build_shift_report(db, shift)
