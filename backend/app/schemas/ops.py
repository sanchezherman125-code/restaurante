from datetime import datetime
from decimal import Decimal
from urllib.parse import urlparse
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator

from app.models.enums import PreparationArea, ShiftStatus


class ExpenseCreate(BaseModel):
    amount: Decimal = Field(gt=0, max_digits=12, decimal_places=2)
    description: str = Field(min_length=1, max_length=500)
    receipt_url: str | None = Field(default=None, max_length=1000)
    # Turno en que se generó la operación (cola offline). Si ya no es el turno vigente se rechaza: nunca se reasigna.
    shift_id: UUID | None = None
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
    keys: dict = Field(min_length=2, max_length=2)

    @field_validator("endpoint")
    @classmethod
    def validate_push_endpoint(cls, value: str) -> str:
        parsed = urlparse(value)
        host = (parsed.hostname or "").lower()
        trusted = (
            host == "fcm.googleapis.com"
            or host == "web.push.apple.com"
            or host.endswith(".push.services.mozilla.com")
        )
        if (
            parsed.scheme != "https" or not trusted or parsed.port not in (None, 443)
            or parsed.username is not None or parsed.password is not None or parsed.fragment
        ):
            raise ValueError("Un proveedor Web Push HTTPS conocido es obligatorio")
        return value

    @field_validator("keys")
    @classmethod
    def validate_push_keys(cls, value: dict) -> dict:
        if set(value) != {"auth", "p256dh"} or any(not isinstance(key, str) or not key for key in value.values()):
            raise ValueError("Push subscription keys are invalid")
        return value


class PushSubscriptionDelete(BaseModel):
    endpoint: str = Field(min_length=1, max_length=2000)
