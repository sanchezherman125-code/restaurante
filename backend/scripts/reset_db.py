"""Reinicia exclusivamente la base E2E dedicada (conserva usuarios, carta y mesas).

Uso:  python -m scripts.reset_db
"""

from sqlalchemy import text

from app.config import settings
from app.db import engine

TRUNCATE_SQL = """
TRUNCATE TABLE
    audit_logs,
    login_attempts,
    idempotency_keys,
    push_subscriptions,
    purchase_list_items,
    expenses,
    payments,
    bill_split_items,
    bill_splits,
    order_items,
    commands,
    orders,
    shifts
RESTART IDENTITY CASCADE
"""

RESET_AVAILABILITY_SQL = """
UPDATE menu_items SET is_available = true, is_active = true
"""


def run() -> None:
    settings.require_test_database()
    with engine.begin() as conn:
        conn.execute(text(TRUNCATE_SQL))
        conn.execute(text(RESET_AVAILABILITY_SQL))
    print("Datos de operación reiniciados (usuarios, carta y mesas conservados).")


if __name__ == "__main__":
    run()
