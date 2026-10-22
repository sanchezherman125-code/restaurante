from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import PaymentMethod, SplitType


class SplitOut(BaseModel):
    """Solo lectura: divisiones creadas antes de retirar la función."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    order_id: UUID
    split_type: SplitType
    label: str | None
    amount: Decimal
    created_at: datetime


class PaymentCreate(BaseModel):
    method: PaymentMethod
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    # Obsoleto: se mantiene solo para rechazar explícitamente clientes antiguos (422 SPLIT_PAYMENTS_DISABLED).
    split_id: UUID | None = None
    client_operation_id: UUID | None = None


class PaymentOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    order_id: UUID
    split_id: UUID | None
    method: PaymentMethod
    amount: Decimal
    paid_at: datetime


class BillingItemOut(BaseModel):
    order_item_id: UUID
    name: str
    quantity: int
    unit_price: Decimal
    total: Decimal
    status: str


class BillingOut(BaseModel):
    order_id: UUID
    table_name: str | None
    table_number: int | None
    status: str
    items: list[BillingItemOut]
    subtotal: Decimal
    total: Decimal
    paid_amount: Decimal
    pending_amount: Decimal
    legacy_splits: list[SplitOut] = []
    payments: list[PaymentOut]
