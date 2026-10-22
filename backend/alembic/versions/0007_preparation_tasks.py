"""Preparation steps per product and preparation tasks per ordered item.

Additive and re-runnable: no column is altered or dropped, no order money, payment or item
status is touched. Existing single-area products/items receive one equivalent step/task.

Revision ID: 0007_preparation_tasks
Revises: 0006_push_device
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "0007_preparation_tasks"
down_revision = "0006_push_device"
branch_labels = None
depends_on = None

NEW_TABLES = ("menu_preparation_steps", "order_item_preparation_tasks")

BACKFILL_STEPS = """
INSERT INTO menu_preparation_steps (id, menu_item_id, name, area, expected_minutes, sort_order, is_active)
SELECT gen_random_uuid(), m.id, m.name, m.preparation_area,
       CASE WHEN m.expected_prep_minutes IS NULL THEN NULL
            ELSE GREATEST(0, LEAST(600, m.expected_prep_minutes)) END,
       0, TRUE
FROM menu_items m
WHERE m.requires_preparation IS TRUE
  AND m.preparation_area IN ('KITCHEN', 'GRILL')
  AND NOT EXISTS (SELECT 1 FROM menu_preparation_steps s WHERE s.menu_item_id = m.id)
"""

# A delivered dish had all its preparation finished, so its single task is READY.
BACKFILL_TASKS = """
INSERT INTO order_item_preparation_tasks
    (id, order_item_id, menu_step_id, name, area, expected_minutes, sort_order, status,
     started_at, ready_at, cancelled_at, created_at, updated_at)
SELECT gen_random_uuid(), oi.id, NULL, oi.menu_item_name_snapshot, oi.preparation_area,
       CASE WHEN oi.expected_prep_minutes_snapshot IS NULL THEN NULL
            ELSE GREATEST(0, LEAST(600, oi.expected_prep_minutes_snapshot)) END,
       0,
       CASE oi.status WHEN 'PREPARING' THEN 'PREPARING'
                      WHEN 'READY' THEN 'READY'
                      WHEN 'DELIVERED' THEN 'READY'
                      WHEN 'CANCELLED' THEN 'CANCELLED'
                      ELSE 'PENDING' END,
       oi.preparation_started_at, oi.ready_at, oi.cancelled_at, oi.created_at, oi.updated_at
FROM order_items oi
WHERE oi.requires_preparation IS TRUE
  AND oi.preparation_area IN ('KITCHEN', 'GRILL')
  AND NOT EXISTS (SELECT 1 FROM order_item_preparation_tasks t WHERE t.order_item_id = oi.id)
"""


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    ]


def upgrade() -> None:
    inspector = sa.inspect(op.get_bind())
    existing = set(inspector.get_table_names())

    if "menu_preparation_steps" not in existing:
        op.create_table(
            "menu_preparation_steps",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("menu_item_id", postgresql.UUID(as_uuid=True),
                      sa.ForeignKey("menu_items.id", ondelete="CASCADE"), nullable=False),
            sa.Column("name", sa.String(160), nullable=False),
            sa.Column("area", sa.String(16), nullable=False),
            sa.Column("expected_minutes", sa.Integer(), nullable=True),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("is_active", sa.Boolean(), nullable=False, server_default=sa.true()),
            *_timestamps(),
            sa.CheckConstraint("area IN ('KITCHEN', 'GRILL')", name="ck_prep_step_area"),
            sa.CheckConstraint(
                "expected_minutes IS NULL OR (expected_minutes >= 0 AND expected_minutes <= 600)",
                name="ck_prep_step_minutes",
            ),
        )
        op.create_index("ix_menu_preparation_steps_item_order", "menu_preparation_steps",
                        ["menu_item_id", "sort_order"])

    if "order_item_preparation_tasks" not in existing:
        op.create_table(
            "order_item_preparation_tasks",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("order_item_id", postgresql.UUID(as_uuid=True),
                      sa.ForeignKey("order_items.id", ondelete="CASCADE"), nullable=False),
            sa.Column("menu_step_id", postgresql.UUID(as_uuid=True),
                      sa.ForeignKey("menu_preparation_steps.id", ondelete="SET NULL"), nullable=True),
            sa.Column("name", sa.String(160), nullable=False),
            sa.Column("area", sa.String(16), nullable=False),
            sa.Column("expected_minutes", sa.Integer(), nullable=True),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("status", sa.String(16), nullable=False, server_default="PENDING"),
            sa.Column("started_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("ready_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("cancelled_at", sa.DateTime(timezone=True), nullable=True),
            *_timestamps(),
            sa.CheckConstraint("area IN ('KITCHEN', 'GRILL')", name="ck_prep_task_area"),
            sa.CheckConstraint("status IN ('PENDING', 'PREPARING', 'READY', 'CANCELLED')",
                               name="ck_prep_task_status"),
        )
        op.create_index("ix_prep_tasks_item", "order_item_preparation_tasks", ["order_item_id"])
        op.create_index("ix_prep_tasks_area_status", "order_item_preparation_tasks", ["area", "status"])

    # Same posture as 0005: FastAPI owns authorization, Supabase anon/authenticated must never read these.
    for table in NEW_TABLES:
        op.execute(f'ALTER TABLE "{table}" ENABLE ROW LEVEL SECURITY')
        for role in ("anon", "authenticated"):
            if op.get_bind().execute(sa.text("SELECT 1 FROM pg_roles WHERE rolname = :r"), {"r": role}).scalar():
                op.execute(f'REVOKE ALL ON TABLE "{table}" FROM "{role}"')

    # Both statements skip rows that already have steps/tasks, so re-running is harmless.
    op.execute(BACKFILL_STEPS)
    op.execute(BACKFILL_TASKS)


def downgrade() -> None:
    # Only the derived task tables are dropped; commercial items, payments and totals are untouched.
    op.drop_index("ix_prep_tasks_area_status", table_name="order_item_preparation_tasks")
    op.drop_index("ix_prep_tasks_item", table_name="order_item_preparation_tasks")
    op.drop_table("order_item_preparation_tasks")
    op.drop_index("ix_menu_preparation_steps_item_order", table_name="menu_preparation_steps")
    op.drop_table("menu_preparation_steps")
