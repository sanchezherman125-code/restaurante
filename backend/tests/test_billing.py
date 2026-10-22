import uuid
from decimal import Decimal

import pytest

from app.db import SessionLocal
from app.models import BillSplit, Order, Payment, User
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


def test_split_creation_is_rejected_and_writes_nothing(admin, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    item_id = command["items"][0]["id"]
    for body in (
        {"split_type": "BY_AMOUNT", "amount": "10.00"},
        {"split_type": "BY_ITEMS", "items": [{"order_item_id": item_id, "quantity": 1}]},
    ):
        response = admin.client.post(f"/api/v1/orders/{order['id']}/splits", json=body)
        assert response.status_code == 410
        assert response.json()["error"]["code"] == "SPLITS_DISABLED"
    with SessionLocal() as db:
        assert db.query(BillSplit).filter(BillSplit.order_id == order["id"]).count() == 0
    # Sin sesión tampoco hay respuesta útil: la ruta exige autenticación.
    admin.client.headers.pop("Authorization")
    assert admin.client.post(f"/api/v1/orders/{order['id']}/splits", json={}).status_code == 401


def test_payment_bound_to_a_split_is_rejected(admin, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    response = _pay(admin, order["id"], "10.00", split_id=str(uuid.uuid4()))
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "SPLIT_PAYMENTS_DISABLED"
    billing = admin.client.get(f"/api/v1/orders/{order['id']}/billing").json()
    assert billing["payments"] == []
    assert float(billing["paid_amount"]) == 0


def test_billing_contract_has_no_split_fields(mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    billing = mesero.client.get(f"/api/v1/orders/{order['id']}/billing").json()
    assert "splits" not in billing
    assert billing["legacy_splits"] == []
    assert all("split_quantity" not in item for item in billing["items"])


def test_historical_split_payments_stay_readable_and_do_not_distort_totals(admin, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"], "quantity": 2}])
    with SessionLocal() as db:
        admin_id = db.query(User).filter_by(username="admin").one().id
        split = BillSplit(order_id=order["id"], split_type="BY_AMOUNT", label="Persona A",
                          amount=Decimal("20.00"), created_by_user_id=admin_id)
        db.add(split)
        db.flush()
        db.add(Payment(order_id=order["id"], split_id=split.id, method="YAPE", amount=Decimal("20.00"),
                       created_by_user_id=admin_id))
        persisted = db.get(Order, order["id"])
        persisted.paid_amount = Decimal("20.00")
        db.commit()
        split_id = str(split.id)

    billing = admin.client.get(f"/api/v1/orders/{order['id']}/billing").json()
    assert [s["id"] for s in billing["legacy_splits"]] == [split_id]
    assert billing["payments"][0]["split_id"] == split_id
    assert float(billing["pending_amount"]) == 30.0

    # El saldo se cobra completo y sin división; el historial no se modifica.
    final = _pay(admin, order["id"], "30.00", method="PLIN")
    assert final.status_code == 201
    assert final.json()["became_paid"] is True
    billing = admin.client.get(f"/api/v1/orders/{order['id']}/billing").json()
    assert [p["method"] for p in billing["payments"]] == ["YAPE", "PLIN"]
    assert float(billing["paid_amount"]) == 50.0
    assert admin.client.post(f"/api/v1/orders/{order['id']}/splits", json={"split_type": "BY_AMOUNT",
                                                                            "amount": "1.00"}).status_code == 410
    with SessionLocal() as db:
        assert db.query(BillSplit).filter(BillSplit.order_id == order["id"]).count() == 1
        assert db.query(Payment).filter(Payment.order_id == order["id"]).count() == 2


@pytest.mark.parametrize("method", ["CASH", "YAPE", "PLIN", "CARD", "OTHER"])
def test_full_payment_with_each_method(admin, mesero, open_shift, menu_lookup, method):
    order = create_order(mesero)
    create_command(mesero, order["id"], [
        {"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]},
        {"menu_item_id": menu_lookup["Inca Kola 500ml"]["id"]},
    ])
    response = _pay(mesero, order["id"], "31.00", method=method)
    assert response.status_code == 201
    assert response.json()["method"] == method
    assert response.json()["became_paid"] is True
    billing = mesero.client.get(f"/api/v1/orders/{order['id']}/billing").json()
    assert billing["status"] == "PAID"
    assert float(billing["pending_amount"]) == 0
    assert len(billing["payments"]) == 1


def test_overpay_after_paid_is_rejected_and_state_is_unchanged(admin, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    assert _pay(admin, order["id"], "25.00").status_code == 201
    again = _pay(admin, order["id"], "0.01")
    assert again.status_code == 422
    assert again.json()["error"]["code"] == "PAYMENT_EXCEEDS_PENDING"
    with SessionLocal() as db:
        assert db.query(Payment).filter(Payment.order_id == order["id"]).count() == 1
        assert db.get(Order, order["id"]).paid_amount == Decimal("25.00")


def test_sales_report_counts_every_payment_once(admin, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"], "quantity": 2}])
    assert _pay(admin, order["id"], "20.00", method="CASH").status_code == 201
    assert _pay(admin, order["id"], "30.00", method="YAPE").status_code == 201
    sales = admin.client.get("/api/v1/reports/current-shift").json()
    assert float(sales["total_sales"]) == 50.0
    assert {k: float(v) for k, v in sales["sales_by_payment_method"].items()} == {"CASH": 20.0, "YAPE": 30.0}
    assert sales["orders_count"] == 1


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
