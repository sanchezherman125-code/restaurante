import uuid
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    JSON,
    DateTime,
    ForeignKey,
    Integer,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.db import Base
from app.models.users import uuid_pk


class Shift(Base):
    __tablename__ = "shifts"

    id: Mapped[uuid.UUID] = uuid_pk()
    opened_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    opened_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    closed_by: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    status: Mapped[str] = mapped_column(String(16), default="OPEN", index=True)
    snapshot: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class Expense(Base):
    __tablename__ = "expenses"

    id: Mapped[uuid.UUID] = uuid_pk()
    shift_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("shifts.id"), index=True)
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    amount: Mapped[Decimal] = mapped_column(Numeric(12, 2))
    description: Mapped[str] = mapped_column(Text)
    receipt_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PurchaseListItem(Base):
    __tablename__ = "purchase_list_items"

    id: Mapped[uuid.UUID] = uuid_pk()
    shift_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("shifts.id"), index=True)
    area: Mapped[str] = mapped_column(String(16), default="KITCHEN")
    description: Mapped[str] = mapped_column(Text)
    quantity_text: Mapped[str | None] = mapped_column(String(120), nullable=True)
    created_by_user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id"))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class IdempotencyKey(Base):
    __tablename__ = "idempotency_keys"

    id: Mapped[uuid.UUID] = uuid_pk()
    key: Mapped[uuid.UUID] = mapped_column(unique=True, index=True)
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    operation_type: Mapped[str] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    response_status: Mapped[int] = mapped_column(Integer, default=200)
    response_body: Mapped[dict | None] = mapped_column(JSON, nullable=True)


class LoginAttempt(Base):
    __tablename__ = "login_attempts"
    __table_args__ = (UniqueConstraint("username", "ip", name="uq_login_attempt_username_ip"),)

    id: Mapped[uuid.UUID] = uuid_pk()
    username: Mapped[str] = mapped_column(String(64))
    ip: Mapped[str] = mapped_column(String(64))
    failures: Mapped[int] = mapped_column(Integer, default=0)
    window_started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class AuditLog(Base):
    __tablename__ = "audit_logs"

    id: Mapped[uuid.UUID] = uuid_pk()
    user_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("users.id"), nullable=True)
    action: Mapped[str] = mapped_column(String(64), index=True)
    entity_type: Mapped[str] = mapped_column(String(64))
    entity_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    before_data: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    after_data: Mapped[dict | None] = mapped_column(JSON, nullable=True)
    device_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
