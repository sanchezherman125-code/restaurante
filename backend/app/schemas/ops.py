from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from app.models.enums import PreparationArea, ShiftStatus


class ExpenseCreate(BaseModel):
    amount: Decimal = Field(gt=0)
    description: str = Field(min_length=1, max_length=500)
    receipt_url: str | None = Field(default=None, max_length=1000)
    client_operation_id: UUID | None = None


class ExpenseOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    shift_id: UUID
    created_by_user_id: UUID
    created_by_name: str | None = None
    amount: Decimal
    description: str
    receipt_url: str | None
    created_at: datetime


class PurchaseItemCreate(BaseModel):
    area: PreparationArea = PreparationArea.KITCHEN
    description: str = Field(min_length=1, max_length=500)
    quantity_text: str | None = Field(default=None, max_length=120)


class PurchaseItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    shift_id: UUID
    area: PreparationArea
    description: str
    quantity_text: str | None
    created_by_user_id: UUID
    created_at: datetime


class ShiftOpenRequest(BaseModel):
    notes: str | None = Field(default=None, max_length=500)


class ShiftOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    opened_at: datetime
    opened_by: UUID
    closed_at: datetime | None
    closed_by: UUID | None
    status: ShiftStatus
    snapshot: dict | None = None


class ReceiptUploadOut(BaseModel):
    url: str
    content_type: str
    size: int


class PushSubscriptionCreate(BaseModel):
    endpoint: str = Field(min_length=1, max_length=2000)
    keys: dict = Field(default_factory=dict)
