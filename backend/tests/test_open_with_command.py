"""Primera comanda de una mesa: pedido + comanda en una sola transacción, idempotente y sin carreras."""

import uuid

import pytest

from app.db import SessionLocal
from app.models import AuditLog, Command, IdempotencyKey, Order
from tests.conftest import create_order
from tests.test_concurrency import _post_requests_concurrently, _token

PATH = "/api/v1/orders/open-with-command"


def body(table_id, menu_lookup, names=("Pollo a la brasa",), **extra):
    return {"table_id": table_id, "persons_count": 2,
            "items": [{"menu_item_id": menu_lookup[name]["id"], "quantity": 1} for name in names], **extra}


def first_table(api):
    return api.client.get("/api/v1/tables").json()[0]


def counts(table_id):
    with SessionLocal() as db:
        orders = db.query(Order).filter(Order.table_id == table_id).all()
        commands = db.query(Command).filter(Command.order_id.in_([o.id for o in orders])).count() if orders else 0
        return len(orders), commands


def table_status(api, table_id):
    return next(t for t in api.client.get("/api/v1/tables").json() if t["id"] == table_id)["status"]


def test_creates_order_and_first_command_together(mesero, open_shift, menu_lookup, monkeypatch):
    events = []
    monkeypatch.setattr("app.ws.hub.hub.broadcast", lambda e, p, c=None: events.append(e))
    table = first_table(mesero)
    response = mesero.client.post(PATH, json=body(table["id"], menu_lookup, ("Pollo a la brasa", "Inca Kola 500ml")))
    assert response.status_code == 201, response.text
    data = response.json()
    assert data["status"] == "IN_PREPARATION" or data["status"] == "OPEN"
    assert data["table_id"] == table["id"] and data["persons_count"] == 2
    assert data["command"]["order_id"] == data["id"] and data["command"]["sequence_number"] == 1
    assert len(data["command"]["items"]) == 2 and data["total"] == "31.00"
    assert counts(table["id"]) == (1, 1)
    assert table_status(mesero, table["id"]) == "OPEN"
    assert events.count("order.created") == 1 and events.count("command.created") == 1
    assert mesero.client.get(f"/api/v1/orders/{data['id']}").json()["commands"][0]["id"] == data["command"]["id"]


def test_failed_first_command_leaves_no_order_and_the_table_free(
    mesero, admin, open_shift, menu_lookup, monkeypatch,
):
    table = first_table(mesero)
    events = []
    monkeypatch.setattr("app.ws.hub.hub.broadcast", lambda e, p, c=None: events.append(e))
    anticuchos = f"/api/v1/menu/items/{menu_lookup['Anticuchos']['id']}/availability"
    admin.client.patch(anticuchos, json={"status": "SOLD_OUT"})
    events.clear()
    sold_out = mesero.client.post(PATH, json=body(table["id"], menu_lookup, ("Pollo a la brasa", "Anticuchos")))
    assert sold_out.status_code == 409 and sold_out.json()["error"]["code"] == "ITEM_SOLD_OUT"
    assert counts(table["id"]) == (0, 0) and table_status(mesero, table["id"]) == "FREE"
    unknown = body(table["id"], menu_lookup)
    unknown["items"][0]["menu_item_id"] = str(uuid.uuid4())
    assert mesero.client.post(PATH, json=unknown).status_code == 404
    assert counts(table["id"]) == (0, 0)
    assert events == []  # nada se notifica de una operación revertida
    admin.client.patch(anticuchos, json={"status": "AVAILABLE"})


def test_server_failure_between_order_and_command_rolls_everything_back(
    mesero, open_shift, menu_lookup, monkeypatch,
):
    table = first_table(mesero)
    key = str(uuid.uuid4())
    events = []
    monkeypatch.setattr("app.ws.hub.hub.broadcast", lambda e, p, c=None: events.append(e))

    def boom(*args, **kwargs):
        raise RuntimeError("caída del servidor tras crear el pedido")

    original = __import__("app.api.orders", fromlist=["x"])._audit_command
    monkeypatch.setattr("app.api.orders._audit_command", boom)  # falla DESPUÉS de insertar pedido y comanda
    with pytest.raises(RuntimeError):
        mesero.client.post(PATH, json=body(table["id"], menu_lookup, client_operation_id=key))
    assert counts(table["id"]) == (0, 0) and table_status(mesero, table["id"]) == "FREE"
    with SessionLocal() as db:
        assert db.query(IdempotencyKey).filter(IdempotencyKey.key == key).count() == 0  # la clave no queda envenenada
        assert db.query(AuditLog).filter(AuditLog.action.in_(["ORDER_CREATED", "COMMAND_CREATED"])).count() == 0
    assert events == []

    # El servidor se recupera: el MISMO reintento (misma clave) funciona.
    monkeypatch.setattr("app.api.orders._audit_command", original)
    retry = mesero.client.post(PATH, json=body(table["id"], menu_lookup, client_operation_id=key))
    assert retry.status_code == 201 and counts(table["id"]) == (1, 1)


def test_retries_with_the_same_key_never_duplicate(mesero, open_shift, menu_lookup, monkeypatch):
    table = first_table(mesero)
    key = str(uuid.uuid4())
    payload = body(table["id"], menu_lookup, client_operation_id=key)
    first = mesero.client.post(PATH, json=payload)
    lost_response_retry = mesero.client.post(PATH, json=payload)
    header_retry = mesero.client.post(PATH, json={k: v for k, v in payload.items() if k != "client_operation_id"},
                                      headers={"Idempotency-Key": key})
    assert first.status_code == lost_response_retry.status_code == header_retry.status_code == 201
    assert first.json() == lost_response_retry.json() == header_retry.json()
    assert counts(table["id"]) == (1, 1)
    with SessionLocal() as db:
        assert db.query(AuditLog).filter(AuditLog.action == "ORDER_CREATED").count() == 1


def test_same_key_sent_concurrently_creates_one_order(mesero, open_shift, menu_lookup):
    table = first_table(mesero)
    token = _token("mesero1")
    payload = body(table["id"], menu_lookup, client_operation_id=str(uuid.uuid4()))
    statuses = _post_requests_concurrently([(PATH, payload, token)] * 4)
    assert set(statuses) == {201}
    assert counts(table["id"]) == (1, 1)


def test_two_devices_racing_for_the_same_table_one_wins_and_the_other_gets_a_clear_conflict(
    mesero, open_shift, menu_lookup,
):
    table = first_table(mesero)
    token = _token("mesero1")
    requests = [(PATH, body(table["id"], menu_lookup, client_operation_id=str(uuid.uuid4())), token) for _ in range(4)]
    statuses = _post_requests_concurrently(requests)
    assert sorted(statuses) == [201, 409, 409, 409]
    assert counts(table["id"]) == (1, 1)  # ni pedidos ni comandas duplicados
    loser = mesero.client.post(PATH, json=body(table["id"], menu_lookup, client_operation_id=str(uuid.uuid4())))
    error = loser.json()["error"]
    assert loser.status_code == 409 and error["code"] == "TABLE_ALREADY_OPEN"
    assert "ya tiene un pedido abierto" in error["message"]
    assert counts(table["id"]) == (1, 1)


def test_two_different_waiters_racing_the_second_keeps_a_valid_clean_state(admin, mesero, open_shift, menu_lookup):
    table = first_table(mesero)
    statuses = _post_requests_concurrently([
        (PATH, body(table["id"], menu_lookup, client_operation_id=str(uuid.uuid4())), _token("mesero1")),
        (PATH, body(table["id"], menu_lookup, ("Anticuchos",), client_operation_id=str(uuid.uuid4())), _token("admin")),
    ])
    assert sorted(statuses) == [201, 409]
    assert counts(table["id"]) == (1, 1)
    with SessionLocal() as db:
        assert db.query(Order).filter(Order.table_id == table["id"], Order.occupies_table.is_(True)).count() == 1


def test_occupied_table_is_rejected_without_side_effects(mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    response = mesero.client.post(PATH, json=body(order["table_id"], menu_lookup))
    assert response.status_code == 409 and response.json()["error"]["code"] == "TABLE_ALREADY_OPEN"
    assert counts(order["table_id"]) == (1, 0)  # solo el pedido previo, sin comanda nueva


def test_validation_permissions_and_closed_shift(mesero, cocina, open_shift, menu_lookup, admin):
    table = first_table(mesero)
    assert mesero.client.post(PATH, json={**body(table["id"], menu_lookup), "items": []}).status_code == 422
    assert mesero.client.post(PATH, json={**body(table["id"], menu_lookup), "persons_count": 0}).status_code == 422
    duplicated = body(table["id"], menu_lookup, ("Pollo a la brasa", "Pollo a la brasa"))
    assert mesero.client.post(PATH, json=duplicated).status_code == 422
    assert cocina.client.post(PATH, json=body(table["id"], menu_lookup)).status_code == 403
    assert admin.client.post(f"/api/v1/shifts/{open_shift['id']}/close").status_code == 200
    closed = mesero.client.post(PATH, json=body(table["id"], menu_lookup))
    assert closed.status_code == 404 and closed.json()["error"]["code"] == "NO_OPEN_SHIFT"
    assert counts(table["id"]) == (0, 0)


def test_existing_contracts_keep_working(mesero, cocina, open_shift, menu_lookup):
    """POST /orders y POST /orders/{id}/commands (otros flujos) no cambian."""
    order = create_order(mesero, table_number=2)
    command = mesero.client.post(f"/api/v1/orders/{order['id']}/commands",
                                 json={"items": [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}]})
    assert command.status_code == 201 and command.json()["order"]["id"] == order["id"]
    opened = mesero.client.post(PATH, json=body(first_table(mesero)["id"], menu_lookup))
    assert opened.status_code == 201
    # La preparación multiárea y los tableros ven el plato como siempre.
    kitchen = cocina.client.get("/api/v1/preparation/kitchen").json()
    assert sum(len(group["tasks"]) for group in kitchen) == 2
