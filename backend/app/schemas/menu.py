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


MAX_PREPARATION_STEPS = 12
STEP_AREAS = (PreparationArea.KITCHEN, PreparationArea.GRILL)


class PreparationStepIn(BaseModel):
    """Tarea de la receta de un producto. El orden de la lista define ``sort_order``."""

    id: UUID | None = None
    name: str = Field(min_length=1, max_length=160)
    area: PreparationArea
    expected_minutes: int | None = Field(default=None, ge=0, le=600)
    is_active: bool = True

    @model_validator(mode="after")
    def validate_step(self) -> "PreparationStepIn":
        self.name = self.name.strip()
        if not self.name:
            raise ValueError("El nombre de la tarea es obligatorio.")
        if self.area not in STEP_AREAS:
            raise ValueError("Cada tarea requiere área KITCHEN o GRILL.")
        return self


class PreparationStepOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    area: PreparationArea
    expected_minutes: int | None
    sort_order: int
    is_active: bool


def _validate_steps(steps: list[PreparationStepIn]) -> None:
    if len(steps) > MAX_PREPARATION_STEPS:
        raise ValueError(f"Un producto admite como máximo {MAX_PREPARATION_STEPS} tareas.")
    ids = [s.id for s in steps if s.id is not None]
    if len(ids) != len(set(ids)):
        raise ValueError("Una tarea aparece repetida.")
    if steps and not any(s.is_active for s in steps):
        raise ValueError("Un producto con preparación necesita al menos una tarea activa.")


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
    preparation_steps: list[PreparationStepIn] | None = None

    @model_validator(mode="after")
    def validate_preparation(self) -> "MenuItemCreate":
        if self.requires_preparation:
            if self.preparation_steps:
                _validate_steps(self.preparation_steps)
            elif self.preparation_area not in STEP_AREAS:
                raise ValueError("Los productos con preparación requieren área KITCHEN o GRILL.")
        elif self.preparation_steps or self.preparation_area is not None or self.expected_prep_minutes is not None:
            raise ValueError("Los productos de entrega directa no tienen tareas, área ni tiempo de preparación.")
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
    preparation_steps: list[PreparationStepIn] | None = None

    @model_validator(mode="after")
    def validate_steps(self) -> "MenuItemUpdate":
        if self.preparation_steps is not None:
            _validate_steps(self.preparation_steps)
        return self


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
    preparation_steps: list[PreparationStepOut] = []


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
