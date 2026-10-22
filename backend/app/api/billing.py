from uuid import UUID

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.core import audit as audit_actions
from app.core.deps import CurrentUser, DbSession
from app.core.errors import ApiError, ConflictError, ForbiddenError, NotFoundError, ValidationAppError
from app.core.idempotency import execute_idempotent
from app.models import BillSplit, Order, Payment
from app.models.enums import ItemStatus, OrderStatus
from app.schemas.billing import (
    BillingItemOut,
    BillingOut,
    PaymentCreate,
    PaymentOut,
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


@router.get("/{order_id}/billing", response_model=BillingOut)
def get_billing(order_id: UUID, db: DbSession, user: CurrentUser) -> BillingOut:
    order = _get_order(db, order_id)
    _authorize_billing(user, order)
    items = [
        BillingItemOut(
            order_item_id=i.id,
            name=i.menu_item_name_snapshot,
            quantity=i.quantity,
            unit_price=i.unit_price_snapshot,
            total=i.unit_price_snapshot * i.quantity,
            status=i.status.value if isinstance(i.status, ItemStatus) else str(i.status),
        )
        for i in order.items
        if i.status != ItemStatus.CANCELLED
    ]
    # Solo lectura: las divisiones históricas siguen siendo consultables para auditoría contable.
    legacy_splits = db.query(BillSplit).filter(BillSplit.order_id == order.id).order_by(BillSplit.created_at).all()
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
        legacy_splits=[SplitOut.model_validate(s) for s in legacy_splits],
        payments=[PaymentOut.model_validate(p) for p in sorted(order.payments, key=lambda p: p.paid_at)],
    )


@router.post("/{order_id}/splits", status_code=410, include_in_schema=False)
def create_split_removed(order_id: UUID, user: CurrentUser) -> None:
    """La división de cuentas se retiró: se rechaza explícitamente en lugar de ignorarse."""
    raise ApiError(410, "SPLITS_DISABLED", "La división de cuentas ya no está disponible. Registre el cobro completo.")


@router.post("/{order_id}/payments", status_code=201)
def register_payment(
    order_id: UUID,
    payload: PaymentCreate,
    db: DbSession,
    user: CurrentUser,
) -> JSONResponse:
    if user.role not in ("ADMIN", "WAITER"):
        raise ValidationAppError("PAYMENT_FORBIDDEN", "Solo meseros o administradores registran pagos.")
    if payload.split_id is not None:
        raise ValidationAppError(
            "SPLIT_PAYMENTS_DISABLED", "Los pagos por división ya no se admiten. Registre el cobro sin división."
        )
    order = _get_order(db, order_id)
    _authorize_billing(user, order)

    def operation() -> tuple[int, dict]:
        shift, locked_order = order_service.lock_order_and_shift(db, order.id, order.shift_id)
        if locked_order.status == OrderStatus.CLOSED:
            raise ConflictError("ORDER_ALREADY_CLOSED", "El pedido ya está cerrado.")
        order_service.ensure_shift_open(shift)
        pending = locked_order.total - locked_order.paid_amount
        if payload.amount > pending:
            raise ValidationAppError(
                "PAYMENT_EXCEEDS_PENDING",
                "El monto supera el saldo pendiente del pedido.",
                {"pending": str(pending)},
            )
        payment = Payment(
            order_id=locked_order.id,
            method=payload.method.value,
            amount=payload.amount,
            created_by_user_id=user.id,
        )
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
        if became_paid:
            hub.after_commit(
                db,
                "order.paid",
                {
                    "order_id": str(locked_order.id),
                    "created_by_waiter_id": str(locked_order.created_by_waiter_id),
                    "paid_amount": str(locked_order.paid_amount),
                    "status": locked_order.status,
                },
                {"waiters", "admin"},
            )
        return 201, body

    status, body = execute_idempotent(
        db, payload.client_operation_id, user.id, "REGISTER_PAYMENT", operation, scope=str(order_id),
    )
    return JSONResponse(status_code=status, content=body)


@router.get("/{order_id}/payments", response_model=list[PaymentOut])
def list_payments(order_id: UUID, db: DbSession, user: CurrentUser) -> list[PaymentOut]:
    order = _get_order(db, order_id)
    _authorize_billing(user, order)
    return [PaymentOut.model_validate(p) for p in order.payments]
