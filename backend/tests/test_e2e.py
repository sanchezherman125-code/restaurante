"""Escenarios E2E obligatorios (spec §73 y §74)."""

import uuid
from contextlib import contextmanager

from app.db import SessionLocal
from app.models import Command, Order
from tests.conftest import create_command, create_order


def test_flujo_principal_completo(admin, mesero, cocina, parrilla, menu_lookup, tables):
    # 1. ADMIN abre turno
    shift = admin.client.post("/api/v1/shifts/open").json()
    assert shift["status"] == "OPEN"

    mesa = next(t for t in tables if t["number"] == 4)

    # 2-3. MESERO abre Mesa 4 con 3 personas
    order = mesero.client.post(
        "/api/v1/orders",
        json={
            "order_type": "DINE_IN",
            "table_id": mesa["id"],
            "persons_count": 3,
            "client_operation_id": str(uuid.uuid4()),
        },
    )
    assert order.status_code == 201, order.text
    order = order.json()
    assert order["persons_count"] == 3
    assert order["created_by_waiter_name"] == "Ana Mesera"

    # 4-5. agrega producto de cocina, parrilla y bebida y envía comanda
    command = create_command(
        mesero,
        order["id"],
        [
            {"menu_item_id": menu_lookup["Pollo a la brasa"]["id"], "quantity": 1},
            {"menu_item_id": menu_lookup["Parrilla especial"]["id"], "quantity": 1, "notes": "Término medio"},
            {"menu_item_id": menu_lookup["Inca Kola 500ml"]["id"], "quantity": 2},
        ],
        client_operation_id=str(uuid.uuid4()),
        notes="Cliente apurado",
    )
    assert command["sequence_number"] == 1

    # 6-7. cocinas reciben su parte
    kitchen_view = cocina.client.get("/api/v1/preparation/kitchen").json()
    grill_view = parrilla.client.get("/api/v1/preparation/grill").json()
    assert len(kitchen_view) == 1 and len(grill_view) == 1
    kitchen_item = kitchen_view[0]["items"][0]
    grill_item = grill_view[0]["items"][0]
    assert kitchen_item["menu_item_name_snapshot"] == "Pollo a la brasa"
    assert grill_item["menu_item_name_snapshot"] == "Parrilla especial"
    assert grill_item["notes"] == "Término medio"
    assert kitchen_view[0]["table_number"] == 4
    assert kitchen_view[0]["waiter_name"] == "Ana Mesera"

    # 8. ambos comienzan preparación
    for api, item in ((cocina, kitchen_item), (parrilla, grill_item)):
        response = api.client.post(
            f"/api/v1/orders/{order['id']}/items/{item['id']}/status",
            json={"status": "PREPARING"},
        )
        assert response.status_code == 200
        assert response.json()["status"] == "IN_PREPARATION"

    # 9. ambos marcan READY
    for api, item in ((cocina, kitchen_item), (parrilla, grill_item)):
        response = api.client.post(
            f"/api/v1/orders/{order['id']}/items/{item['id']}/status",
            json={"status": "READY"},
        )
        assert response.status_code == 200

    # 10. MESERO recibe aviso (evento listo) y ve el pedido READY
    detail = mesero.client.get(f"/api/v1/orders/{order['id']}").json()
    assert detail["status"] == "READY"

    # 11. MESERO marca entrega de todo
    for item in detail["items"]:
        response = mesero.client.post(
            f"/api/v1/orders/{order['id']}/items/{item['id']}/status",
            json={"status": "DELIVERED"},
        )
        assert response.status_code == 200, response.text

    # 12-13. ADMIN divide cuenta y registra pago
    billing = admin.client.get(f"/api/v1/orders/{order['id']}/billing").json()
    pollo_line = next(i for i in billing["items"] if i["name"] == "Pollo a la brasa")
    split = admin.client.post(
        f"/api/v1/orders/{order['id']}/splits",
        json={
            "split_type": "BY_ITEMS",
            "label": "Persona A",
            "items": [{"order_item_id": pollo_line["order_item_id"], "quantity": 1}],
        },
    )
    assert split.status_code == 201, split.text

    remaining = float(billing["pending_amount"]) - float(split.json()["amount"])
    split2 = admin.client.post(
        f"/api/v1/orders/{order['id']}/splits",
        json={"split_type": "BY_AMOUNT", "label": "Resto", "amount": f"{remaining:.2f}"},
    )
    assert split2.status_code == 201, split2.text

    payment = admin.client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={"method": "YAPE", "amount": str(billing["total"]), "client_operation_id": str(uuid.uuid4())},
    )
    assert payment.status_code == 201, payment.text
    assert payment.json()["became_paid"] is True

    # 14. pedido PAID
    detail = mesero.client.get(f"/api/v1/orders/{order['id']}").json()
    assert detail["status"] == "PAID"

    # 15-16. ADMIN cierra turno y el reporte contiene la venta
    closed = admin.client.post(f"/api/v1/shifts/{shift['id']}/close")
    assert closed.status_code == 200, closed.text
    snapshot = closed.json()["snapshot"]
    assert float(snapshot["total_sales"]) == float(billing["total"])
    assert snapshot["orders_count"] == 1
    assert snapshot["persons_served"] == 3

    report = admin.client.get(f"/api/v1/reports/shifts/{shift['id']}").json()
    assert float(report["sales"]["total_sales"]) == float(billing["total"])
    product_names = [line["name"] for line in report["products"]["lines"]]
    assert "Pollo a la brasa" in product_names
    assert "Parrilla especial" in product_names

    history = admin.client.get("/api/v1/shifts/history").json()
    assert len(history) == 1


def test_flujo_offline_idempotencia(admin, mesero, cocina, menu_lookup, tables):
    """§74: pérdida de conexión + reintentos => exactamente una comanda."""
    admin.client.post("/api/v1/shifts/open")
    order = create_order(mesero, table_number=4, persons=2)
    operation_id = str(uuid.uuid4())
    items = [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"], "quantity": 2}]

    # el dispositivo sin conexión deja la operación en cola y reintenta varias veces
    for _ in range(4):
        response = mesero.client.post(
            f"/api/v1/orders/{order['id']}/commands",
            json={"items": items, "client_operation_id": operation_id},
        )
        assert response.status_code == 201, response.text

    db = SessionLocal()
    try:
        commands = db.query(Command).filter(Command.order_id == order["id"]).all()
        assert len(commands) == 1
        orders = db.query(Order).filter(Order.id == order["id"]).all()
        assert len(orders) == 1
        stored = db.query(Command).filter(Command.client_operation_id == uuid.UUID(operation_id)).first()
        assert stored is not None
    finally:
        db.close()

    # al reconectar, la resincronización REST devuelve exactamente una comanda
    active = mesero.client.get("/api/v1/orders/active").json()
    order_active = next(o for o in active if o["id"] == order["id"])
    assert len(order_active["commands"]) == 1
    assert len(order_active["items"]) == 1
    assert order_active["items"][0]["quantity"] == 2

    kitchen_view = cocina.client.get("/api/v1/preparation/kitchen").json()
    assert len(kitchen_view) == 1
    assert len(kitchen_view[0]["items"]) == 1
    assert kitchen_view[0]["items"][0]["quantity"] == 2

    # repetir la misma operación de pago tampoco duplica
    key = str(uuid.uuid4())
    for _ in range(2):
        pay = admin.client.post(
            f"/api/v1/orders/{order['id']}/payments",
            json={"method": "CASH", "amount": "50.00", "client_operation_id": key},
        )
        assert pay.status_code == 201
    payments = admin.client.get(f"/api/v1/orders/{order['id']}/payments").json()
    assert len(payments) == 1


def test_eventos_websocket(admin, mesero, cocina, menu_lookup):
    admin.client.post("/api/v1/shifts/open")
    order = create_order(mesero, table_number=1, persons=2)

    with client_session(mesero) as ws:
        first = ws.receive_json()
        assert first["event"] == "connection.ready"
        assert "waiters" in first["data"]["channels"]

        create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
        event = ws.receive_json()
        assert event["event"] in {"command.created", "order.updated"}


@contextmanager
def client_session(api):
    token = api.client.headers["Authorization"].split(" ")[1]
    with api.client.websocket_connect("/api/v1/ws") as session:
        session.send_json({"type": "auth", "token": token})
        yield session
