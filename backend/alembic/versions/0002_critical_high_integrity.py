"""critical/high integrity protections

Revision ID: 0002_critical_high_integrity
Revises: 0001_initial
Create Date: 2026-10-02
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "0002_critical_high_integrity"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "uq_orders_active_dine_in_table",
        "orders",
        ["table_id"],
        unique=True,
        postgresql_where=sa.text("order_type = 'DINE_IN' AND status IN ('OPEN', 'IN_PREPARATION', 'READY', 'DELIVERED')"),
    )
    op.create_table(
        "login_attempts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("username", sa.String(64), nullable=False),
        sa.Column("ip", sa.String(64), nullable=False),
        sa.Column("failures", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("window_started_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("locked_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.UniqueConstraint("username", "ip", name="uq_login_attempt_username_ip"),
    )


def downgrade() -> None:
    op.drop_table("login_attempts")
    op.drop_index("uq_orders_active_dine_in_table", table_name="orders")
