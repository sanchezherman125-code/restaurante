import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import DateTime, ForeignKey, Integer, Numeric, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.users import uuid_pk


class BillSplit(Base):
    __tablename__ = "bill_splits"

    id: Mapped[uuid.UUID] = uuid_pk()
    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id"), index=True)
    split_type: Mapped[str] = mapped_column(String(16), default="BY_AMOUNT")
    label: Mapped[str | None] = mapped_column(String(120), nullable=True)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0.00"))
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    items: Mapped[list["BillSplitItem"]] = relationship(
        back_populates="split", lazy="selectin", cascade="all, delete-orphan"
    )


class BillSplitItem(Base):
    __tablename__ = "bill_split_items"
    __table_args__ = (UniqueConstraint("split_id", "order_item_id", name="uq_split_item"),)

    id: Mapped[uuid.UUID] = uuid_pk()
    split_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("bill_splits.id"), index=True)
    order_item_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("order_items.id"), index=True)
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2), default=Decimal("0.00"))

    split: Mapped[BillSplit] = relationship(back_populates="items")


class Payment(Base):
    __tablename__ = "payments"

    id: Mapped[uuid.UUID] = uuid_pk()
    order_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("orders.id"), index=True)
    split_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("bill_splits.id"), nullable=True, index=True)
    method: Mapped[str] = mapped_column(String(16))
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    paid_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())

    order: Mapped["Order"] = relationship(back_populates="payments")


from app.models.orders import Order  # noqa: E402,F401
