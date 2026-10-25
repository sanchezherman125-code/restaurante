from datetime import date
from typing import Literal
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


ReportScope = Literal["current", "all"]


def _report_scope(
    db,
    date_from: date | None,
    date_to: date | None,
    shift_id: UUID | None,
    scope: ReportScope | None,
    waiter_id: UUID | None,
) -> tuple[list[Order], list[UUID]]:
    """Pedidos y turnos de un reporte. Los gastos dependen de los turnos, nunca de que existan pedidos."""
    shifts = report_service.select_shifts(db, date_from=date_from, date_to=date_to, shift_id=shift_id, scope=scope)
    shift_ids = [s.id for s in shifts]
    return report_service.orders_of_shifts(db, shift_ids, waiter_id), shift_ids


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


@router.get("/current-shift", response_model=SalesReport)
def current_shift_sales(db: DbSession, _: AdminUser) -> SalesReport:
    orders, shift_ids = _report_scope(db, None, None, None, None, None)
    return _sales_report(db, orders, shift_ids)


@router.get("/sales", response_model=SalesReport)
def sales_report(
    db: DbSession,
    _: AdminUser,
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    shift_id: UUID | None = Query(default=None),
    waiter_id: UUID | None = Query(default=None),
    scope: ReportScope | None = Query(default=None),
) -> SalesReport:
    orders, shift_ids = _report_scope(db, date_from, date_to, shift_id, scope, waiter_id)
    return _sales_report(db, orders, shift_ids)


@router.get("/products", response_model=ProductsReport)
def products_report(
    db: DbSession,
    _: AdminUser,
    date_from: date | None = Query(default=None),
    date_to: date | None = Query(default=None),
    shift_id: UUID | None = Query(default=None),
    waiter_id: UUID | None = Query(default=None),
    scope: ReportScope | None = Query(default=None),
) -> ProductsReport:
    orders, _shift_ids = _report_scope(db, date_from, date_to, shift_id, scope, waiter_id)
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
    scope: ReportScope | None = Query(default=None),
) -> PreparationReport:
    orders, _shift_ids = _report_scope(db, date_from, date_to, shift_id, scope, None)
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
