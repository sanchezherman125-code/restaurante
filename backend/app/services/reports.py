from datetime import UTC, datetime
from decimal import Decimal
from uuid import UUID

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.models import (
    Expense,
    Order,
    Payment,
    PurchaseListItem,
    Shift,
    User,
)
from app.models.enums import ItemStatus


def _utc(dt: datetime | None) -> datetime | None:
    if dt is None:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def preparation_metrics(db: Session, orders: list[Order]) -> dict:
    items = [i for order in orders for i in order.items if i.status != ItemStatus.CANCELLED]
    measured = [i for i in items if i.requires_preparation and i.preparation_started_at and i.ready_at]
    durations = []
    by_area: dict[str, list[int]] = {}
    by_item: dict[str, list[int]] = {}
    within = 0
    expected_count = 0

    for item in measured:
        start = _utc(item.preparation_started_at)
        end = _utc(item.ready_at)
        seconds = max(0, int((end - start).total_seconds()))
        durations.append(seconds)
        by_area.setdefault(item.preparation_area, []).append(seconds)
        by_item.setdefault(item.menu_item_name_snapshot, []).append(seconds)
        if item.expected_prep_minutes_snapshot:
            expected_count += 1
            if seconds <= item.expected_prep_minutes_snapshot * 60:
                within += 1

    def avg(values: list[int]) -> float | None:
        return round(sum(values) / len(values), 1) if values else None

    return {
        "average_seconds": avg(durations),
        "items_measured": len(durations),
        "by_area": {k: {"average_seconds": avg(v), "items_measured": len(v)} for k, v in by_area.items()},
        "by_item": {k: {"average_seconds": avg(v), "items_measured": len(v)} for k, v in by_item.items()},
        "within_expected_percent": round(within * 100 / expected_count, 1) if expected_count else None,
    }


def sales_metrics(db: Session, orders: list[Order]) -> dict:
    order_ids = [o.id for o in orders]
    payments: list[Payment] = []
    if order_ids:
        payments = db.query(Payment).filter(Payment.order_id.in_(order_ids)).all()

    total_sales = sum((p.amount for p in payments), Decimal("0.00"))
    waiters = {u.id: u.display_name for u in db.query(User).all()}
    orders_by_id = {o.id: o for o in orders}

    sales_by_waiter: dict[str, Decimal] = {}
    sales_by_method: dict[str, Decimal] = {}
    for payment in payments:
        order = orders_by_id.get(payment.order_id)
        waiter_name = "—"
        if order is not None:
            waiter_name = waiters.get(order.created_by_waiter_id, "—")
        sales_by_waiter[waiter_name] = sales_by_waiter.get(waiter_name, Decimal("0.00")) + payment.amount
        sales_by_method[payment.method] = sales_by_method.get(payment.method, Decimal("0.00")) + payment.amount

    return {
        "total_sales": total_sales,
        "orders_count": len(orders),
        "tables_served": len({o.table_id for o in orders if o.table_id}),
        "persons_served": sum(o.persons_count or 0 for o in orders),
        "sales_by_waiter": sales_by_waiter,
        "sales_by_payment_method": sales_by_method,
    }


def products_metrics(orders: list[Order]) -> dict:
    lines: dict[tuple[UUID | None, str], dict] = {}
    total = 0
    for order in orders:
        for item in order.items:
            if item.status == ItemStatus.CANCELLED:
                continue
            key = (item.menu_item_id, item.menu_item_name_snapshot)
            entry = lines.setdefault(key, {"quantity": 0, "revenue": Decimal("0.00")})
            entry["quantity"] += item.quantity
            entry["revenue"] += item.unit_price_snapshot * item.quantity
            total += item.quantity
    result = [
        {
            "menu_item_id": key[0],
            "name": key[1],
            "quantity": value["quantity"],
            "revenue": value["revenue"],
        }
        for key, value in lines.items()
    ]
    result.sort(key=lambda r: r["quantity"], reverse=True)
    return {"lines": result, "total_items_sold": total}


def orders_of_shift(db: Session, shift_id: UUID) -> list[Order]:
    return db.query(Order).filter(Order.shift_id == shift_id).order_by(Order.created_at.asc()).all()


def total_expenses_of(db: Session, shift_ids: list[UUID]) -> Decimal:
    if not shift_ids:
        return Decimal("0.00")
    return db.query(func.coalesce(func.sum(Expense.amount), 0)).filter(
        Expense.shift_id.in_(shift_ids)
    ).scalar() or Decimal("0.00")


def build_shift_snapshot(db: Session, shift: Shift) -> dict:
    orders = orders_of_shift(db, shift.id)
    sales = sales_metrics(db, orders)
    expenses = db.query(Expense).filter(Expense.shift_id == shift.id).all()
    total_expenses = sum((e.amount for e in expenses), Decimal("0.00"))
    purchase = db.query(PurchaseListItem).filter(PurchaseListItem.shift_id == shift.id).all()
    products = products_metrics(orders)

    return {
        "total_sales": str(sales["total_sales"]),
        "total_expenses": str(total_expenses),
        "net_result": str(sales["total_sales"] - total_expenses),
        "orders_count": sales["orders_count"],
        "tables_served": sales["tables_served"],
        "persons_served": sales["persons_served"],
        "items_sold": products["total_items_sold"],
        "sales_by_waiter": {k: str(v) for k, v in sales["sales_by_waiter"].items()},
        "sales_by_payment_method": {k: str(v) for k, v in sales["sales_by_payment_method"].items()},
        "preparation_metrics": preparation_metrics(db, orders),
        "purchase_list": [
            {
                "id": str(p.id),
                "area": p.area,
                "description": p.description,
                "quantity_text": p.quantity_text,
            }
            for p in purchase
        ],
        "closed_at": datetime.now(UTC).isoformat(),
    }


def build_shift_report(db: Session, shift: Shift):
    from decimal import Decimal

    from app.schemas.reports import (
        PreparationReport,
        PreparationReportLine,
        ProductReportLine,
        ProductsReport,
        SalesReport,
        ShiftReport,
    )

    orders = orders_of_shift(db, shift.id)
    sales = sales_metrics(db, orders)
    snapshot = build_shift_snapshot(db, shift)
    products = products_metrics(orders)
    prep = preparation_metrics(db, orders)

    lines = [
        PreparationReportLine(
            area=area,
            average_seconds=data["average_seconds"],
            items_measured=data["items_measured"],
            within_expected_percent=prep["within_expected_percent"],
        )
        for area, data in prep["by_area"].items()
    ]
    expense_rows = [
        {
            "id": str(e.id),
            "amount": str(e.amount),
            "description": e.description,
            "receipt_url": e.receipt_url,
            "created_at": e.created_at.isoformat() if e.created_at else None,
        }
        for e in db.query(Expense).filter(Expense.shift_id == shift.id).all()
    ]

    return ShiftReport(
        shift_id=shift.id,
        opened_at=shift.opened_at,
        closed_at=shift.closed_at,
        status=shift.status,
        sales=SalesReport(
            total_sales=sales["total_sales"],
            total_expenses=Decimal(snapshot["total_expenses"]),
            net_result=Decimal(snapshot["net_result"]),
            orders_count=sales["orders_count"],
            tables_served=sales["tables_served"],
            persons_served=sales["persons_served"],
            sales_by_waiter=sales["sales_by_waiter"],
            sales_by_payment_method=sales["sales_by_payment_method"],
        ),
        products=ProductsReport(
            lines=[ProductReportLine(**line) for line in products["lines"]],
            total_items_sold=products["total_items_sold"],
        ),
        preparation=PreparationReport(lines=lines, average_seconds=prep["average_seconds"]),
        expenses=expense_rows,
        purchase_list=snapshot["purchase_list"],
    )
