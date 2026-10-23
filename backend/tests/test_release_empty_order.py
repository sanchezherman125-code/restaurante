"""Una mesa abierta sin pedir no debe dejar un pedido vacío ocupando la mesa ni bloqueando el turno."""

import uuid

from app.db import SessionLocal
from app.models import AuditLog, Order
from tests.conftest import create_command, create_order


def table_status(api, table_id):
    return next(t for t in api.client.get("/api/v1/tables").json() if t["id"] == table_id)["status"]


def cancel(api, order_id, key=None):
    body = {"client_operation_id": key} if key else {}
    return api.client.post(f"/api/v1/orders/{order_id}/cancel", json=body)


def test_empty_order_can_be_released_and_frees_table_and_shift(admin, mesero, open_shift):
    order = create_order(mesero)
    assert table_status(mesero, order["table_id"]) == "OPEN"
    assert admin.client.post(f"/api/v1/shifts/{open_shift['id']}/close").status_code == 409

    response = cancel(mesero, order["id"])
    assert response.status_code == 200
    assert response.json()["status"] == "CANCELLED"
    assert table_status(mesero, order["table_id"]) == "FREE"
    assert order["id"] not in [o["id"] for o in mesero.client.get("/api/v1/orders/active").json()]
    with SessionLocal() as db:
        assert db.get(Order, order["id"]).closed_at is not None
        audits = db.query(AuditLog).filter(AuditLog.action == "ORDER_CANCELLED", AuditLog.entity_id == order["id"])
        assert audits.count() == 1
    # La mesa se puede volver a abrir y el turno se puede cerrar.
    assert mesero.client.post("/api/v1/orders", json={"order_type": "DINE_IN", "table_id": order["table_id"],
                                                      "persons_count": 2}).status_code == 201


def test_release_is_idempotent_and_repeating_is_harmless(mesero, open_shift):
    order = create_order(mesero)
    key = str(uuid.uuid4())
    first = cancel(mesero, order["id"], key)
    replay = cancel(mesero, order["id"], key)
    again = cancel(mesero, order["id"])
    assert first.status_code == replay.status_code == again.status_code == 200
    assert first.json() == replay.json()
    with SessionLocal() as db:
        audits = db.query(AuditLog).filter(AuditLog.action == "ORDER_CANCELLED", AuditLog.entity_id == order["id"])
        assert audits.count() == 1


def test_order_with_products_or_payments_cannot_be_released(admin, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Inca Kola 500ml"]["id"]}])
    response = cancel(mesero, order["id"])
    assert response.status_code == 409 and response.json()["error"]["code"] == "ORDER_NOT_EMPTY"
    payment = admin.client.post(f"/api/v1/orders/{order['id']}/payments", json={"method": "CASH", "amount": "6.00"})
    assert payment.status_code == 201
    paid = cancel(admin, order["id"])
    assert paid.status_code == 409
    assert mesero.client.get(f"/api/v1/orders/{order['id']}").json()["status"] == "PAID"


def test_only_owner_waiter_or_admin_can_release(admin, mesero, cocina, open_shift):
    order = create_order(mesero)
    assert cancel(cocina, order["id"]).status_code == 403
    admin_order = create_order(admin, table_number=2)
    assert cancel(mesero, admin_order["id"]).status_code == 403
    assert cancel(admin, order["id"]).status_code == 200


def test_released_order_rejects_new_commands(mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    assert cancel(mesero, order["id"]).status_code == 200
    response = mesero.client.post(f"/api/v1/orders/{order['id']}/commands",
                                  json={"items": [{"menu_item_id": menu_lookup["Anticuchos"]["id"]}]})
    assert response.status_code == 409 and response.json()["error"]["code"] == "ORDER_ALREADY_CANCELLED"
