import uuid
from datetime import datetime

from sqlalchemy import Boolean, CheckConstraint, DateTime, ForeignKey, Index, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.db import Base
from app.models.users import uuid_pk


class MenuPreparationStep(Base):
    """Receta vigente de un producto: una fila por tarea interna de preparación."""

    __tablename__ = "menu_preparation_steps"
    __table_args__ = (
        CheckConstraint("area IN ('KITCHEN', 'GRILL')", name="ck_prep_step_area"),
        CheckConstraint("expected_minutes IS NULL OR (expected_minutes >= 0 AND expected_minutes <= 600)",
                        name="ck_prep_step_minutes"),
        Index("ix_menu_preparation_steps_item_order", "menu_item_id", "sort_order"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    menu_item_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("menu_items.id", ondelete="CASCADE"))
    name: Mapped[str] = mapped_column(String(160))
    area: Mapped[str] = mapped_column(String(16))
    expected_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class OrderItemPreparationTask(Base):
    """Copia inmutable de un paso de receta al registrar la comanda.

    Los pedidos nunca vuelven a leer ``menu_preparation_steps``: nombre, área y tiempo
    se congelan aquí. El plato comercial (``order_items``) sigue siendo la única fila que
    se cobra; las tareas solo describen el trabajo interno.
    """

    __tablename__ = "order_item_preparation_tasks"
    __table_args__ = (
        CheckConstraint("area IN ('KITCHEN', 'GRILL')", name="ck_prep_task_area"),
        CheckConstraint("status IN ('PENDING', 'PREPARING', 'READY', 'CANCELLED')", name="ck_prep_task_status"),
        Index("ix_prep_tasks_item", "order_item_id"),
        Index("ix_prep_tasks_area_status", "area", "status"),
    )

    id: Mapped[uuid.UUID] = uuid_pk()
    order_item_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("order_items.id", ondelete="CASCADE"))
    menu_step_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("menu_preparation_steps.id", ondelete="SET NULL"), nullable=True
    )
    name: Mapped[str] = mapped_column(String(160))
    area: Mapped[str] = mapped_column(String(16))
    expected_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(16), default="PENDING")
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    ready_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )

    item = relationship("OrderItem", back_populates="tasks")
