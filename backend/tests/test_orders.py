import uuid

from tests.conftest import create_command, create_order


def test_order_requires_persons_for_dine_in(mesero, open_shift, tables):
    response = mesero.client.post(
        "/api/v1/orders",
        json={"order_type": "DINE_IN", "table_id": tables[0]["id"]},
    )
    assert response.status_code == 422


def test_order_requires_table_for_dine_in(mesero, open_shift):
    response = mesero.client.post("/api/v1/orders", json={"order_type": "DINE_IN", "persons_count": 2})
    assert response.status_code == 422


def test_takeaway_order_without_table(mesero, open_shift):
    response = mesero.client.post("/api/v1/orders", json={"order_type": "TAKEAWAY", "notes": "Recoge a las 8"})
    assert response.status_code == 201
    assert response.json()["table_id"] is None


def test_order_without_open_shift_is_rejected(mesero, tables):
    response = mesero.client.post(
        "/api/v1/orders",
        json={"order_type": "DINE_IN", "table_id": tables[0]["id"], "persons_count": 2},
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NO_OPEN_SHIFT"


def test_second_order_on_same_table_conflicts(mesero, open_shift, tables):
    create_order(mesero, table_number=1)
    response = mesero.client.post(
        "/api/v1/orders",
        json={"order_type": "DINE_IN", "table_id": tables[0]["id"], "persons_count": 3},
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "TABLE_ALREADY_OPEN"


def test_order_idempotency(mesero, open_shift, tables):
    key = str(uuid.uuid4())
    payload = {
        "order_type": "DINE_IN",
        "table_id": tables[0]["id"],
        "persons_count": 2,
        "client_operation_id": key,
    }
    first = mesero.client.post("/api/v1/orders", json=payload)
    second = mesero.client.post("/api/v1/orders", json=payload)
    assert first.status_code == 201
    assert second.status_code == 201
    assert first.json()["id"] == second.json()["id"]

    active = mesero.client.get("/api/v1/orders/active").json()
    assert len([o for o in active if o["table_id"] == tables[0]["id"]]) == 1


def test_command_creates_items_with_snapshots_and_areas(mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    command = create_command(
        mesero,
        order["id"],
        [
            {"menu_item_id": menu_lookup["Pollo a la brasa"]["id"], "quantity": 2},
            {"menu_item_id": menu_lookup["Parrilla especial"]["id"], "quantity": 1, "notes": "Término medio"},
            {"menu_item_id": menu_lookup["Inca Kola 500ml"]["id"], "quantity": 3},
        ],
    )
    items = command["items"]
    assert len(items) == 3
    areas = {i["menu_item_name_snapshot"]: i["preparation_area"] for i in items}
    assert areas["Pollo a la brasa"] == "KITCHEN"
    assert areas["Parrilla especial"] == "GRILL"
    assert areas["Inca Kola 500ml"] is None
    assert next(i for i in items if i["menu_item_name_snapshot"] == "Inca Kola 500ml")["requires_preparation"] is False

    total = sum(float(i["unit_price_snapshot"]) * i["quantity"] for i in items)
    assert total == 2 * 25 + 38 + 3 * 6

    detail = mesero.client.get(f"/api/v1/orders/{order['id']}").json()
    assert float(detail["total"]) == total
    assert detail["persons_count"] == 2


def test_commands_have_incremental_sequence(mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    first = create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    second = create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Anticuchos"]["id"]}])
    assert first["sequence_number"] == 1
    assert second["sequence_number"] == 2
    assert first["id"] != second["id"]


def test_command_idempotency_returns_same_command(mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    key = str(uuid.uuid4())
    items = [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"], "quantity": 1}]
    first = create_command(mesero, order["id"], items, client_operation_id=key)
    replay = create_command(mesero, order["id"], items, client_operation_id=key)
    assert first["id"] == replay["id"]
    assert first["sequence_number"] == replay["sequence_number"]

    detail = mesero.client.get(f"/api/v1/orders/{order['id']}").json()
    assert len(detail["commands"]) == 1
    assert len(detail["items"]) == 1


def test_sold_out_item_cannot_be_added(mesero, cocina, open_shift, menu_lookup):
    item = menu_lookup["Anticuchos"]
    cocina.client.patch(f"/api/v1/menu/items/{item['id']}/availability", json={"status": "SOLD_OUT"})
    order = create_order(mesero)
    response = mesero.client.post(
        f"/api/v1/orders/{order['id']}/commands",
        json={"items": [{"menu_item_id": item["id"], "quantity": 1}]},
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "ITEM_SOLD_OUT"


def test_kitchen_only_sees_kitchen_items(cocina, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    create_command(
        mesero,
        order["id"],
        [
            {"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]},
            {"menu_item_id": menu_lookup["Parrilla especial"]["id"]},
            {"menu_item_id": menu_lookup["Inca Kola 500ml"]["id"]},
        ],
    )
    kitchen_view = cocina.client.get("/api/v1/preparation/kitchen").json()
    assert len(kitchen_view) == 1
    assert {i["preparation_area"] for i in kitchen_view[0]["items"]} == {"KITCHEN"}
    assert kitchen_view[0]["other_areas"]["GRILL"] in ("PENDING", "PREPARING", "READY")
    assert cocina.client.get("/api/v1/preparation/grill").status_code == 403


def test_grill_only_sees_grill_items(parrilla, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    create_command(
        mesero,
        order["id"],
        [
            {"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]},
            {"menu_item_id": menu_lookup["Parrilla especial"]["id"]},
        ],
    )
    grill_view = parrilla.client.get("/api/v1/preparation/grill").json()
    assert len(grill_view) == 1
    assert {i["preparation_area"] for i in grill_view[0]["items"]} == {"GRILL"}
    assert parrilla.client.get("/api/v1/preparation/kitchen").status_code == 403


def test_status_flow_and_order_status(mesero, cocina, parrilla, open_shift, menu_lookup):
    order = create_order(mesero)
    command = create_command(
        mesero,
        order["id"],
        [
            {"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]},
            {"menu_item_id": menu_lookup["Parrilla especial"]["id"]},
        ],
    )
    kitchen_item = next(i for i in command["items"] if i["preparation_area"] == "KITCHEN")
    grill_item = next(i for i in command["items"] if i["preparation_area"] == "GRILL")

    started = cocina.client.post(
        f"/api/v1/orders/{order['id']}/items/{kitchen_item['id']}/status",
        json={"status": "PREPARING"},
    )
    assert started.status_code == 200
    assert started.json()["status"] == "IN_PREPARATION"
    started_item = next(i for i in started.json()["items"] if i["id"] == kitchen_item["id"])
    assert started_item["preparation_started_at"] is not None

    ready = cocina.client.post(
        f"/api/v1/orders/{order['id']}/items/{kitchen_item['id']}/status",
        json={"status": "READY"},
    )
    ready_item = next(i for i in ready.json()["items"] if i["id"] == kitchen_item["id"])
    assert ready_item["ready_at"] is not None

    parrilla.client.post(
        f"/api/v1/orders/{order['id']}/items/{grill_item['id']}/status",
        json={"status": "PREPARING"},
    )
    parrilla.client.post(
        f"/api/v1/orders/{order['id']}/items/{grill_item['id']}/status",
        json={"status": "READY"},
    )

    final = mesero.client.get(f"/api/v1/orders/{order['id']}").json()
    assert final["status"] == "READY"

    for item_id in (kitchen_item["id"], grill_item["id"]):
        delivered = mesero.client.post(
            f"/api/v1/orders/{order['id']}/items/{item_id}/status",
            json={"status": "DELIVERED"},
        )
        assert delivered.status_code == 200
    assert mesero.client.get(f"/api/v1/orders/{order['id']}").json()["status"] == "DELIVERED"


def test_direct_and_cancelled_items_do_not_block_order_ready(mesero, cocina, open_shift, menu_lookup):
    order = create_order(mesero)
    command = create_command(
        mesero,
        order["id"],
        [
            {"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]},
            {"menu_item_id": menu_lookup["Anticuchos"]["id"]},
            {"menu_item_id": menu_lookup["Inca Kola 500ml"]["id"]},
        ],
    )
    kitchen_item = next(i for i in command["items"] if i["preparation_area"] == "KITCHEN")
    grill_item = next(i for i in command["items"] if i["preparation_area"] == "GRILL")
    direct_item = next(i for i in command["items"] if not i["requires_preparation"])
    assert direct_item["preparation_area"] is None
    assert direct_item["status"] == "PENDING"

    cancelled = mesero.client.post(
        f"/api/v1/orders/{order['id']}/items/{grill_item['id']}/cancel",
        json={"reason": "No disponible"},
    )
    assert cancelled.status_code == 200
    assert next(i for i in cancelled.json()["items"] if i["id"] == grill_item["id"])["status"] == "CANCELLED"

    for status in ("PREPARING", "READY"):
        response = cocina.client.post(
            f"/api/v1/orders/{order['id']}/items/{kitchen_item['id']}/status",
            json={"status": status},
        )
        assert response.status_code == 200

    final = mesero.client.get(f"/api/v1/orders/{order['id']}").json()
    assert final["status"] == "READY"
    assert next(i for i in final["items"] if i["id"] == direct_item["id"])["status"] == "PENDING"


def test_invalid_transition_rejected(cocina, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    item_id = command["items"][0]["id"]
    response = cocina.client.post(f"/api/v1/orders/{order['id']}/items/{item_id}/status", json={"status": "DELIVERED"})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "INVALID_STATUS_TRANSITION"


def test_item_status_change_is_idempotent(cocina, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    item_id = command["items"][0]["id"]
    key = str(uuid.uuid4())

    first = cocina.client.post(
        f"/api/v1/orders/{order['id']}/items/{item_id}/status",
        json={"status": "PREPARING", "client_operation_id": key},
    )
    replay = cocina.client.post(
        f"/api/v1/orders/{order['id']}/items/{item_id}/status",
        json={"status": "PREPARING", "client_operation_id": key},
    )

    assert first.status_code == replay.status_code == 200
    assert first.json() == replay.json()
    assert next(item for item in replay.json()["items"] if item["id"] == item_id)["status"] == "PREPARING"


def test_order_item_ready_event_includes_table_details(cocina, mesero, open_shift, menu_lookup, monkeypatch):
    order = create_order(mesero, table_number=1)
    command = create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    item_id = command["items"][0]["id"]
    events = []
    monkeypatch.setattr(
        "app.services.orders.hub.broadcast",
        lambda event, payload, channels: events.append((event, payload)),
    )

    cocina.client.post(f"/api/v1/orders/{order['id']}/items/{item_id}/status", json={"status": "PREPARING"})
    ready = cocina.client.post(f"/api/v1/orders/{order['id']}/items/{item_id}/status", json={"status": "READY"})

    assert ready.status_code == 200
    _, payload = next(event for event in events if event[0] == "order_item.ready")
    assert payload["table_name"] == order["table_name"]
    assert payload["table_number"] == order["table_number"]


def test_waiter_cannot_change_kitchen_item(mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    response = mesero.client.post(
        f"/api/v1/orders/{order['id']}/items/{command['items'][0]['id']}/status",
        json={"status": "PREPARING"},
    )
    assert response.status_code == 403


def test_kitchen_cannot_change_grill_item(cocina, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Parrilla especial"]["id"]}])
    response = cocina.client.post(
        f"/api/v1/orders/{order['id']}/items/{command['items'][0]['id']}/status",
        json={"status": "PREPARING"},
    )
    assert response.status_code == 403


def test_kitchen_cannot_cancel_grill_item(cocina, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Parrilla especial"]["id"]}])
    response = cocina.client.post(
        f"/api/v1/orders/{order['id']}/items/{command['items'][0]['id']}/cancel", json={"reason": "x"}
    )
    assert response.status_code == 403


def test_kitchen_cannot_read_order_details(cocina, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    assert cocina.client.get(f"/api/v1/orders/{order['id']}").status_code == 403


def test_cancel_pending_item(mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    item_id = command["items"][0]["id"]
    response = mesero.client.post(
        f"/api/v1/orders/{order['id']}/items/{item_id}/cancel",
        json={"reason": "cliente se arrepintió"},
    )
    assert response.status_code == 200
    item = next(i for i in response.json()["items"] if i["id"] == item_id)
    assert item["status"] == "CANCELLED"
    assert item["cancelled_after_preparation_started"] is False
    assert item["cancellation_reason"] == "cliente se arrepintió"
    assert float(response.json()["total"]) == 0.0


def test_cancel_after_preparation_started(cocina, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    item_id = command["items"][0]["id"]
    cocina.client.post(
        f"/api/v1/orders/{order['id']}/items/{item_id}/status",
        json={"status": "PREPARING"},
    )
    response = cocina.client.post(f"/api/v1/orders/{order['id']}/items/{item_id}/cancel", json={"reason": "se quemó"})
    assert response.status_code == 200
    item = next(i for i in response.json()["items"] if i["id"] == item_id)
    assert item["cancelled_after_preparation_started"] is True


def test_cannot_cancel_ready_item(mesero, cocina, open_shift, menu_lookup):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    item_id = command["items"][0]["id"]
    cocina.client.post(f"/api/v1/orders/{order['id']}/items/{item_id}/status", json={"status": "PREPARING"})
    cocina.client.post(f"/api/v1/orders/{order['id']}/items/{item_id}/status", json={"status": "READY"})
    response = mesero.client.post(f"/api/v1/orders/{order['id']}/items/{item_id}/cancel", json={"reason": "x"})
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "ITEM_NOT_CANCELLABLE"


def test_cancel_is_audited(mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    item_id = command["items"][0]["id"]
    mesero.client.post(f"/api/v1/orders/{order['id']}/items/{item_id}/cancel", json={"reason": "duplicado"})

    from app.db import SessionLocal
    from app.models import AuditLog

    db = SessionLocal()
    try:
        log = db.query(AuditLog).filter(AuditLog.action == "ITEM_CANCELLED", AuditLog.entity_id == item_id).first()
        assert log is not None
        assert log.user_id is not None
        assert log.after_data["reason"] == "duplicado"
    finally:
        db.close()


def test_update_pending_item_quantity(mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    command = create_command(
        mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"], "quantity": 1}]
    )
    item_id = command["items"][0]["id"]
    response = mesero.client.patch(f"/api/v1/orders/{order['id']}/items/{item_id}", json={"quantity": 3})
    assert response.status_code == 200
    item = next(i for i in response.json()["items"] if i["id"] == item_id)
    assert item["quantity"] == 3
    assert float(response.json()["total"]) == 75.0


def test_second_comanda_adds_to_same_order(mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    added = mesero.client.post(
        f"/api/v1/orders/{order['id']}/items",
        json={"items": [{"menu_item_id": menu_lookup["Anticuchos"]["id"], "quantity": 2}]},
    )
    assert added.status_code == 201
    body = added.json()
    assert body["sequence_number"] == 2
    assert len(body["order"]["commands"]) == 2
    assert float(body["order"]["total"]) == 25 + 2 * 18


def test_active_orders_filtered_by_role(mesero, cocina, menu_lookup, open_shift):
    order = create_order(mesero, table_number=1)
    create_command(
        mesero,
        order["id"],
        [
            {"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]},
            {"menu_item_id": menu_lookup["Parrilla especial"]["id"]},
        ],
    )
    kitchen_only = create_order(mesero, table_number=2)
    create_command(mesero, kitchen_only["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])

    waiter_orders = mesero.client.get("/api/v1/orders/active").json()
    assert {o["id"] for o in waiter_orders} == {order["id"], kitchen_only["id"]}

    assert cocina.client.get("/api/v1/orders/active?area=KITCHEN").status_code == 403
    assert cocina.client.get("/api/v1/orders/active?area=GRILL").status_code == 403
