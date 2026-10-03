import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.users import uuid_pk


class Order(Base):
    __tablename__ = "orders"
    __table_args__ = (
        Index(
            "uq_orders_active_dine_in_table",
            "table_id",
            unique=True,
            postgresql_where=text(
                "order_type = 'DINE_IN' AND status IN ('OPEN', 'IN_PREPARATION', 'READY', 'DELIVERED')"
            ),
        ),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    shift_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("shifts.id"), index=True)
    table_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("restaurant_tables.id"), nullable=True, index=True)
    order_type: Mapped[str] = mapped_column(String(16), default="DINE_IN")
    persons_count: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_by_waiter_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    status: Mapped[str] = mapped_column(String(20), default="OPEN", index=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    subtotal: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0.00"))
    total: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0.00"))
    paid_amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0.00"))
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    paid_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    items: Mapped[list["OrderItem"]] = relationship(back_populates="order", lazy="selectin")
    commands: Mapped[list["Command"]] = relationship(
        back_populates="order", lazy="selectin", order_by="Command.sequence_number"
    )
    payments = relationship("Payment", back_populates="order", lazy="selectin")
    table = relationship("RestaurantTable", lazy="joined")
    created_by_waiter = relationship("User", lazy="joined", foreign_keys=[created_by_waiter_id])

    @property
    def table_name(self) -> str | None:
        return self.table.name if self.table else None

    @property
    def table_number(self) -> int | None:
        return self.table.number if self.table else None

    @property
    def created_by_waiter_name(self) -> str | None:
        return self.created_by_waiter.display_name if self.created_by_waiter else None


class Command(Base):
    __tablename__ = "commands"
    __table_args__ = (UniqueConstraint("order_id", "sequence_number", name="uq_command_seq"),)

    id: Mapped[uuid.UUID] = uuid_pk()
    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id"), index=True)
    sequence_number: Mapped[int] = mapped_column(Integer)
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    client_operation_id: Mapped[uuid.UUID | None] = mapped_column(unique=True, nullable=True, index=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    order: Mapped[Order] = relationship(back_populates="commands")
    items: Mapped[list["OrderItem"]] = relationship(
        back_populates="command", lazy="selectin", cascade="all, delete-orphan"
    )


class OrderItem(Base):
    __tablename__ = "order_items"

    id: Mapped[uuid.UUID] = uuid_pk()
    command_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("commands.id"), index=True)
    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id"), index=True)
    menu_item_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("menu_items.id"))
    menu_item_name_snapshot: Mapped[str] = mapped_column(String(160))
    unit_price_snapshot: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    requires_preparation: Mapped[bool] = mapped_column(Boolean, default=True)
    preparation_area: Mapped[str | None] = mapped_column(String(16), nullable=True)
    status: Mapped[str] = mapped_column(String(20), default="PENDING", index=True)
    notes: Mapped[str | None] = mapped_column(Text, nullable=True)
    replacement_description: Mapped[str | None] = mapped_column(Text, nullable=True)
    expected_prep_minutes_snapshot: Mapped[int | None] = mapped_column(Integer, nullable=True)
    preparation_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ready_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    cancelled_after_preparation_started: Mapped[bool] = mapped_column(Boolean, default=False)
    cancellation_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    command: Mapped[Command] = relationship(back_populates="items")
    order: Mapped[Order] = relationship(back_populates="items")
