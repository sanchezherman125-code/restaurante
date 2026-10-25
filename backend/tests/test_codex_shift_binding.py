"""Hallazgos Codex 3 y 4: operaciones offline ligadas a su turno e idempotencia después del cierre."""

import uuid

from app.db import SessionLocal
from app.models import Command, Expense, Order


def _close(admin, shift_id: str) -> None:
    response = admin.client.post(f"/api/v1/shifts/{shift_id}/close")
    assert response.status_code == 200, response.text


def _open(admin) -> dict:
    response = admin.client.post("/api/v1/shifts/open")
    assert response.status_code == 201, response.text
    return response.json()


def _table_id(api, number: int) -> str:
    return next(t["id"] for t in api.client.get("/api/v1/tables").json() if t["number"] == number)


def _sales(admin, shift_id: str) -> dict:
    return admin.client.get("/api/v1/reports/sales", params={"shift_id": shift_id}).json()


def _counts() -> tuple[int, int, int]:
    db = SessionLocal()
    try:
        return db.query(Expense).count(), db.query(Order).count(), db.query(Command).count()
    finally:
        db.close()


# --- Hallazgo 3 ---------------------------------------------------------------------------------


def test_operations_queued_in_closed_shift_are_not_moved_to_the_next(admin, mesero, open_shift, menu_lookup):
    shift_a = open_shift["id"]
    # Operaciones generadas en el turno A que quedaron en la cola sin enviarse.
    expense = {
        "amount": "80.00", "description": "Carbón", "shift_id": shift_a, "client_operation_id": str(uuid.uuid4()),
    }
    first_command = {
        "table_id": _table_id(mesero, 1), "persons_count": 2, "shift_id": shift_a,
        "items": [{"menu_item_id": menu_lookup["Inca Kola 500ml"]["id"]}], "client_operation_id": str(uuid.uuid4()),
    }
    _close(admin, shift_a)
    shift_b = _open(admin)["id"]

    for path, body in (("/api/v1/expenses", expense), ("/api/v1/orders/open-with-command", first_command)):
        response = mesero.client.post(path, json=body)
        assert response.status_code == 409, response.text
        error = response.json()["error"]
        assert error["code"] == "SHIFT_MISMATCH"
        assert error["details"] == {"origin_shift_id": shift_a, "current_shift_id": shift_b}
        # El mismo UUID sigue rechazándose: el conflicto no se convierte en registro al reintentar.
        assert mesero.client.post(path, json=body).json()["error"]["code"] == "SHIFT_MISMATCH"

    assert _counts() == (0, 0, 0)
    for shift_id in (shift_a, shift_b):
        report = _sales(admin, shift_id)
        assert (report["total_sales"], report["total_expenses"], report["orders_count"]) == ("0.00", "0.00", 0)


def test_operation_without_open_shift_is_rejected_and_not_registered(admin, mesero, open_shift):
    _close(admin, open_shift["id"])
    response = mesero.client.post(
        "/api/v1/expenses",
        json={"amount": "5.00", "description": "x", "shift_id": open_shift["id"],
              "client_operation_id": str(uuid.uuid4())},
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NO_OPEN_SHIFT"
    assert _counts() == (0, 0, 0)


def test_operations_of_the_current_shift_and_legacy_clients_are_accepted(admin, mesero, open_shift, menu_lookup):
    shift = open_shift["id"]
    tagged = mesero.client.post("/api/v1/expenses", json={"amount": "1.00", "description": "a", "shift_id": shift})
    legacy = mesero.client.post("/api/v1/expenses", json={"amount": "2.00", "description": "b"})
    assert (tagged.status_code, legacy.status_code) == (201, 201)
    assert tagged.json()["shift_id"] == legacy.json()["shift_id"] == shift

    opened = mesero.client.post("/api/v1/orders/open-with-command", json={
        "table_id": _table_id(mesero, 2), "persons_count": 1, "shift_id": shift,
        "items": [{"menu_item_id": menu_lookup["Agua mineral"]["id"]}],
    })
    assert opened.status_code == 201, opened.text
    assert opened.json()["shift_id"] == shift


def test_command_tagged_with_another_shift_is_rejected(admin, mesero, open_shift, menu_lookup):
    order = mesero.client.post("/api/v1/orders/open-with-command", json={
        "table_id": _table_id(mesero, 3), "persons_count": 1,
        "items": [{"menu_item_id": menu_lookup["Agua mineral"]["id"]}],
    }).json()
    response = mesero.client.post(f"/api/v1/orders/{order['id']}/commands", json={
        "items": [{"menu_item_id": menu_lookup["Inca Kola 500ml"]["id"]}], "shift_id": str(uuid.uuid4()),
    })
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "SHIFT_MISMATCH"
    assert len(mesero.client.get(f"/api/v1/orders/{order['id']}").json()["commands"]) == 1


# --- Hallazgo 4 ---------------------------------------------------------------------------------


def test_expense_response_can_be_recovered_after_shift_closed(admin, mesero, open_shift):
    key = str(uuid.uuid4())
    body = {"amount": "80.00", "description": "Carbón", "shift_id": open_shift["id"], "client_operation_id": key}
    first = mesero.client.post("/api/v1/expenses", json=body)
    assert first.status_code == 201  # la respuesta "se pierde" en el cliente
    _close(admin, open_shift["id"])

    replay = mesero.client.post("/api/v1/expenses", json=body)
    assert replay.status_code == 201, replay.text
    assert replay.json() == first.json()
    assert _counts()[0] == 1
    assert _sales(admin, open_shift["id"])["total_expenses"] == "80.00"


def test_recovering_a_response_does_not_open_the_door_to_new_or_foreign_operations(admin, mesero, cocina, open_shift):
    key = str(uuid.uuid4())
    body = {"amount": "10.00", "description": "Hielo", "client_operation_id": key}
    assert mesero.client.post("/api/v1/expenses", json=body).status_code == 201
    _close(admin, open_shift["id"])

    foreign = cocina.client.post("/api/v1/expenses", json=body)  # mismo UUID, otro usuario
    assert foreign.status_code == 409
    assert foreign.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"
    fresh = mesero.client.post("/api/v1/expenses", json={**body, "client_operation_id": str(uuid.uuid4())})
    assert fresh.status_code == 404
    assert fresh.json()["error"]["code"] == "NO_OPEN_SHIFT"
    anonymous = mesero.client.post("/api/v1/expenses", json=body, headers={"Authorization": "Bearer invalido"})
    assert anonymous.status_code == 401
    assert _counts()[0] == 1


def test_first_command_response_can_be_recovered_after_shift_closed(admin, mesero, open_shift, menu_lookup):
    key = str(uuid.uuid4())
    body = {
        "table_id": _table_id(mesero, 4), "persons_count": 1, "shift_id": open_shift["id"],
        "items": [{"menu_item_id": menu_lookup["Agua mineral"]["id"]}], "client_operation_id": key,
    }
    first = mesero.client.post("/api/v1/orders/open-with-command", json=body)
    assert first.status_code == 201
    order = first.json()
    item = order["items"][0]
    assert mesero.client.post(
        f"/api/v1/orders/{order['id']}/items/{item['id']}/status", json={"status": "DELIVERED"}
    ).status_code == 200
    assert admin.client.post(
        f"/api/v1/orders/{order['id']}/payments", json={"method": "CASH", "amount": "5.00"}
    ).status_code == 201
    _close(admin, open_shift["id"])

    replay = mesero.client.post("/api/v1/orders/open-with-command", json=body)
    assert replay.status_code == 201, replay.text
    assert replay.json()["id"] == order["id"]
    assert _counts()[1:] == (1, 1)
