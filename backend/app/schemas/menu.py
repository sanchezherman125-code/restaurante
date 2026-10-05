from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.enums import AvailabilityStatus, PreparationArea


class CategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=120)
    sort_order: int = 0
    is_active: bool = True


class CategoryUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    sort_order: int | None = None
    is_active: bool | None = None


class CategoryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    sort_order: int
    is_active: bool


class MenuItemCreate(BaseModel):
    category_id: UUID
    name: str = Field(min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=500)
    price: Decimal = Field(gt=0, le=Decimal("9999999999.99"))
    requires_preparation: bool = True
    preparation_area: PreparationArea | None = PreparationArea.KITCHEN
    expected_prep_minutes: int | None = Field(default=None, ge=0, le=600)
    is_available: bool = True
    is_active: bool = True

    @model_validator(mode="after")
    def validate_preparation(self) -> "MenuItemCreate":
        if self.requires_preparation:
            if self.preparation_area not in (PreparationArea.KITCHEN, PreparationArea.GRILL):
                raise ValueError("Los productos con preparación requieren área KITCHEN o GRILL.")
        elif self.preparation_area is not None or self.expected_prep_minutes is not None:
            raise ValueError("Los productos de entrega directa no tienen área ni tiempo de preparación.")
        return self


class MenuItemUpdate(BaseModel):
    category_id: UUID | None = None
    name: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=500)
    price: Decimal | None = Field(default=None, gt=0, le=Decimal("9999999999.99"))
    requires_preparation: bool | None = None
    preparation_area: PreparationArea | None = None
    expected_prep_minutes: int | None = Field(default=None, ge=0, le=600)
    is_active: bool | None = None


class MenuItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    category_id: UUID
    name: str
    description: str | None
    price: Decimal
    requires_preparation: bool
    preparation_area: PreparationArea | None
    expected_prep_minutes: int | None
    is_available: bool
    is_active: bool
    image_url: str | None
    availability_status: AvailabilityStatus = AvailabilityStatus.AVAILABLE


class MenuOut(BaseModel):
    categories: list[CategoryOut]
    items: list[MenuItemOut]


class AvailabilityUpdate(BaseModel):
    status: AvailabilityStatus


class TableCreate(BaseModel):
    name: str = Field(min_length=1, max_length=60)
    number: int = Field(ge=1, le=9999)
    is_active: bool = True


class TableUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=60)
    number: int | None = Field(default=None, ge=1, le=9999)
    is_active: bool | None = None


class TableOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    number: int
    is_active: bool
    status: str = "FREE"
    order_id: UUID | None = None
