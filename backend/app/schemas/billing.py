from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.enums import PaymentMethod, SplitType


class SplitItemCreate(BaseModel):
    order_item_id: UUID
    quantity: int = Field(default=1, ge=1, le=99)


class SplitCreate(BaseModel):
    split_type: SplitType
    label: str | None = Field(default=None, max_length=120)
    amount: Decimal | None = Field(default=None, gt=0)
    items: list[SplitItemCreate] = Field(default_factory=list)

    @model_validator(mode="after")
    def validate_payload(self) -> "SplitCreate":
        if self.split_type == SplitType.BY_AMOUNT:
            if self.amount is None:
                raise ValueError("amount es obligatorio para división por monto")
        else:
            if not self.items:
                raise ValueError("items es obligatorio para división por productos")
        return self


class SplitOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    order_id: UUID
    split_type: SplitType
    label: str | None
    amount: Decimal
    created_at: datetime


class PaymentCreate(BaseModel):
    method: PaymentMethod
    amount: Decimal = Field(gt=0)
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
    split_quantity: int = 0


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
    splits: list[SplitOut]
    payments: list[PaymentOut]
