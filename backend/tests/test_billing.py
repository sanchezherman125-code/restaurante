import uuid

from tests.conftest import create_command, create_order


def _pay(api, order_id: str, amount: str, method: str = "CASH", **extra):
    return api.client.post(
        f"/api/v1/orders/{order_id}/payments",
        json={"method": method, "amount": amount, **extra},
    )


def test_billing_view(mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    create_command(
        mesero,
        order["id"],
        [
            {"menu_item_id": menu_lookup["Pollo a la brasa"]["id"], "quantity": 2},
            {"menu_item_id": menu_lookup["Inca Kola 500ml"]["id"], "quantity": 1},
        ],
    )
    billing = mesero.client.get(f"/api/v1/orders/{order['id']}/billing").json()
    assert float(billing["total"]) == 56.0
    assert float(billing["pending_amount"]) == 56.0
    assert len(billing["items"]) == 2


def test_split_by_items_and_amount(admin, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    command = create_command(
        mesero,
        order["id"],
        [
            {"menu_item_id": menu_lookup["Pollo a la brasa"]["id"], "quantity": 2},
            {"menu_item_id": menu_lookup["Parrilla especial"]["id"], "quantity": 1},
        ],
    )
    pollo = next(i for i in command["items"] if i["menu_item_name_snapshot"] == "Pollo a la brasa")

    first = admin.client.post(
        f"/api/v1/orders/{order['id']}/splits",
        json={"split_type": "BY_ITEMS", "label": "Persona A", "items": [{"order_item_id": pollo["id"], "quantity": 1}]},
    )
    assert first.status_code == 201
    assert float(first.json()["amount"]) == 25.0

    over = admin.client.post(
        f"/api/v1/orders/{order['id']}/splits",
        json={"split_type": "BY_ITEMS", "items": [{"order_item_id": pollo["id"], "quantity": 5}]},
    )
    assert over.status_code == 422
    assert over.json()["error"]["code"] == "SPLIT_QUANTITY_EXCEEDED"

    billing = mesero.client.get(f"/api/v1/orders/{order['id']}/billing").json()
    remaining = float(billing["pending_amount"]) - sum(float(s["amount"]) for s in billing["splits"])
    second = admin.client.post(
        f"/api/v1/orders/{order['id']}/splits",
        json={"split_type": "BY_AMOUNT", "label": "Persona B", "amount": f"{remaining:.2f}"},
    )
    assert second.status_code == 201

    excess = admin.client.post(
        f"/api/v1/orders/{order['id']}/splits",
        json={"split_type": "BY_AMOUNT", "label": "Persona C", "amount": "1.00"},
    )
    assert excess.status_code == 422
    assert excess.json()["error"]["code"] == "SPLIT_EXCEEDS_PENDING"


def test_payment_marks_order_paid(admin, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])

    partial = _pay(admin, order["id"], "10.00")
    assert partial.status_code == 201
    detail = mesero.client.get(f"/api/v1/orders/{order['id']}").json()
    assert detail["status"] != "PAID"
    assert float(detail["paid_amount"]) == 10.0

    full = _pay(admin, order["id"], "15.00", method="YAPE")
    assert full.status_code == 201
    assert full.json()["became_paid"] is True
    detail = mesero.client.get(f"/api/v1/orders/{order['id']}").json()
    assert detail["status"] == "PAID"
    assert detail["paid_at"] is not None


def test_payment_cannot_exceed_pending(admin, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    response = _pay(admin, order["id"], "999.00")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "PAYMENT_EXCEEDS_PENDING"


def test_payment_idempotency(admin, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    key = str(uuid.uuid4())
    first = _pay(admin, order["id"], "25.00", client_operation_id=key)
    replay = _pay(admin, order["id"], "25.00", client_operation_id=key)
    assert first.status_code == 201
    assert replay.status_code == 201
    assert first.json()["id"] == replay.json()["id"]

    payments = admin.client.get(f"/api/v1/orders/{order['id']}/payments").json()
    assert len(payments) == 1


def test_cannot_add_items_to_paid_order(admin, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    _pay(admin, order["id"], "25.00")
    response = mesero.client.post(
        f"/api/v1/orders/{order['id']}/commands",
        json={"items": [{"menu_item_id": menu_lookup["Anticuchos"]["id"]}]},
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "ORDER_ALREADY_PAID"


def test_kitchen_cannot_register_payment(cocina, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    response = _pay(cocina, order["id"], "25.00")
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "PAYMENT_FORBIDDEN"


def test_kitchen_cannot_read_billing_or_payments(cocina, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    assert cocina.client.get(f"/api/v1/orders/{order['id']}/billing").status_code == 403
    assert cocina.client.get(f"/api/v1/orders/{order['id']}/payments").status_code == 403
