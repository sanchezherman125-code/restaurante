"""Regresiones de la auditoría independiente (I-1 … I-5, M-1). Cada prueba afirma el comportamiento correcto."""

import os
import subprocess
import sys
import time
import uuid
from concurrent.futures import ThreadPoolExecutor
from decimal import Decimal

import pytest
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from alembic import command
from app.db import SessionLocal, engine
from app.models import AuditLog, Order, OrderItemPreparationTask
from app.services import orders as svc
from app.services import preparation as prep
from tests.conftest import create_command, create_order
from tests.test_concurrency import _post_requests_concurrently, _token


def dish(mesero, menu_lookup, name="Pollo a la brasa", table_number=1):
    order = create_order(mesero, table_number=table_number)
    item = create_command(mesero, order["id"], [{"menu_item_id": menu_lookup[name]["id"]}])["items"][0]
    return order, item


def orphan(item_ids):
    """Deja platos con la forma persistida de una escritura antigua: sin tareas."""
    with engine.begin() as c:
        c.execute(text("DELETE FROM order_item_preparation_tasks WHERE order_item_id = ANY(:ids)"),
                  {"ids": list(item_ids)})


def task_count(item_id) -> int:
    with SessionLocal() as db:
        return db.query(OrderItemPreparationTask).filter_by(order_item_id=item_id).count()


def pay(api, order_id, amount, method="CASH"):
    return api.client.post(f"/api/v1/orders/{order_id}/payments", json={"method": method, "amount": amount})


# --- I-1: relleno histórico concurrente -----------------------------------------------------------------


def test_backfill_racing_lazy_repair_creates_one_task(mesero, open_shift, menu_lookup):
    order, item = dish(mesero, menu_lookup)
    orphan([item["id"]])
    db = SessionLocal()
    pool = ThreadPoolExecutor(max_workers=1)
    try:
        _, locked = svc.lock_order_and_shift(db, order["id"], order["shift_id"])
        locked_item = svc.lock_order_item(db, locked.id, item["id"])
        prep.ensure_item_tasks(db, locked_item)  # insertada, sin confirmar

        def startup():
            with SessionLocal() as worker:
                worker.execute(text("SET LOCAL application_name='backfill_race'"))
                worker.execute(text("SET LOCAL statement_timeout='10s'"))
                return prep.backfill_missing_tasks(worker)

        future = pool.submit(startup)
        for _ in range(100):  # el relleno debe quedar esperando la inserción pendiente
            with engine.connect() as c:
                waiting = c.execute(text("SELECT count(*) FROM pg_stat_activity WHERE "
                                         "application_name='backfill_race' AND wait_event_type='Lock'")).scalar()
            if waiting:
                break
            time.sleep(0.03)
        assert waiting
        db.commit()
        assert future.result(timeout=12) == 0  # perdió la carrera: no inserta nada
        assert task_count(item["id"]) == 1
    finally:
        db.rollback()
        db.close()
        pool.shutdown(wait=True)


def test_many_real_processes_backfill_without_duplicates(mesero, open_shift, menu_lookup):
    items = []
    for number in range(1, 6):
        _, item = dish(mesero, menu_lookup, table_number=number)
        items.append(item["id"])
    orphan(items)
    script = ("from app.db import SessionLocal; from app.services.preparation import backfill_missing_tasks;"
              "import sys\nwith SessionLocal() as db: print(backfill_missing_tasks(db))")
    procs = [subprocess.Popen([sys.executable, "-c", script], env=os.environ.copy(), stdout=subprocess.PIPE,
                              stderr=subprocess.PIPE, text=True) for _ in range(6)]
    results = [(p.wait(timeout=60), p.stdout.read(), p.stderr.read()) for p in procs]
    assert all(code == 0 for code, _, _ in results), results
    assert sum(int(out.strip().splitlines()[-1]) for _, out, _ in results) == 5  # cada plato se rellena una vez
    assert [task_count(i) for i in items] == [1] * 5


def test_database_rejects_a_second_mirror_but_allows_real_multi_area_tasks(mesero, open_shift, menu_lookup):
    _, item = dish(mesero, menu_lookup)
    with SessionLocal() as db:
        db.execute(text("UPDATE order_item_preparation_tasks SET legacy_mirror = TRUE WHERE order_item_id = :i"),
                   {"i": item["id"]})
        db.commit()
        db.add(OrderItemPreparationTask(order_item_id=item["id"], name="otra", area="GRILL", legacy_mirror=True))
        with pytest.raises(IntegrityError):
            db.commit()
        db.rollback()
        db.add_all([OrderItemPreparationTask(order_item_id=item["id"], name=f"real {n}", area="GRILL")
                    for n in range(2)])
        db.commit()  # tareas reales (no espejo) del mismo plato: permitidas
        assert db.query(OrderItemPreparationTask).filter_by(order_item_id=item["id"]).count() == 3


# --- I-2: compatibilidad entre versiones ----------------------------------------------------------------


def insert_old_style_item(order, menu_item, status="PENDING"):
    """Escritura de un backend anterior a las tareas: ni conoce ``tasks_managed`` ni crea tareas."""
    item_id = str(uuid.uuid4())
    with engine.begin() as c:
        command_id = c.execute(text("SELECT id FROM commands WHERE order_id = :o LIMIT 1"), {"o": order["id"]}).scalar()
        c.execute(text(
            "INSERT INTO order_items (id, command_id, order_id, menu_item_id, menu_item_name_snapshot, "
            "unit_price_snapshot, quantity, requires_preparation, preparation_area, status, "
            "expected_prep_minutes_snapshot, cancelled_after_preparation_started) "
            "VALUES (:id, :cmd, :o, :m, 'Pollo viejo', 25, 1, TRUE, 'KITCHEN', :s, 20, FALSE)"),
            {"id": item_id, "cmd": command_id, "o": order["id"], "m": menu_item["id"], "s": status})
        c.execute(text("UPDATE orders SET subtotal = total + 25, total = total + 25 WHERE id = :o"), {"o": order["id"]})
    return item_id


def test_item_written_by_old_backend_after_backfill_is_visible_and_stays_in_sync(
    mesero, cocina, menu_lookup, open_shift,
):
    order, first = dish(mesero, menu_lookup)
    with SessionLocal() as db:
        assert prep.backfill_missing_tasks(db) == 0  # el relleno de arranque ya corrió
    old_id = insert_old_style_item(order, menu_lookup["Pollo a la brasa"])  # escritura posterior al relleno
    board = cocina.client.get("/api/v1/preparation/kitchen").json()
    assert {t["order_item_id"] for g in board for t in g["tasks"]} == {first["id"], old_id}

    def old_update(sql, **params):
        with engine.begin() as c:
            c.execute(text(sql), {"i": old_id, **params})

    old_update("UPDATE order_items SET status='PREPARING', preparation_started_at=now() WHERE id=:i")
    tasks = {t["order_item_id"]: t for g in cocina.client.get("/api/v1/preparation/kitchen").json() for t in g["tasks"]}
    assert tasks[old_id]["status"] == "PREPARING" and tasks[old_id]["started_at"]
    old_update("UPDATE order_items SET status='READY', ready_at=now() WHERE id=:i")
    old_update("UPDATE order_items SET status='DELIVERED', delivered_at=now() WHERE id=:i")
    with SessionLocal() as db:
        (task,) = db.query(OrderItemPreparationTask).filter_by(order_item_id=old_id).all()
        assert task.status == "READY" and task.legacy_mirror
    # El backend nuevo puede seguir operando un plato antiguo, y las tareas nunca retroceden.
    other = insert_old_style_item(order, menu_lookup["Pollo a la brasa"])
    path = f"/api/v1/orders/{order['id']}/items/{other}/status"
    assert cocina.client.post(path, json={"status": "PREPARING"}).status_code == 200
    assert cocina.client.post(path, json={"status": "READY"}).status_code == 200
    with SessionLocal() as db:
        (task,) = db.query(OrderItemPreparationTask).filter_by(order_item_id=other).all()
        assert task.status == "READY"


def test_old_backend_cancellation_cancels_the_mirror_task(mesero, cocina, menu_lookup, open_shift):
    order, _ = dish(mesero, menu_lookup)
    old_id = insert_old_style_item(order, menu_lookup["Pollo a la brasa"])
    with engine.begin() as c:
        c.execute(text("UPDATE order_items SET status='CANCELLED', cancelled_at=now() WHERE id=:i"), {"i": old_id})
    with SessionLocal() as db:
        assert db.query(OrderItemPreparationTask).filter_by(order_item_id=old_id).one().status == "CANCELLED"
    board_items = {t["order_item_id"] for g in cocina.client.get("/api/v1/preparation/kitchen").json()
                   for t in g["tasks"]}
    assert old_id not in board_items


def test_new_backend_items_are_managed_and_get_no_mirror(mesero, open_shift, menu_lookup):
    _, item = dish(mesero, menu_lookup)
    with SessionLocal() as db:
        assert db.execute(text("SELECT tasks_managed FROM order_items WHERE id=:i"), {"i": item["id"]}).scalar()
        assert not db.query(OrderItemPreparationTask).filter_by(order_item_id=item["id"]).one().legacy_mirror


def test_old_backend_order_occupies_the_table_for_the_new_backend(mesero, open_shift, menu_lookup):
    table = mesero.client.get("/api/v1/tables").json()[0]
    shift_id = open_shift["id"]
    with engine.begin() as c:
        waiter = c.execute(text("SELECT id FROM users WHERE username='mesero1'")).scalar()
        c.execute(text("INSERT INTO orders (id, shift_id, table_id, order_type, persons_count, "
                       "created_by_waiter_id, status, subtotal, total, paid_amount) VALUES "
                       "(:id, :s, :t, 'DINE_IN', 2, :w, 'OPEN', 0, 0, 0)"),
                  {"id": str(uuid.uuid4()), "s": shift_id, "t": table["id"], "w": waiter})
    assert next(t for t in mesero.client.get("/api/v1/tables").json() if t["id"] == table["id"])["status"] == "OPEN"
    response = mesero.client.post("/api/v1/orders", json={"order_type": "DINE_IN", "table_id": table["id"],
                                                          "persons_count": 2})
    assert response.status_code == 409 and response.json()["error"]["code"] == "TABLE_ALREADY_OPEN"


def test_migration_0008_upgrade_with_pre_existing_data():
    """0007 → 0008 sobre datos que dejó un backend anterior: relleno final, banderas y ocupación."""
    cfg = Config("alembic.ini")
    command.downgrade(cfg, "0007_preparation_tasks")
    try:
        with engine.begin() as c:
            uid = c.execute(text("SELECT id FROM users WHERE username='mesero1'")).scalar()
            tables = [r[0] for r in c.execute(text("SELECT id FROM restaurant_tables ORDER BY number LIMIT 2"))]
            menu_id = c.execute(text("SELECT id FROM menu_items WHERE name='Pollo a la brasa'")).scalar()
            sid = c.execute(text("INSERT INTO shifts (id, opened_at, opened_by, status) VALUES "
                                 "(gen_random_uuid(), now(), :u, 'OPEN') RETURNING id"), {"u": uid}).scalar()

            def order(table, status, paid="0", total="25"):
                oid = str(uuid.uuid4())
                c.execute(text("INSERT INTO orders (id, shift_id, table_id, order_type, created_by_waiter_id, status, "
                               "subtotal, total, paid_amount, created_at) VALUES (:id, :s, :t, 'DINE_IN', :u, :st, "
                               ":tot, :tot, :p, now())"),
                          {"id": oid, "s": sid, "t": table, "u": uid, "st": status, "tot": total, "p": paid})
                cmd = str(uuid.uuid4())
                c.execute(text("INSERT INTO commands (id, order_id, sequence_number, created_by_user_id) "
                               "VALUES (:c, :o, 1, :u)"), {"c": cmd, "o": oid, "u": uid})
                return oid, cmd

            def item(oid, cmd, status):
                iid = str(uuid.uuid4())
                c.execute(text("INSERT INTO order_items (id, command_id, order_id, menu_item_id, "
                               "menu_item_name_snapshot, unit_price_snapshot, quantity, requires_preparation, "
                               "preparation_area, status, cancelled_after_preparation_started) VALUES "
                               "(:i, :c, :o, :m, 'Pollo', 25, 1, TRUE, 'KITCHEN', :s, FALSE)"),
                          {"i": iid, "c": cmd, "o": oid, "m": menu_id, "s": status})
                return iid
            paid_pending, cmd1 = order(tables[0], "PAID", paid="25")
            pending_item = item(paid_pending, cmd1, "PREPARING")
            paid_done, cmd2 = order(tables[1], "PAID", paid="25")
            done_item = item(paid_done, cmd2, "DELIVERED")
        command.upgrade(cfg, "head")
        with engine.connect() as c:
            occupies = dict(c.execute(text("SELECT id::text, occupies_table FROM orders")).all())
            assert occupies[paid_pending] is True and occupies[paid_done] is False
            tasks = dict(c.execute(text("SELECT order_item_id::text, status FROM order_item_preparation_tasks")).all())
            assert tasks[pending_item] == "PREPARING" and tasks[done_item] == "READY"
            mirrors = c.execute(text("SELECT count(*) FROM order_item_preparation_tasks WHERE legacy_mirror")).scalar()
            assert mirrors >= 2
            assert not any(r[0] for r in c.execute(text("SELECT tasks_managed FROM order_items")))
        # Re-ejecutar el relleno tras la migración no cambia nada.
        with SessionLocal() as db:
            assert prep.backfill_missing_tasks(db) == 0
    finally:
        command.upgrade(cfg, "head")


# --- I-3: productos de entrega directa pagados ----------------------------------------------------------


def test_paid_direct_item_keeps_order_active_and_blocks_shift_close(admin, mesero, open_shift, menu_lookup):
    order, item = dish(mesero, menu_lookup, "Inca Kola 500ml")
    assert pay(mesero, order["id"], "6.00").status_code == 201
    assert order["id"] in [o["id"] for o in mesero.client.get("/api/v1/orders/active").json()]
    blocked = admin.client.post(f"/api/v1/shifts/{open_shift['id']}/close")
    assert blocked.status_code == 409 and blocked.json()["error"]["code"] == "SHIFT_HAS_OPEN_ORDERS"
    delivered = mesero.client.post(f"/api/v1/orders/{order['id']}/items/{item['id']}/status",
                                   json={"status": "DELIVERED"})
    assert delivered.status_code == 200
    assert order["id"] not in [o["id"] for o in mesero.client.get("/api/v1/orders/active").json()]
    assert admin.client.post(f"/api/v1/shifts/{open_shift['id']}/close").status_code == 200


def test_mixed_order_with_delivered_dish_and_pending_drink_blocks_shift(
    admin, mesero, cocina, menu_lookup, open_shift,
):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [
        {"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}, {"menu_item_id": menu_lookup["Inca Kola 500ml"]["id"]},
    ])
    chicken = next(i for i in command["items"] if i["requires_preparation"])
    base = f"/api/v1/orders/{order['id']}/items/{chicken['id']}/status"
    for status in ("PREPARING", "READY"):
        assert cocina.client.post(base, json={"status": status}).status_code == 200
    assert mesero.client.post(base, json={"status": "DELIVERED"}).status_code == 200
    assert pay(mesero, order["id"], "31.00").status_code == 201
    assert admin.client.post(f"/api/v1/shifts/{open_shift['id']}/close").status_code == 409


# --- I-4: ocupación de mesa -----------------------------------------------------------------------------


def table_status(api, table_id):
    return next(t for t in api.client.get("/api/v1/tables").json() if t["id"] == table_id)["status"]


def test_prepaid_order_keeps_table_occupied_until_everything_is_delivered(mesero, cocina, menu_lookup, open_shift):
    order, item = dish(mesero, menu_lookup)
    assert pay(mesero, order["id"], "25.00").status_code == 201
    assert table_status(mesero, order["table_id"]) == "OPEN"
    second = mesero.client.post("/api/v1/orders", json={"order_type": "DINE_IN", "table_id": order["table_id"],
                                                        "persons_count": 2})
    assert second.status_code == 409 and second.json()["error"]["code"] == "TABLE_ALREADY_OPEN"
    base = f"/api/v1/orders/{order['id']}/items/{item['id']}/status"
    for status in ("PREPARING", "READY"):
        assert cocina.client.post(base, json={"status": status}).status_code == 200
    assert table_status(mesero, order["table_id"]) == "OPEN"  # listo, aún sin entregar
    assert mesero.client.post(base, json={"status": "DELIVERED"}).status_code == 200
    assert table_status(mesero, order["table_id"]) == "FREE"
    assert mesero.client.post("/api/v1/orders", json={"order_type": "DINE_IN", "table_id": order["table_id"],
                                                      "persons_count": 2}).status_code == 201


def test_database_rejects_two_occupying_orders_on_one_table(mesero, open_shift, menu_lookup):
    order, _ = dish(mesero, menu_lookup)
    with SessionLocal() as db:
        original = db.get(Order, order["id"])
        db.add(Order(shift_id=original.shift_id, table_id=original.table_id, order_type="DINE_IN", persons_count=1,
                     created_by_waiter_id=original.created_by_waiter_id, status="OPEN"))
        with pytest.raises(IntegrityError):
            db.commit()


def test_concurrent_openings_of_a_busy_prepaid_table_admit_exactly_one(admin, mesero, open_shift, menu_lookup):
    table = mesero.client.get("/api/v1/tables").json()[0]
    token = _token("mesero1")
    body = {"order_type": "DINE_IN", "table_id": table["id"], "persons_count": 2}
    statuses = _post_requests_concurrently([("/api/v1/orders", body, token)] * 4)
    assert sorted(statuses) == [201, 409, 409, 409]
    with SessionLocal() as db:
        assert db.query(Order).filter(Order.table_id == table["id"], Order.occupies_table.is_(True)).count() == 1


def test_payment_racing_delivery_never_frees_a_table_with_pending_work(admin, mesero, cocina, menu_lookup, open_shift):
    order, item = dish(mesero, menu_lookup)
    for status in ("PREPARING", "READY"):
        cocina.client.post(f"/api/v1/orders/{order['id']}/items/{item['id']}/status", json={"status": status})
    requests = [
        (f"/api/v1/orders/{order['id']}/payments", {"method": "CASH", "amount": "25.00"}, _token("admin")),
        (f"/api/v1/orders/{order['id']}/items/{item['id']}/status", {"status": "DELIVERED"}, _token("mesero1")),
    ]
    assert _post_requests_concurrently(requests) == [201, 200]
    with SessionLocal() as db:
        persisted = db.get(Order, order["id"])
        assert persisted.status == "PAID" and persisted.occupies_table is False  # todo entregado y cobrado


# --- I-5: pedido totalmente cancelado -------------------------------------------------------------------


def test_cancelling_every_item_ends_the_order_and_unblocks_table_and_shift(admin, mesero, open_shift, menu_lookup):
    order, item = dish(mesero, menu_lookup)
    cancel = mesero.client.post(f"/api/v1/orders/{order['id']}/items/{item['id']}/cancel", json={"reason": "x"})
    assert cancel.status_code == 200
    assert cancel.json()["status"] == "CANCELLED"
    billing = mesero.client.get(f"/api/v1/orders/{order['id']}/billing").json()
    assert billing["total"] == "0.00" and billing["status"] == "CANCELLED" and billing["payments"] == []
    assert table_status(mesero, order["table_id"]) == "FREE"
    assert order["id"] not in [o["id"] for o in mesero.client.get("/api/v1/orders/active").json()]
    with SessionLocal() as db:
        persisted = db.get(Order, order["id"])
        assert persisted.closed_at is not None and persisted.paid_amount == 0
        actions = [a.action for a in db.query(AuditLog).filter(AuditLog.entity_id.in_([order["id"], item["id"]]))]
        assert "ORDER_CANCELLED" in actions and "ITEM_CANCELLED" in actions
    assert admin.client.post(f"/api/v1/shifts/{open_shift['id']}/close").status_code == 200


def test_cancelled_order_is_final_and_financially_closed(admin, mesero, open_shift, menu_lookup):
    order, item = dish(mesero, menu_lookup)
    mesero.client.post(f"/api/v1/orders/{order['id']}/items/{item['id']}/cancel", json={})
    assert pay(admin, order["id"], "1.00").status_code == 409
    again = mesero.client.post(f"/api/v1/orders/{order['id']}/commands",
                               json={"items": [{"menu_item_id": menu_lookup["Anticuchos"]["id"]}]})
    assert again.status_code == 409 and again.json()["error"]["code"] == "ORDER_ALREADY_CANCELLED"
    repeated = mesero.client.post(f"/api/v1/orders/{order['id']}/items/{item['id']}/cancel", json={})
    assert repeated.status_code == 409
    assert mesero.client.post("/api/v1/orders", json={"order_type": "DINE_IN", "table_id": order["table_id"],
                                                      "persons_count": 1}).status_code == 201


def test_cancelled_orders_are_not_counted_as_served_and_sales_stay_correct(admin, mesero, open_shift, menu_lookup):
    cancelled, item = dish(mesero, menu_lookup, table_number=1)
    mesero.client.post(f"/api/v1/orders/{cancelled['id']}/items/{item['id']}/cancel", json={})
    served, _ = dish(mesero, menu_lookup, table_number=2)
    assert pay(admin, served["id"], "25.00").status_code == 201
    sales = admin.client.get("/api/v1/reports/current-shift").json()
    assert sales["orders_count"] == 1 and sales["tables_served"] == 1
    assert Decimal(sales["total_sales"]) == Decimal("25.00")


def test_partially_cancelled_and_empty_orders_stay_open(admin, mesero, open_shift, menu_lookup):
    order = create_order(mesero, table_number=1)
    assert mesero.client.get(f"/api/v1/orders/{order['id']}").json()["status"] == "OPEN"  # vacío ≠ cancelado
    command = create_command(mesero, order["id"], [
        {"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}, {"menu_item_id": menu_lookup["Anticuchos"]["id"]},
    ])
    mesero.client.post(f"/api/v1/orders/{order['id']}/items/{command['items'][0]['id']}/cancel", json={})
    assert mesero.client.get(f"/api/v1/orders/{order['id']}").json()["status"] == "OPEN"
    assert admin.client.post(f"/api/v1/shifts/{open_shift['id']}/close").status_code == 409


def test_cannot_cancel_below_paid_so_cancelled_orders_never_hold_money(admin, mesero, open_shift, menu_lookup):
    order, item = dish(mesero, menu_lookup)
    assert pay(admin, order["id"], "10.00").status_code == 201
    response = mesero.client.post(f"/api/v1/orders/{order['id']}/items/{item['id']}/cancel", json={})
    assert response.status_code == 409 and response.json()["error"]["code"] == "TOTAL_BELOW_PAID"
    assert mesero.client.get(f"/api/v1/orders/{order['id']}").json()["status"] != "CANCELLED"


# --- M-1: edición de ítems en tiempo real ---------------------------------------------------------------


def test_editing_quantity_or_notes_publishes_realtime_events(mesero, open_shift, menu_lookup, monkeypatch):
    order, item = dish(mesero, menu_lookup)
    events = []
    monkeypatch.setattr("app.ws.hub.hub.broadcast", lambda e, p, c=None: events.append((e, p, c)))
    response = mesero.client.patch(f"/api/v1/orders/{order['id']}/items/{item['id']}",
                                   json={"quantity": 3, "notes": "sin ají"})
    assert response.status_code == 200 and response.json()["total"] == "75.00"
    by_name = {e[0]: e for e in events}
    assert by_name["order_item.updated"][1]["quantity"] == 3
    assert by_name["order_item.updated"][2] == {"admin", "kitchen", "waiters"}  # solo las áreas del plato
    assert by_name["order.updated"][1]["total"] == "75.00"
