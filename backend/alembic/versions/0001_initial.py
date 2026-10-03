"""modelo inicial

Revision ID: 0001_initial
Revises:
Create Date: 2026-10-02

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision: str = "0001_initial"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "users",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("username", sa.String(64), nullable=False, unique=True),
        sa.Column("pin_hash", sa.Text(), nullable=False),
        sa.Column("display_name", sa.String(120), nullable=False),
        sa.Column("role", sa.String(16), nullable=False),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_users_username", "users", ["username"])

    op.create_table(
        "restaurant_tables",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(60), nullable=False),
        sa.Column("number", sa.Integer(), nullable=False, unique=True),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "menu_categories",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("name", sa.String(120), nullable=False, unique=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "menu_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "category_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("menu_categories.id"),
            nullable=False,
        ),
        sa.Column("name", sa.String(160), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("price", sa.Numeric(12, 2), nullable=False),
        sa.Column("preparation_area", sa.String(16), nullable=False, server_default="KITCHEN"),
        sa.Column("expected_prep_minutes", sa.Integer(), nullable=True),
        sa.Column("is_available", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_menu_items_category_id", "menu_items", ["category_id"])

    op.create_table(
        "shifts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("opened_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column(
            "opened_by",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("status", sa.String(16), nullable=False, server_default="OPEN"),
        sa.Column("snapshot", postgresql.JSONB(), nullable=True),
    )
    op.create_index("ix_shifts_status", "shifts", ["status"])

    op.create_table(
        "orders",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "shift_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("shifts.id"), nullable=False
        ),
        sa.Column(
            "table_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("restaurant_tables.id"),
            nullable=True,
        ),
        sa.Column("order_type", sa.String(16), nullable=False, server_default="DINE_IN"),
        sa.Column("persons_count", sa.Integer(), nullable=True),
        sa.Column(
            "created_by_waiter_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column("status", sa.String(20), nullable=False, server_default="OPEN"),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("subtotal", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("total", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("paid_amount", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("opened_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("closed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_orders_shift_id", "orders", ["shift_id"])
    op.create_index("ix_orders_table_id", "orders", ["table_id"])
    op.create_index("ix_orders_status", "orders", ["status"])

    op.create_table(
        "commands",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "order_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("orders.id"), nullable=False
        ),
        sa.Column("sequence_number", sa.Integer(), nullable=False),
        sa.Column(
            "created_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column("client_operation_id", postgresql.UUID(as_uuid=True), nullable=True, unique=True),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.UniqueConstraint("order_id", "sequence_number", name="uq_command_seq"),
    )
    op.create_index("ix_commands_order_id", "commands", ["order_id"])

    op.create_table(
        "order_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "command_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("commands.id"), nullable=False
        ),
        sa.Column("order_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column(
            "menu_item_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("menu_items.id"), nullable=False
        ),
        sa.Column("menu_item_name_snapshot", sa.String(160), nullable=False),
        sa.Column("unit_price_snapshot", sa.Numeric(12, 2), nullable=False),
        sa.Column("quantity", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("preparation_area", sa.String(16), nullable=False, server_default="KITCHEN"),
        sa.Column("status", sa.String(20), nullable=False, server_default="PENDING"),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column("replacement_description", sa.Text(), nullable=True),
        sa.Column("expected_prep_minutes_snapshot", sa.Integer(), nullable=True),
        sa.Column("preparation_started_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("ready_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("cancelled_by", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column(
            "cancelled_after_preparation_started",
            sa.Boolean(),
            nullable=False,
            server_default=sa.false(),
        ),
        sa.Column("cancellation_reason", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_order_items_command_id", "order_items", ["command_id"])
    op.create_index("ix_order_items_order_id", "order_items", ["order_id"])
    op.create_index("ix_order_items_status", "order_items", ["status"])

    op.create_table(
        "bill_splits",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("order_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("split_type", sa.String(16), nullable=False, server_default="BY_AMOUNT"),
        sa.Column("label", sa.String(120), nullable=True),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column(
            "created_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "bill_split_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "split_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("bill_splits.id"), nullable=False
        ),
        sa.Column(
            "order_item_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("order_items.id"), nullable=False
        ),
        sa.Column("quantity", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.UniqueConstraint("split_id", "order_item_id", name="uq_split_item"),
    )

    op.create_table(
        "payments",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("order_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column(
            "split_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("bill_splits.id"), nullable=True
        ),
        sa.Column("method", sa.String(16), nullable=False),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column(
            "created_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column("paid_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_payments_order_id", "payments", ["order_id"])

    op.create_table(
        "expenses",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("shift_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("shifts.id"), nullable=False),
        sa.Column(
            "created_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("receipt_url", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "purchase_list_items",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("shift_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("shifts.id"), nullable=False),
        sa.Column("area", sa.String(16), nullable=False, server_default="KITCHEN"),
        sa.Column("description", sa.Text(), nullable=False),
        sa.Column("quantity_text", sa.String(120), nullable=True),
        sa.Column(
            "created_by_user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "push_subscriptions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="SET NULL"), nullable=True
        ),
        sa.Column("endpoint", sa.Text(), nullable=False, unique=True),
        sa.Column("keys", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_table(
        "idempotency_keys",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("key", postgresql.UUID(as_uuid=True), nullable=False, unique=True),
        sa.Column(
            "user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True
        ),
        sa.Column("operation_type", sa.String(64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("response_status", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("response_body", postgresql.JSONB(), nullable=True),
    )
    op.create_index("ix_idempotency_keys_key", "idempotency_keys", ["key"])

    op.create_table(
        "audit_logs",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True
        ),
        sa.Column("action", sa.String(64), nullable=False),
        sa.Column("entity_type", sa.String(64), nullable=False),
        sa.Column("entity_id", sa.String(64), nullable=True),
        sa.Column("before_data", postgresql.JSONB(), nullable=True),
        sa.Column("after_data", postgresql.JSONB(), nullable=True),
        sa.Column("device_id", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_audit_logs_action", "audit_logs", ["action"])


def downgrade() -> None:
    for table in (
        "audit_logs",
        "idempotency_keys",
        "push_subscriptions",
        "purchase_list_items",
        "expenses",
        "payments",
        "bill_split_items",
        "bill_splits",
        "order_items",
        "commands",
        "orders",
        "shifts",
        "menu_items",
        "menu_categories",
        "restaurant_tables",
        "users",
    ):
        op.drop_table(table)
