"""Regresiones de la estabilización V1: gastos y neto, filtros de reportes, mesas ocupadas y carta."""

import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime
from decimal import Decimal

from fastapi.testclient import TestClient

from app.db import SessionLocal
from app.main import app
from app.models import MenuCategory, Order, RestaurantTable, Shift
from tests.conftest import create_command, create_order
from tests.test_shifts_reports import _create_paid_order


def _expense(api, amount: str, description: str = "Compra") -> dict:
    response = api.client.post(
        "/api/v1/expenses",
        json={"amount": amount, "description": description, "client_operation_id": str(uuid.uuid4())},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _sales(api, **params) -> dict:
    response = api.client.get("/api/v1/reports/sales", params=params)
    assert response.status_code == 200, response.text
    return response.json()


def _current(api) -> dict:
    response = api.client.get("/api/v1/reports/current-shift")
    assert response.status_code == 200, response.text
    return response.json()


def _close(admin, shift_id: str) -> None:
    response = admin.client.post(f"/api/v1/shifts/{shift_id}/close")
    assert response.status_code == 200, response.text


def _set_opened_at(shift_id: str, opened_at: datetime) -> None:
    db = SessionLocal()
    try:
        db.get(Shift, uuid.UUID(shift_id)).opened_at = opened_at
        db.commit()
    finally:
        db.close()


# --- P0-03: gastos y resultado neto -------------------------------------------------------------


def test_shift_without_orders_and_without_expenses_reports_zero(admin, open_shift):
    for report in (_current(admin), _sales(admin)):
        assert Decimal(report["total_sales"]) == 0
        assert Decimal(report["total_expenses"]) == 0
        assert Decimal(report["net_result"]) == 0
        assert report["orders_count"] == 0


def test_expense_without_orders_produces_negative_net(admin, open_shift):
    _expense(admin, "80.00")
    for report in (_current(admin), _sales(admin)):
        assert report["total_sales"] == "0.00"
        assert report["total_expenses"] == "80.00"
        assert report["net_result"] == "-80.00"


def test_sales_and_expenses_from_different_users(admin, mesero, cocina, parrilla, open_shift, menu_lookup):
    _create_paid_order(admin, cocina, parrilla, mesero, menu_lookup, table_number=1)  # S/ 25.00
    _expense(mesero, "10.50", "Hielo")
    _expense(cocina, "4.25", "Limones")
    _expense(admin, "0.10", "Bolsa")
    report = _current(admin)
    assert report["total_sales"] == "25.00"
    assert report["total_expenses"] == "14.85"
    assert report["net_result"] == "10.15"


def test_consecutive_shifts_keep_expenses_separate(admin, mesero, cocina, parrilla, open_shift, menu_lookup):
    _create_paid_order(admin, cocina, parrilla, mesero, menu_lookup, table_number=1)
    _expense(admin, "5.00")
    _close(admin, open_shift["id"])

    second = admin.client.post("/api/v1/shifts/open").json()
    _expense(admin, "80.00")
    current = _current(admin)
    assert (current["total_sales"], current["total_expenses"], current["net_result"]) == ("0.00", "80.00", "-80.00")

    # Consulta histórica de un turno cerrado, por filtro y por su reporte completo.
    first = _sales(admin, shift_id=open_shift["id"])
    assert (first["total_sales"], first["total_expenses"], first["net_result"]) == ("25.00", "5.00", "20.00")
    detail = admin.client.get(f"/api/v1/reports/shifts/{open_shift['id']}").json()
    assert detail["sales"]["total_expenses"] == "5.00"
    assert detail["sales"]["net_result"] == "20.00"
    assert _sales(admin, shift_id=second["id"])["net_result"] == "-80.00"


def test_closed_shift_without_open_one_reports_last_shift(admin, open_shift):
    _expense(admin, "12.00")
    _close(admin, open_shift["id"])
    report = _current(admin)
    assert report["total_expenses"] == "12.00"
    assert report["net_result"] == "-12.00"


# --- P0-04: filtros de reportes -----------------------------------------------------------------


def test_scope_all_includes_every_shift(admin, mesero, cocina, parrilla, open_shift, menu_lookup):
    _create_paid_order(admin, cocina, parrilla, mesero, menu_lookup, table_number=1)  # 25.00
    _expense(admin, "5.00")
    _close(admin, open_shift["id"])
    admin.client.post("/api/v1/shifts/open")
    _create_paid_order(admin, cocina, parrilla, mesero, menu_lookup, table_number=2)  # 25.00
    _expense(admin, "80.00")
    admin.client.post("/api/v1/shifts/open")  # turno abierto sigue siendo el segundo (409)

    everything = _sales(admin, scope="all")
    assert everything["total_sales"] == "50.00"
    assert everything["total_expenses"] == "85.00"
    assert everything["net_result"] == "-35.00"
    assert everything["orders_count"] == 2

    products = admin.client.get("/api/v1/reports/products", params={"scope": "all"}).json()
    assert products["total_items_sold"] == 2
    preparation = admin.client.get("/api/v1/reports/preparation", params={"scope": "all"}).json()
    assert sum(line["items_measured"] for line in preparation["lines"]) == 2

    # Sin parámetros se conserva el comportamiento anterior: solo el turno actual.
    default = _sales(admin)
    assert (default["total_sales"], default["total_expenses"]) == ("25.00", "80.00")
    assert _sales(admin, scope="current") == default


def test_invalid_scope_is_rejected(admin, open_shift):
    assert admin.client.get("/api/v1/reports/sales", params={"scope": "everything"}).status_code == 422


def test_date_filters_use_peru_local_day(admin, open_shift):
    # 23:30 del 14/10 en Lima = 04:30 UTC del 15/10: el turno pertenece al 14 (día local de apertura).
    _set_opened_at(open_shift["id"], datetime(2026, 10, 15, 4, 30, tzinfo=UTC))
    _expense(admin, "80.00")

    assert _sales(admin, date_from="2026-10-14", date_to="2026-10-14")["total_expenses"] == "80.00"
    assert _sales(admin, date_from="2026-10-15", date_to="2026-10-15")["total_expenses"] == "0.00"
    assert _sales(admin, date_from="2026-10-01", date_to="2026-10-31")["total_expenses"] == "80.00"
    assert _sales(admin, date_from="2026-10-14")["total_expenses"] == "80.00"
    assert _sales(admin, date_to="2026-10-13")["total_expenses"] == "0.00"


def test_date_filter_end_of_local_day_boundary(admin, open_shift):
    # 23:59:59 en Lima del 14/10 (04:59:59 UTC del 15) sigue siendo el 14; 00:00 del 15 en Lima ya no.
    _set_opened_at(open_shift["id"], datetime(2026, 10, 15, 4, 59, 59, tzinfo=UTC))
    _expense(admin, "1.00")
    assert _sales(admin, date_from="2026-10-14", date_to="2026-10-14")["total_expenses"] == "1.00"
    _set_opened_at(open_shift["id"], datetime(2026, 10, 15, 5, 0, 0, tzinfo=UTC))
    assert _sales(admin, date_from="2026-10-14", date_to="2026-10-14")["total_expenses"] == "0.00"
    assert _sales(admin, date_from="2026-10-15", date_to="2026-10-15")["total_expenses"] == "1.00"


def test_shift_history_uses_same_local_day(admin, open_shift):
    _close(admin, open_shift["id"])
    _set_opened_at(open_shift["id"], datetime(2026, 10, 15, 4, 30, tzinfo=UTC))
    day14 = admin.client.get("/api/v1/shifts/history", params={"date_from": "2026-10-14", "date_to": "2026-10-14"})
    assert [s["id"] for s in day14.json()] == [open_shift["id"]]
    day15 = admin.client.get("/api/v1/shifts/history", params={"date_from": "2026-10-15", "date_to": "2026-10-15"})
    assert day15.json() == []


# --- P0-05: mesas ocupadas ----------------------------------------------------------------------


def _table(api, number: int) -> dict:
    return next(t for t in api.client.get("/api/v1/tables").json() if t["number"] == number)


def test_free_table_can_be_deactivated(admin, open_shift):
    table = _table(admin, 3)
    response = admin.client.patch(f"/api/v1/tables/{table['id']}", json={"is_active": False})
    assert response.status_code == 200
    assert response.json()["is_active"] is False


def test_occupied_table_cannot_be_deactivated(admin, mesero, open_shift, menu_lookup):
    order = create_order(mesero, table_number=1)
    create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    table = _table(admin, 1)
    response = admin.client.patch(f"/api/v1/tables/{table['id']}", json={"is_active": False})
    assert response.status_code == 409
    body = response.json()["error"]
    assert body["code"] == "TABLE_OCCUPIED"
    assert body["details"]["order_id"] == order["id"]

    after = _table(admin, 1)
    assert after["is_active"] is True and after["order_id"] == order["id"]
    detail = mesero.client.get(f"/api/v1/orders/{order['id']}").json()
    assert detail["status"] == "OPEN" and len(detail["items"]) == 1
    # Otros cambios de la mesa ocupada siguen permitidos.
    assert admin.client.patch(f"/api/v1/tables/{table['id']}", json={"name": "Mesa Uno"}).status_code == 200


def test_paid_table_with_pending_work_stays_occupied(admin, mesero, open_shift, menu_lookup):
    order = create_order(mesero, table_number=2)
    create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    pay = admin.client.post(f"/api/v1/orders/{order['id']}/payments", json={"method": "CASH", "amount": "25.00"})
    assert pay.status_code == 201, pay.text
    table = _table(admin, 2)
    response = admin.client.patch(f"/api/v1/tables/{table['id']}", json={"is_active": False})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "TABLE_OCCUPIED"


def test_inactive_table_rejects_new_orders(admin, mesero, open_shift, menu_lookup):
    table = _table(admin, 4)
    admin.client.patch(f"/api/v1/tables/{table['id']}", json={"is_active": False})
    response = mesero.client.post(
        "/api/v1/orders/open-with-command",
        json={"table_id": table["id"], "persons_count": 2,
              "items": [{"menu_item_id": menu_lookup["Inca Kola 500ml"]["id"]}]},
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "TABLE_INACTIVE"
    legacy = mesero.client.post(
        "/api/v1/orders", json={"order_type": "DINE_IN", "table_id": table["id"], "persons_count": 2}
    )
    assert legacy.status_code == 409
    db = SessionLocal()
    try:
        assert db.query(Order).filter(Order.table_id == uuid.UUID(table["id"])).count() == 0
    finally:
        db.close()


def test_order_of_previously_inconsistent_table_stays_accessible(admin, mesero, open_shift, menu_lookup):
    order = create_order(mesero, table_number=5)
    create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Inca Kola 500ml"]["id"]}])
    db = SessionLocal()
    try:  # estado heredado de la versión anterior: mesa inactiva con pedido vivo
        db.query(RestaurantTable).filter(RestaurantTable.number == 5).update({"is_active": False})
        db.commit()
    finally:
        db.close()
    table = _table(mesero, 5)
    assert table["is_active"] is False and table["status"] == "OPEN" and table["order_id"] == order["id"]
    assert any(o["id"] == order["id"] for o in mesero.client.get("/api/v1/orders/active").json())
    item = mesero.client.get(f"/api/v1/orders/{order['id']}").json()["items"][0]
    delivered = mesero.client.post(
        f"/api/v1/orders/{order['id']}/items/{item['id']}/status", json={"status": "DELIVERED"}
    )
    assert delivered.status_code == 200, delivered.text


def _token(username: str) -> str:
    with TestClient(app) as client:
        return client.post("/api/v1/auth/login", json={"username": username, "pin": "1234"}).json()["access_token"]


def test_concurrent_open_and_deactivate_never_leave_order_on_inactive_table(admin, mesero, open_shift, menu_lookup):
    waiter_token, admin_token = _token("mesero1"), _token("admin")
    drink = menu_lookup["Agua mineral"]["id"]
    for _ in range(4):
        table = _table(admin, 3)
        barrier = threading.Barrier(2)

        def open_table(table_id=table["id"], barrier=barrier) -> int:
            with TestClient(app) as client:
                client.headers["Authorization"] = f"Bearer {waiter_token}"
                barrier.wait(timeout=10)
                return client.post(
                    "/api/v1/orders/open-with-command",
                    json={"table_id": table_id, "persons_count": 1, "items": [{"menu_item_id": drink}]},
                ).status_code

        def deactivate(table_id=table["id"], barrier=barrier) -> int:
            with TestClient(app) as client:
                client.headers["Authorization"] = f"Bearer {admin_token}"
                barrier.wait(timeout=10)
                return client.patch(f"/api/v1/tables/{table_id}", json={"is_active": False}).status_code

        with ThreadPoolExecutor(max_workers=2) as pool:
            opened, deactivated = pool.submit(open_table), pool.submit(deactivate)
            statuses = (opened.result(), deactivated.result())
        assert statuses in {(201, 409), (409, 200)}, statuses

        db = SessionLocal()
        try:
            row = db.get(RestaurantTable, uuid.UUID(table["id"]))
            live = db.query(Order).filter(Order.table_id == row.id, Order.occupies_table.is_(True)).all()
            assert row.is_active is (statuses[0] == 201)
            assert len(live) == (1 if statuses[0] == 201 else 0)
            # Deja la mesa libre y activa para la siguiente ronda.
            for order in live:
                for item in order.items:
                    item.status = "DELIVERED"
                order.status = "CANCELLED"
            row.is_active = True
            db.commit()
        finally:
            db.close()


# --- P1-03: carta y disponibilidad --------------------------------------------------------------


def _deactivate_category(name: str) -> None:
    db = SessionLocal()
    try:
        db.query(MenuCategory).filter(MenuCategory.name == name).update({"is_active": False})
        db.commit()
    finally:
        db.close()


def test_items_of_inactive_category_leave_menu_and_cannot_be_ordered(admin, mesero, open_shift, menu_lookup):
    _deactivate_category("Bebidas")
    menu = mesero.client.get("/api/v1/menu").json()
    assert "Bebidas" not in {c["name"] for c in menu["categories"]}
    assert "Inca Kola 500ml" not in {i["name"] for i in menu["items"]}

    order = create_order(mesero, table_number=1)
    drink = menu_lookup["Inca Kola 500ml"]["id"]
    response = mesero.client.post(f"/api/v1/orders/{order['id']}/commands", json={"items": [{"menu_item_id": drink}]})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "MENU_ITEM_NOT_FOUND"


def test_admin_can_list_inactive_menu_to_reactivate(admin, mesero, menu_lookup):
    _deactivate_category("Bebidas")
    item_id = menu_lookup["Causa limeña"]["id"]
    assert admin.client.patch(f"/api/v1/menu/items/{item_id}", json={"is_active": False}).status_code == 200

    full = admin.client.get("/api/v1/menu", params={"include_inactive": "true"}).json()
    assert "Bebidas" in {c["name"] for c in full["categories"]}
    assert {"Inca Kola 500ml", "Causa limeña"} <= {i["name"] for i in full["items"]}
    assert "Causa limeña" not in {i["name"] for i in admin.client.get("/api/v1/menu").json()["items"]}
    assert mesero.client.get("/api/v1/menu", params={"include_inactive": "true"}).status_code == 403


def test_sold_out_during_cart_preparation_is_rejected_without_partial_order(
    admin, mesero, cocina, open_shift, menu_lookup, tables
):
    item = menu_lookup["Causa limeña"]
    sold_out = cocina.client.patch(f"/api/v1/menu/items/{item['id']}/availability", json={"status": "SOLD_OUT"})
    assert sold_out.status_code == 200
    table = next(t for t in tables if t["number"] == 2)
    response = mesero.client.post(
        "/api/v1/orders/open-with-command",
        json={"table_id": table["id"], "persons_count": 2, "items": [{"menu_item_id": item["id"]}]},
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "ITEM_SOLD_OUT"
    assert _table(mesero, 2)["status"] == "FREE"


def test_category_change_and_expense_notify_other_devices(admin, mesero, open_shift, monkeypatch):
    from app.ws import hub as hub_module

    sent: list[tuple[str, set | None]] = []
    original = hub_module.hub.broadcast
    monkeypatch.setattr(hub_module.hub, "broadcast", lambda event, payload, channels=None: (
        sent.append((event, channels)), original(event, payload, channels)))
    category = admin.client.get("/api/v1/menu/categories").json()[0]
    admin.client.patch(f"/api/v1/menu/categories/{category['id']}", json={"is_active": False})
    _expense(mesero, "3.00")
    events = [event for event, _ in sent]
    assert "menu.changed" in events
    assert ("expense.created", {"admin"}) in sent
