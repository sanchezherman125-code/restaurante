"""La migración 0007 debe convertir platos históricos en tareas sin tocar importes, pagos ni estados."""

from alembic.config import Config
from sqlalchemy import text

from alembic import command
from app.db import SessionLocal, engine
from tests.conftest import create_command, create_order

ITEM_COLUMNS = (
    "id, status, quantity, unit_price_snapshot, preparation_area, expected_prep_minutes_snapshot, "
    "preparation_started_at, ready_at, delivered_at, cancelled_at, requires_preparation"
)


def _snapshot(conn) -> dict:
    return {
        "items": [tuple(r) for r in conn.execute(text(f"SELECT {ITEM_COLUMNS} FROM order_items ORDER BY id"))],
        "orders": [tuple(r) for r in conn.execute(
            text("SELECT id, status, subtotal, total, paid_amount FROM orders ORDER BY id"))],
        "payments": [tuple(r) for r in conn.execute(text("SELECT id, amount, method FROM payments ORDER BY id"))],
    }


def test_historical_items_become_one_equivalent_task_and_money_is_untouched(
    admin, mesero, cocina, parrilla, open_shift, menu_lookup,
):
    names = ["Pollo a la brasa", "Parrilla especial", "Anticuchos", "Causa limeña", "Ensalada mixta", "Inca Kola 500ml"]
    order = create_order(mesero)
    command_out = create_command(mesero, order["id"], [{"menu_item_id": menu_lookup[n]["id"]} for n in names])
    by_name = {i["menu_item_name_snapshot"]: i for i in command_out["items"]}
    path = f"/api/v1/orders/{order['id']}/items"

    def move(api, name, *statuses):
        for status in statuses:
            assert api.client.post(f"{path}/{by_name[name]['id']}/status", json={"status": status}).status_code == 200

    move(cocina, "Pollo a la brasa", "PREPARING")
    move(parrilla, "Parrilla especial", "PREPARING", "READY")
    move(parrilla, "Anticuchos", "PREPARING", "READY")
    assert mesero.client.post(f"{path}/{by_name['Anticuchos']['id']}/status",
                              json={"status": "DELIVERED"}).status_code == 200
    salad = by_name["Ensalada mixta"]["id"]
    assert mesero.client.post(f"{path}/{salad}/cancel", json={"reason": "x"}).status_code == 200
    assert admin.client.post(f"/api/v1/orders/{order['id']}/payments",
                             json={"method": "YAPE", "amount": "10.00"}).status_code == 201

    with engine.connect() as conn:
        before = _snapshot(conn)
    cfg = Config("alembic.ini")
    command.downgrade(cfg, "0006_push_device")  # el estado previo al despliegue: sin tablas de tareas
    try:
        with engine.connect() as conn:
            assert conn.execute(text("SELECT to_regclass('order_item_preparation_tasks')")).scalar() is None
    finally:
        command.upgrade(cfg, "head")

    with engine.connect() as conn:
        assert _snapshot(conn) == before
        rows = {r[0]: r for r in conn.execute(text(
            "SELECT i.menu_item_name_snapshot, t.name, t.area, t.status, t.expected_minutes, t.started_at IS NOT NULL, "
            "t.ready_at IS NOT NULL, t.menu_step_id IS NULL FROM order_items i "
            "LEFT JOIN order_item_preparation_tasks t ON t.order_item_id = i.id"))}
        counts = dict(conn.execute(text(
            "SELECT order_item_id::text, count(*) FROM order_item_preparation_tasks GROUP BY 1")).all())
        assert all(n == 1 for n in counts.values()) and len(counts) == 5
        assert rows["Pollo a la brasa"][1:5] == ("Pollo a la brasa", "KITCHEN", "PREPARING", 20)
        assert rows["Parrilla especial"][3] == "READY" and rows["Parrilla especial"][6] is True
        assert rows["Anticuchos"][3] == "READY"  # entregado ⇒ su única tarea terminó
        assert rows["Ensalada mixta"][3] == "CANCELLED"
        assert rows["Causa limeña"][3] == "PENDING" and rows["Causa limeña"][5] is False
        assert rows["Inca Kola 500ml"][1] is None  # entrega directa: sin tareas
        assert rows["Pollo a la brasa"][7] is True  # histórico: sin vínculo al catálogo
        # La receta del catálogo también se rellena: una tarea por producto con preparación.
        assert conn.execute(text(
            "SELECT count(*) FROM menu_items m WHERE m.requires_preparation AND "
            "(SELECT count(*) FROM menu_preparation_steps s WHERE s.menu_item_id = m.id) <> 1")).scalar() == 0

    # Aplicar de nuevo el relleno no duplica nada.
    from app.services.preparation import BACKFILL_TASKS_SQL

    with SessionLocal() as db:
        assert db.execute(BACKFILL_TASKS_SQL).rowcount == 0

    # Y el pedido histórico sigue siendo operable con el flujo nuevo.
    move(cocina, "Pollo a la brasa", "READY")
    detail = mesero.client.get(f"/api/v1/orders/{order['id']}").json()
    assert next(i for i in detail["items"] if i["id"] == by_name["Pollo a la brasa"]["id"])["status"] == "READY"
