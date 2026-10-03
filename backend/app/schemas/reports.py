from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel


class SalesReport(BaseModel):
    total_sales: Decimal = Decimal("0.00")
    total_expenses: Decimal = Decimal("0.00")
    net_result: Decimal = Decimal("0.00")
    orders_count: int = 0
    tables_served: int = 0
    persons_served: int = 0
    sales_by_waiter: dict[str, Decimal] = {}
    sales_by_payment_method: dict[str, Decimal] = {}


class ProductReportLine(BaseModel):
    menu_item_id: UUID | None
    name: str
    quantity: int
    revenue: Decimal


class ProductsReport(BaseModel):
    lines: list[ProductReportLine] = []
    total_items_sold: int = 0


class PreparationReportLine(BaseModel):
    area: str
    average_seconds: float | None = None
    items_measured: int = 0
    within_expected_percent: float | None = None


class PreparationReport(BaseModel):
    lines: list[PreparationReportLine] = []
    average_seconds: float | None = None


class ShiftReport(BaseModel):
    shift_id: UUID
    opened_at: datetime | None = None
    closed_at: datetime | None = None
    status: str
    sales: SalesReport
    products: ProductsReport
    preparation: PreparationReport
    expenses: list[dict] = []
    purchase_list: list[dict] = []


class HistoryFilters(BaseModel):
    date_from: date | None = None
    date_to: date | None = None
    shift_id: UUID | None = None
    waiter_id: UUID | None = None
