from datetime import datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, model_validator

from app.models.enums import ItemStatus, OrderStatus, OrderType, PreparationArea, TaskStatus


class OrderCreate(BaseModel):
    order_type: OrderType = OrderType.DINE_IN
    table_id: UUID | None = None
    persons_count: int | None = Field(default=None, ge=1, le=100)
    notes: str | None = Field(default=None, max_length=1000)
    client_operation_id: UUID | None = None

    @model_validator(mode="after")
    def validate_dine_in(self) -> "OrderCreate":
        if self.order_type == OrderType.DINE_IN:
            if self.table_id is None:
                raise ValueError("table_id es obligatorio para pedidos DINE_IN")
            if self.persons_count is None or self.persons_count < 1:
                raise ValueError("persons_count debe ser mayor a 0 para pedidos DINE_IN")
        return self


class ItemCreate(BaseModel):
    menu_item_id: UUID
    quantity: int = Field(default=1, ge=1, le=99)
    notes: str | None = Field(default=None, max_length=500)
    replacement_description: str | None = Field(default=None, max_length=500)


class CommandCreate(BaseModel):
    items: list[ItemCreate] = Field(min_length=1, max_length=50)
    notes: str | None = Field(default=None, max_length=1000)
    client_operation_id: UUID | None = None

    @model_validator(mode="after")
    def unique_menu_items(self) -> "CommandCreate":
        ids = [i.menu_item_id for i in self.items]
        if len(ids) != len(set(ids)):
            raise ValueError("No se permiten productos duplicados en la misma comanda")
        return self


class OrderOpenWithCommand(BaseModel):
    """Abre una mesa y registra su primera comanda en una sola operación atómica."""

    table_id: UUID
    persons_count: int = Field(ge=1, le=100)
    order_notes: str | None = Field(default=None, max_length=1000)
    items: list[ItemCreate] = Field(min_length=1, max_length=50)
    notes: str | None = Field(default=None, max_length=1000)
    client_operation_id: UUID | None = None

    @model_validator(mode="after")
    def unique_menu_items(self) -> "OrderOpenWithCommand":
        ids = [i.menu_item_id for i in self.items]
        if len(ids) != len(set(ids)):
            raise ValueError("No se permiten productos duplicados en la misma comanda")
        return self


class ItemUpdate(BaseModel):
    quantity: int | None = Field(default=None, ge=1, le=99)
    notes: str | None = Field(default=None, max_length=500)
    replacement_description: str | None = Field(default=None, max_length=500)


class OrderCancelRequest(BaseModel):
    client_operation_id: UUID | None = None


class ItemCancelRequest(BaseModel):
    reason: str | None = Field(default=None, max_length=500)
    client_operation_id: UUID | None = None


class ItemStatusRequest(BaseModel):
    status: ItemStatus
    client_operation_id: UUID | None = None


class PreparationTaskOut(BaseModel):
    """Tarea interna de un plato. Nunca tiene precio: el cobro vive solo en el plato."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    area: PreparationArea
    status: TaskStatus
    expected_minutes: int | None
    sort_order: int
    started_at: datetime | None
    ready_at: datetime | None
    cancelled_at: datetime | None


class TaskStatusRequest(BaseModel):
    status: TaskStatus
    client_operation_id: UUID | None = None

    @model_validator(mode="after")
    def only_forward_states(self) -> "TaskStatusRequest":
        if self.status not in (TaskStatus.PREPARING, TaskStatus.READY):
            raise ValueError("Una tarea solo puede pasar a PREPARING o READY; use la cancelación del producto.")
        return self


class OrderItemOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    command_id: UUID
    order_id: UUID
    menu_item_id: UUID
    menu_item_name_snapshot: str
    unit_price_snapshot: Decimal
    quantity: int
    requires_preparation: bool
    preparation_area: PreparationArea | None
    status: ItemStatus
    notes: str | None
    replacement_description: str | None
    expected_prep_minutes_snapshot: int | None
    preparation_started_at: datetime | None
    ready_at: datetime | None
    delivered_at: datetime | None
    cancelled_at: datetime | None
    cancelled_after_preparation_started: bool
    cancellation_reason: str | None
    created_at: datetime
    tasks: list[PreparationTaskOut] = []

    @property
    def line_total(self) -> Decimal:
        return self.unit_price_snapshot * self.quantity


class CommandOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    order_id: UUID
    sequence_number: int
    notes: str | None
    created_at: datetime
    items: list[OrderItemOut] = []


class OrderSummaryOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    shift_id: UUID
    table_id: UUID | None
    table_name: str | None = None
    table_number: int | None = None
    order_type: OrderType
    persons_count: int | None
    created_by_waiter_id: UUID
    created_by_waiter_name: str | None = None
    status: OrderStatus
    notes: str | None
    subtotal: Decimal
    total: Decimal
    paid_amount: Decimal
    opened_at: datetime
    paid_at: datetime | None
    closed_at: datetime | None
    created_at: datetime
    updated_at: datetime


class OrderOut(OrderSummaryOut):
    items: list[OrderItemOut] = []
    commands: list[CommandOut] = []


class SiblingTaskOut(BaseModel):
    id: UUID
    name: str
    area: PreparationArea
    status: TaskStatus


class BoardTaskOut(BaseModel):
    """Tarea del área mostrada en el tablero, con el contexto del plato al que pertenece."""

    id: UUID
    order_item_id: UUID
    order_id: UUID
    command_id: UUID
    name: str
    item_name: str
    quantity: int
    notes: str | None
    replacement_description: str | None
    area: PreparationArea
    status: TaskStatus
    expected_minutes: int | None
    started_at: datetime | None
    ready_at: datetime | None
    created_at: datetime
    item_status: ItemStatus
    other_tasks: list[SiblingTaskOut] = []


class ItemGroupOut(BaseModel):
    """Vista de preparación: comanda con las tareas del área."""

    order_id: UUID
    command_id: UUID
    sequence_number: int
    table_name: str | None
    table_number: int | None
    order_type: OrderType
    persons_count: int | None
    notes: str | None
    command_notes: str | None
    created_at: datetime
    waiter_name: str | None
    tasks: list[BoardTaskOut]
    items: list[OrderItemOut]  # Obsoleto: platos con tareas en el área; se conserva para clientes en caché.
    other_areas: dict[str, str] = {}
    order_general_status: str = ""
    elapsed_seconds: int = 0
