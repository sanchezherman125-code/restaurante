"""Revocable sessions, private receipts, money checks and Data API isolation."""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0005_production_security"
down_revision = "0004_schema_alignment"
branch_labels = None
depends_on = None

CHECKS = (
    ("orders", "ck_order_money", "subtotal >= 0 AND total >= 0 AND paid_amount >= 0 AND paid_amount <= total"),
    ("order_items", "ck_order_item_money_quantity", "quantity > 0 AND unit_price_snapshot >= 0"),
    ("menu_items", "ck_menu_item_price", "price > 0"),
    ("payments", "ck_payment_amount", "amount > 0"),
    ("expenses", "ck_expense_amount", "amount > 0"),
    ("bill_splits", "ck_bill_split_amount", "amount > 0"),
    ("bill_split_items", "ck_bill_split_item_amount_quantity", "quantity > 0 AND amount > 0"),
)
TABLES = (
    "users", "restaurant_tables", "menu_categories", "menu_items", "shifts", "orders", "commands",
    "order_items", "bill_splits", "bill_split_items", "payments", "expenses", "purchase_list_items",
    "push_subscriptions", "idempotency_keys", "audit_logs", "login_attempts", "auth_sessions", "receipts",
    "alembic_version",
)


def upgrade() -> None:
    op.create_table(
        "auth_sessions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("refresh_jti", sa.String(64), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_auth_sessions_user_id", "auth_sessions", ["user_id"])
    op.create_table(
        "receipts",
        sa.Column("filename", sa.String(64), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("content_type", sa.String(64), nullable=False),
        sa.Column("size", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )
    op.create_index("ix_receipts_user_id", "receipts", ["user_id"])
    for table, name, condition in CHECKS:
        # NOT VALID checks still protect new writes; validation aborts on existing bad data.
        # Operators must reconcile that data instead of silently rewriting financial history.
        op.execute(f'ALTER TABLE "{table}" ADD CONSTRAINT "{name}" CHECK ({condition}) NOT VALID')
        op.execute(f'ALTER TABLE "{table}" VALIDATE CONSTRAINT "{name}"')
    op.create_index("uq_shifts_open", "shifts", ["status"], unique=True,
                    postgresql_where=sa.text("status = 'OPEN'"))
    # FastAPI owns authorization; Supabase anon/authenticated must never bypass it.
    # The backend connects as table owner (or a dedicated BYPASSRLS role).
    for table in TABLES:
        op.execute(f'ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY')
    for role in ("anon", "authenticated"):
        if op.get_bind().execute(sa.text("SELECT 1 FROM pg_roles WHERE rolname = :role"), {"role": role}).scalar():
            for table in TABLES:
                op.execute(f'REVOKE ALL ON TABLE "{table}" FROM "{role}"')


def downgrade() -> None:
    for table in TABLES:
        op.execute(f'ALTER TABLE "{table}" DISABLE ROW LEVEL SECURITY')
    op.drop_index("uq_shifts_open", table_name="shifts")
    for table, name, _ in CHECKS:
        op.drop_constraint(name, table, type_="check")
    op.drop_table("receipts")
    op.drop_table("auth_sessions")
