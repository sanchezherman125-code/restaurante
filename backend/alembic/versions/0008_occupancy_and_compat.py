"""Corrective migration for 0007: occupancy, race-free mirror tasks and old-writer compatibility.

* ``orders.occupies_table`` is derived by trigger from status + undelivered items, so every writer (old or new
  backend, or manual SQL) gets the same table occupancy and the unique index rejects a second occupying order.
* ``order_item_preparation_tasks.legacy_mirror`` + partial unique index: a task copied from an item (startup
  backfill, lazy repair or the trigger below) is unique per item, so concurrent fillers cannot duplicate it.
  Real multi-area tasks are not mirrors and are unaffected.
* ``order_items.tasks_managed`` (false for rows written by a backend that predates tasks): triggers give such
  items a mirror task on INSERT and keep it in sync on status changes, so they stay visible on the boards during
  a rolling deploy. The new backend inserts items with ``tasks_managed = true`` and manages tasks itself.

0007 is left untouched (already published); nothing here rewrites money, payments or item statuses.
"""

import sqlalchemy as sa
from alembic import op

revision = "0008_occupancy_and_compat"
down_revision = "0007_preparation_tasks"
branch_labels = None
depends_on = None

STATUS_TO_TASK = """CASE {s} WHEN 'PREPARING' THEN 'PREPARING' WHEN 'READY' THEN 'READY'
    WHEN 'DELIVERED' THEN 'READY' WHEN 'CANCELLED' THEN 'CANCELLED' ELSE 'PENDING' END"""

BACKFILL = f"""
INSERT INTO order_item_preparation_tasks
    (id, order_item_id, menu_step_id, name, area, expected_minutes, sort_order, status,
     started_at, ready_at, cancelled_at, legacy_mirror, created_at, updated_at)
SELECT gen_random_uuid(), oi.id, NULL, oi.menu_item_name_snapshot, oi.preparation_area,
       CASE WHEN oi.expected_prep_minutes_snapshot IS NULL THEN NULL
            ELSE GREATEST(0, LEAST(600, oi.expected_prep_minutes_snapshot)) END,
       0, {STATUS_TO_TASK.format(s="oi.status")},
       oi.preparation_started_at, oi.ready_at, oi.cancelled_at, TRUE, oi.created_at, oi.updated_at
FROM order_items oi
WHERE oi.requires_preparation IS TRUE AND oi.preparation_area IN ('KITCHEN', 'GRILL')
  AND NOT EXISTS (SELECT 1 FROM order_item_preparation_tasks t WHERE t.order_item_id = oi.id)
ON CONFLICT (order_item_id) WHERE legacy_mirror DO NOTHING
"""

FUNCTIONS = f"""
CREATE OR REPLACE FUNCTION orders_occupies(p_order uuid, p_status text) RETURNS boolean AS $$
    SELECT CASE
        WHEN p_status IN ('OPEN', 'IN_PREPARATION', 'READY', 'DELIVERED') THEN TRUE
        WHEN p_status = 'PAID' THEN EXISTS (
            SELECT 1 FROM order_items WHERE order_id = p_order AND status IN ('PENDING', 'PREPARING', 'READY'))
        ELSE FALSE END
$$ LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION orders_set_occupancy() RETURNS trigger AS $$
BEGIN
    NEW.occupies_table := orders_occupies(NEW.id, NEW.status);
    RETURN NEW;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION order_items_refresh_order() RETURNS trigger AS $$
BEGIN
    -- Only touches (and locks) the order row when occupancy actually changes.
    UPDATE orders SET occupies_table = orders_occupies(id, status)
    WHERE id = NEW.order_id AND occupies_table IS DISTINCT FROM orders_occupies(id, status);
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION order_items_mirror_task() RETURNS trigger AS $$
BEGIN
    INSERT INTO order_item_preparation_tasks
        (id, order_item_id, name, area, expected_minutes, sort_order, status,
         started_at, ready_at, cancelled_at, legacy_mirror, created_at, updated_at)
    VALUES (gen_random_uuid(), NEW.id, NEW.menu_item_name_snapshot, NEW.preparation_area,
            CASE WHEN NEW.expected_prep_minutes_snapshot IS NULL THEN NULL
                 ELSE GREATEST(0, LEAST(600, NEW.expected_prep_minutes_snapshot)) END,
            0, {STATUS_TO_TASK.format(s="NEW.status")},
            NEW.preparation_started_at, NEW.ready_at, NEW.cancelled_at, TRUE, now(), now())
    ON CONFLICT (order_item_id) WHERE legacy_mirror DO NOTHING;
    RETURN NULL;
END $$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION order_items_sync_mirror() RETURNS trigger AS $$
DECLARE target text := {STATUS_TO_TASK.format(s="NEW.status")};
BEGIN
    -- Monotonic: a mirror task only moves forward (or to CANCELLED), like the application does.
    UPDATE order_item_preparation_tasks t SET
        status = target,
        started_at = COALESCE(t.started_at, NEW.preparation_started_at),
        ready_at = COALESCE(t.ready_at, NEW.ready_at),
        cancelled_at = CASE WHEN target = 'CANCELLED' THEN COALESCE(t.cancelled_at, NEW.cancelled_at, now())
                            ELSE t.cancelled_at END,
        updated_at = now()
    WHERE t.order_item_id = NEW.id AND t.legacy_mirror AND t.status <> 'CANCELLED'
      AND (target = 'CANCELLED'
           OR (CASE t.status WHEN 'PENDING' THEN 0 WHEN 'PREPARING' THEN 1 ELSE 2 END)
              < (CASE target WHEN 'PENDING' THEN 0 WHEN 'PREPARING' THEN 1 ELSE 2 END));
    RETURN NULL;
END $$ LANGUAGE plpgsql;
"""

TRIGGERS = """
CREATE TRIGGER trg_orders_occupancy BEFORE INSERT OR UPDATE OF status ON orders
    FOR EACH ROW EXECUTE FUNCTION orders_set_occupancy();
CREATE TRIGGER trg_order_items_occupancy AFTER INSERT OR UPDATE OF status ON order_items
    FOR EACH ROW EXECUTE FUNCTION order_items_refresh_order();
CREATE TRIGGER trg_order_items_mirror AFTER INSERT ON order_items
    FOR EACH ROW WHEN (NOT NEW.tasks_managed AND NEW.requires_preparation AND NEW.preparation_area IN ('KITCHEN', 'GRILL'))
    EXECUTE FUNCTION order_items_mirror_task();
CREATE TRIGGER trg_order_items_sync_mirror AFTER UPDATE OF status ON order_items
    FOR EACH ROW WHEN (NEW.status IS DISTINCT FROM OLD.status AND NOT NEW.tasks_managed AND NEW.requires_preparation)
    EXECUTE FUNCTION order_items_sync_mirror();
"""


def upgrade() -> None:
    # Block writers (readers continue) while the columns, triggers and the final backfill are installed, so no
    # row written by the previous backend can slip between the backfill of 0007 and the triggers below.
    op.execute("LOCK TABLE orders, order_items, order_item_preparation_tasks IN SHARE ROW EXCLUSIVE MODE")

    op.add_column("orders", sa.Column("occupies_table", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("order_items", sa.Column("tasks_managed", sa.Boolean(), nullable=False, server_default=sa.false()))
    op.add_column("order_item_preparation_tasks",
                  sa.Column("legacy_mirror", sa.Boolean(), nullable=False, server_default=sa.false()))

    # Items already created by the multi-area code manage their own tasks; the rest hold item-derived mirrors.
    op.execute("""
        UPDATE order_items SET tasks_managed = TRUE WHERE id IN (
            SELECT order_item_id FROM order_item_preparation_tasks
            GROUP BY order_item_id HAVING count(*) > 1 OR bool_or(menu_step_id IS NOT NULL))
    """)
    op.execute("""
        UPDATE order_item_preparation_tasks SET legacy_mirror = TRUE
        WHERE order_item_id IN (SELECT id FROM order_items WHERE NOT tasks_managed)
    """)
    op.create_index("uq_prep_tasks_legacy_mirror", "order_item_preparation_tasks", ["order_item_id"], unique=True,
                    postgresql_where=sa.text("legacy_mirror"))

    op.execute(FUNCTIONS)
    op.execute(TRIGGERS)
    op.execute(BACKFILL)  # final catch-up under the lock; idempotent and conflict-safe

    op.execute("UPDATE orders SET occupies_table = orders_occupies(id, status)")
    # Never fail a deploy on historical overlaps: keep the newest occupant, release older ones.
    op.execute("""
        UPDATE orders o SET occupies_table = FALSE FROM (
            SELECT id, row_number() OVER (PARTITION BY table_id ORDER BY created_at DESC, id) AS rn
            FROM orders WHERE occupies_table AND order_type = 'DINE_IN' AND table_id IS NOT NULL) d
        WHERE o.id = d.id AND d.rn > 1
    """)
    op.drop_index("uq_orders_active_dine_in_table", table_name="orders")
    op.create_index("uq_orders_occupied_dine_in_table", "orders", ["table_id"], unique=True,
                    postgresql_where=sa.text("order_type = 'DINE_IN' AND occupies_table"))


def downgrade() -> None:
    op.execute("LOCK TABLE orders, order_items, order_item_preparation_tasks IN SHARE ROW EXCLUSIVE MODE")
    op.drop_index("uq_orders_occupied_dine_in_table", table_name="orders")
    op.create_index("uq_orders_active_dine_in_table", "orders", ["table_id"], unique=True,
                    postgresql_where=sa.text(
                        "order_type = 'DINE_IN' AND status IN ('OPEN', 'IN_PREPARATION', 'READY', 'DELIVERED')"))
    for trigger, table in (("trg_order_items_sync_mirror", "order_items"), ("trg_order_items_mirror", "order_items"),
                           ("trg_order_items_occupancy", "order_items"), ("trg_orders_occupancy", "orders")):
        op.execute(f"DROP TRIGGER IF EXISTS {trigger} ON {table}")
    for function in ("order_items_sync_mirror()", "order_items_mirror_task()", "order_items_refresh_order()",
                     "orders_set_occupancy()", "orders_occupies(uuid, text)"):
        op.execute(f"DROP FUNCTION IF EXISTS {function}")
    op.drop_index("uq_prep_tasks_legacy_mirror", table_name="order_item_preparation_tasks")
    op.drop_column("order_item_preparation_tasks", "legacy_mirror")
    op.drop_column("order_items", "tasks_managed")
    op.drop_column("orders", "occupies_table")
