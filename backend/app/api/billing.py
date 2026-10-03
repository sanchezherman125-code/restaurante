from decimal import Decimal
from uuid import UUID

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy import func

from app.core import audit as audit_actions
from app.core.deps import CurrentUser, DbSession, ensure_order_in_open_shift
from app.core.errors import ConflictError, ForbiddenError, NotFoundError, ValidationAppError
from app.core.idempotency import execute_idempotent
from app.models import BillSplit, BillSplitItem, Order, OrderItem, Payment
from app.models.enums import ItemStatus, OrderStatus, SplitType
from app.schemas.billing import (
    BillingItemOut,
    BillingOut,
    PaymentCreate,
    PaymentOut,
    SplitCreate,
    SplitOut,
)
from app.services import orders as order_service
from app.ws.hub import hub

router = APIRouter(prefix="/orders", tags=["billing"])

OPEN_STATUSES = [
    OrderStatus.OPEN,
    OrderStatus.IN_PREPARATION,
    OrderStatus.READY,
    OrderStatus.DELIVERED,
]


def _get_order(db, order_id: UUID) -> Order:
    order = db.get(Order, order_id)
    if order is None:
        raise NotFoundError("ORDER_NOT_FOUND", "Pedido no encontrado.")
    return order


def _authorize_billing(user, order: Order) -> None:
    if user.role == "ADMIN":
        return
    if user.role == "WAITER" and order.created_by_waiter_id == user.id:
        return
    raise ForbiddenError("BILLING_FORBIDDEN", "No tiene permiso para consultar o modificar este cobro.")


def _lock_order(db, order_id: UUID) -> Order:
    order = (
        db.query(Order)
        .filter(Order.id == order_id)
        .populate_existing()
        .with_for_update(of=Order)
        .one_or_none()
    )
    if order is None:
        raise NotFoundError("ORDER_NOT_FOUND", "Pedido no encontrado.")
    return order


def _split_quantities(db, order_id: UUID) -> dict[UUID, int]:
    rows = (
        db.query(BillSplitItem.order_item_id, func.coalesce(func.sum(BillSplitItem.quantity), 0))
        .join(BillSplit, BillSplit.id == BillSplitItem.split_id)
        .filter(BillSplit.order_id == order_id)
        .group_by(BillSplitItem.order_item_id)
        .all()
    )
    return {row[0]: int(row[1]) for row in rows}


@router.get("/{order_id}/billing", response_model=BillingOut)
def get_billing(order_id: UUID, db: DbSession, user: CurrentUser) -> BillingOut:
    order = _get_order(db, order_id)
    _authorize_billing(user, order)
    split_qtys = _split_quantities(db, order.id)
    items = [
        BillingItemOut(
            order_item_id=i.id,
            name=i.menu_item_name_snapshot,
            quantity=i.quantity,
            unit_price=i.unit_price_snapshot,
            total=i.unit_price_snapshot * i.quantity,
            status=i.status.value if isinstance(i.status, ItemStatus) else str(i.status),
            split_quantity=split_qtys.get(i.id, 0),
        )
        for i in order.items
        if i.status != ItemStatus.CANCELLED
    ]
    splits = db.query(BillSplit).filter(BillSplit.order_id == order.id).all()
    return BillingOut(
        order_id=order.id,
        table_name=order.table_name,
        table_number=order.table_number,
        status=order.status.value if isinstance(order.status, OrderStatus) else str(order.status),
        items=items,
        subtotal=order.subtotal,
        total=order.total,
        paid_amount=order.paid_amount,
        pending_amount=order.total - order.paid_amount,
        splits=[SplitOut.model_validate(s) for s in splits],
        payments=[PaymentOut.model_validate(p) for p in order.payments],
    )


@router.post("/{order_id}/splits", response_model=SplitOut, status_code=201)
def create_split(order_id: UUID, payload: SplitCreate, db: DbSession, user: CurrentUser) -> SplitOut:
    if user.role not in ("ADMIN", "WAITER"):
        raise ValidationAppError("SPLIT_FORBIDDEN", "Solo meseros o administradores dividen cuentas.")
    order = _get_order(db, order_id)
    _authorize_billing(user, order)
    ensure_order_in_open_shift(db, order.shift_id)
    order = _lock_order(db, order_id)
    if order.status not in OPEN_STATUSES and order.status != OrderStatus.PAID:
        raise ConflictError("ORDER_ALREADY_CLOSED", "El pedido ya está cerrado.")

    pending = order.total - order.paid_amount
    split_qtys = _split_quantities(db, order.id)
    existing_split_total = (
        db.query(func.coalesce(func.sum(BillSplit.amount), 0)).filter(BillSplit.order_id == order.id).scalar()
    )

    if payload.split_type == SplitType.BY_AMOUNT:
        amount = payload.amount
        available = pending - Decimal(existing_split_total)
        if amount > available:
            raise ValidationAppError(
                "SPLIT_EXCEEDS_PENDING",
                "La suma de divisiones no puede exceder el total pendiente.",
                {"pending": str(available)},
            )
        split = BillSplit(
            order_id=order.id,
            split_type=SplitType.BY_AMOUNT.value,
            label=payload.label,
            amount=amount,
            created_by_user_id=user.id,
        )
        db.add(split)
    else:
        allocated: dict[UUID, int] = {}
        amount = Decimal("0.00")
        for entry in payload.items:
            item = db.get(OrderItem, entry.order_item_id)
            if item is None or item.order_id != order.id:
                raise NotFoundError("ITEM_NOT_FOUND", "Producto no encontrado en este pedido.")
            if item.status == ItemStatus.CANCELLED:
                raise ValidationAppError("ITEM_CANCELLED", "No puede dividirse un producto cancelado.")
            already = allocated.get(item.id, 0) + split_qtys.get(item.id, 0)
            if already + entry.quantity > item.quantity:
                raise ValidationAppError(
                    "SPLIT_QUANTITY_EXCEEDED",
                    f"Ya se asignó {already} de {item.quantity} de '{item.menu_item_name_snapshot}'.",
                )
            allocated[item.id] = already + entry.quantity
            amount += item.unit_price_snapshot * entry.quantity
        if Decimal(existing_split_total) + amount > pending:
            raise ValidationAppError(
                "SPLIT_EXCEEDS_TOTAL",
                "La suma de divisiones no puede exceder el total pendiente.",
                {"pending": str(pending - Decimal(existing_split_total))},
            )
        split = BillSplit(
            order_id=order.id,
            split_type=SplitType.BY_ITEMS.value,
            label=payload.label,
            amount=amount,
            created_by_user_id=user.id,
        )
        db.add(split)
        db.flush()
        for entry in payload.items:
            item = db.get(OrderItem, entry.order_item_id)
            db.add(
                BillSplitItem(
                    split_id=split.id,
                    order_item_id=item.id,
                    quantity=entry.quantity,
                    amount=item.unit_price_snapshot * entry.quantity,
                )
            )

    db.commit()
    db.refresh(split)
    return SplitOut.model_validate(split)


@router.post("/{order_id}/payments", status_code=201)
def register_payment(
    order_id: UUID,
    payload: PaymentCreate,
    db: DbSession,
    user: CurrentUser,
) -> JSONResponse:
    if user.role not in ("ADMIN", "WAITER"):
        raise ValidationAppError("PAYMENT_FORBIDDEN", "Solo meseros o administradores registran pagos.")
    order = _get_order(db, order_id)
    _authorize_billing(user, order)
    if order.status == OrderStatus.CLOSED:
        raise ConflictError("ORDER_ALREADY_CLOSED", "El pedido ya está cerrado.")

    def operation() -> tuple[int, dict]:
        ensure_order_in_open_shift(db, order.shift_id)
        locked_order = _lock_order(db, order_id)
        pending = locked_order.total - locked_order.paid_amount
        if payload.amount > pending:
            raise ValidationAppError(
                "PAYMENT_EXCEEDS_PENDING",
                "El monto supera el saldo pendiente del pedido.",
                {"pending": str(pending)},
            )
        payment = Payment(
            order_id=locked_order.id,
            split_id=payload.split_id,
            method=payload.method.value,
            amount=payload.amount,
            created_by_user_id=user.id,
        )
        if payload.split_id is not None:
            split = db.get(BillSplit, payload.split_id)
            if split is None or split.order_id != locked_order.id:
                raise ValidationAppError("SPLIT_NOT_IN_ORDER", "La división no pertenece a este pedido.")
        db.add(payment)
        locked_order.paid_amount = locked_order.paid_amount + payload.amount
        became_paid = locked_order.paid_amount >= locked_order.total
        if became_paid:
            locked_order.status = OrderStatus.PAID
            locked_order.paid_at = order_service.utcnow()
        else:
            order_service.apply_status(locked_order)
        db.flush()
        audit_actions.audit(
            db,
            user_id=user.id,
            action=audit_actions.PAYMENT_REGISTERED,
            entity_type="payments",
            entity_id=payment.id,
            after_data={
                "order_id": str(locked_order.id),
                "method": payload.method.value,
                "amount": str(payload.amount),
            },
        )
        body = PaymentOut.model_validate(payment).model_dump(mode="json")
        body["order_status"] = locked_order.status
        body["paid_amount"] = str(locked_order.paid_amount)
        body["became_paid"] = became_paid
        return 201, body

    status, body = execute_idempotent(db, payload.client_operation_id, user.id, "REGISTER_PAYMENT", operation)
    if body.get("became_paid"):
        hub.broadcast(
            "order.paid",
            {
                "order_id": str(order.id),
                "paid_amount": str(body.get("paid_amount", order.paid_amount)),
                "status": body["order_status"],
            },
            {"waiters", "admin"},
        )
    return JSONResponse(status_code=status, content=body)


@router.get("/{order_id}/payments", response_model=list[PaymentOut])
def list_payments(order_id: UUID, db: DbSession, user: CurrentUser) -> list[PaymentOut]:
    order = _get_order(db, order_id)
    _authorize_billing(user, order)
    return [PaymentOut.model_validate(p) for p in order.payments]
