"""Align migrated databases with application metadata without deleting business data."""

import sqlalchemy as sa
from alembic import op

revision = "0004_schema_alignment"
down_revision = "0003_direct_delivery_items"
branch_labels = None
depends_on = None

TIMESTAMPS = {
    "users": ("created_at", "updated_at"),
    "restaurant_tables": ("created_at",),
    "menu_categories": ("created_at", "updated_at"),
    "menu_items": ("created_at", "updated_at"),
    "shifts": ("opened_at",),
    "orders": ("opened_at", "created_at", "updated_at"),
    "commands": ("created_at",),
    "order_items": ("created_at", "updated_at"),
    "bill_splits": ("created_at",),
    "payments": ("paid_at", "created_at"),
    "expenses": ("created_at",),
    "purchase_list_items": ("created_at",),
    "push_subscriptions": ("created_at",),
    "idempotency_keys": ("created_at",),
    "audit_logs": ("created_at",),
}
INDEXES = {
    "bill_splits": ("order_id",),
    "bill_split_items": ("split_id", "order_item_id"),
    "payments": ("split_id",),
    "expenses": ("shift_id",),
    "purchase_list_items": ("shift_id",),
}


def upgrade() -> None:
    # Some development databases already added this column manually.
    op.execute("ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS image_url TEXT")
    for table, columns in TIMESTAMPS.items():
        for column in columns:
            op.execute(sa.text(f'UPDATE "{table}" SET "{column}" = now() WHERE "{column}" IS NULL'))
            op.alter_column(table, column, existing_type=sa.DateTime(timezone=True), nullable=False)
    for table, columns in INDEXES.items():
        for column in columns:
            op.create_index(f"ix_{table}_{column}", table, [column])


def downgrade() -> None:
    for table, columns in INDEXES.items():
        for column in columns:
            op.drop_index(f"ix_{table}_{column}", table_name=table)
    for table, columns in TIMESTAMPS.items():
        for column in columns:
            op.alter_column(table, column, existing_type=sa.DateTime(timezone=True), nullable=True)
    op.drop_column("menu_items", "image_url")
