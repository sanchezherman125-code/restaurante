import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient
from sqlalchemy import func

from app.db import SessionLocal
from app.main import app
from app.models import AuditLog, Command, Order, OrderItem, Payment
from app.models.enums import ItemStatus, OrderStatus
from tests.conftest import create_command, create_order


def _token(username: str) -> str:
    with TestClient(app) as client:
        response = client.post("/api/v1/auth/login", json={"username": username, "pin": "1234"})
        assert response.status_code == 200
        return response.json()["access_token"]


def _post_concurrently(path: str, payload: dict, tokens: list[str]) -> list[int]:
    barrier = threading.Barrier(len(tokens))

    def send(token: str) -> int:
        with TestClient(app) as client:
            client.headers["Authorization"] = f"Bearer {token}"
            barrier.wait(timeout=10)
            return client.post(path, json=payload).status_code

    with ThreadPoolExecutor(max_workers=len(tokens)) as pool:
        return list(pool.map(send, tokens))


def _post_requests_concurrently(requests: list[tuple[str, dict, str]]) -> list[int]:
    barrier = threading.Barrier(len(requests))

    def send(request: tuple[str, dict, str]) -> int:
        path, payload, token = request
        with TestClient(app) as client:
            client.headers["Authorization"] = f"Bearer {token}"
            barrier.wait(timeout=10)
            return client.post(path, json=payload).status_code

    with ThreadPoolExecutor(max_workers=len(requests)) as pool:
        return list(pool.map(send, requests))


def test_same_command_uuid_is_idempotent_under_real_concurrency(mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    token = _token("mesero1")
    key = str(uuid.uuid4())
    statuses = _post_concurrently(
        f"/api/v1/orders/{order['id']}/commands",
        {"items": [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}], "client_operation_id": key},
        [token, token],
    )
    assert statuses == [201, 201]
    db = SessionLocal()
    try:
        assert db.query(Command).filter(Command.order_id == order["id"]).count() == 1
    finally:
        db.close()


def test_concurrent_shift_opening_creates_exactly_one_shift(admin):
    token = _token("admin")
    assert sorted(_post_concurrently("/api/v1/shifts/open", {}, [token, token])) == [201, 409]


def test_concurrent_payments_never_exceed_order_total(admin, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    token = _token("admin")
    statuses = _post_concurrently(
        f"/api/v1/orders/{order['id']}/payments",
        {"method": "CASH", "amount": "20.00"},
        [token, token],
    )
    assert sorted(statuses) == [201, 422]
    db = SessionLocal()
    try:
        paid = db.query(func.coalesce(func.sum(Payment.amount), 0)).filter(Payment.order_id == order["id"]).scalar()
        total = db.get(Order, order["id"]).total
        assert paid <= total
    finally:
        db.close()


def test_payment_and_cancellation_race_preserves_order_money_invariant(admin, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [
        {"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]},
        {"menu_item_id": menu_lookup["Inca Kola 500ml"]["id"]},
    ])
    chicken = next(item for item in command["items"] if item["menu_item_name_snapshot"] == "Pollo a la brasa")
    requests = [
        (f"/api/v1/orders/{order['id']}/payments", {"method": "CASH", "amount": "20.00"}, _token("admin")),
        (f"/api/v1/orders/{order['id']}/items/{chicken['id']}/cancel", {"reason": "carrera"}, _token("mesero1")),
    ]
    payment_status, cancellation_status = _post_requests_concurrently(requests)

    assert (payment_status, cancellation_status) in {(201, 409), (422, 200)}
    with SessionLocal() as db:
        persisted_order = db.get(Order, order["id"])
        persisted_item = db.get(OrderItem, chicken["id"])
        paid = db.query(func.coalesce(func.sum(Payment.amount), 0)).filter(
            Payment.order_id == order["id"],
        ).scalar()
        assert persisted_order.paid_amount == paid
        assert persisted_order.paid_amount <= persisted_order.total
        if cancellation_status == 200:
            assert persisted_item.status == ItemStatus.CANCELLED
            assert persisted_order.total == 6
            assert persisted_order.paid_amount == 0
        else:
            assert persisted_item.status == ItemStatus.PENDING
            assert persisted_order.total == 31
            assert persisted_order.paid_amount == 20


def test_duplicate_cancellations_are_idempotent_under_real_concurrency(mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [
        {"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]},
    ])
    item = command["items"][0]
    key = str(uuid.uuid4())
    token = _token("mesero1")
    statuses = _post_concurrently(
        f"/api/v1/orders/{order['id']}/items/{item['id']}/cancel",
        {"reason": "reintento simultáneo", "client_operation_id": key},
        [token, token],
    )

    assert statuses == [200, 200]
    with SessionLocal() as db:
        persisted_item = db.get(OrderItem, item["id"])
        assert persisted_item.status == ItemStatus.CANCELLED
        assert db.query(AuditLog).filter(
            AuditLog.action == "ITEM_CANCELLED", AuditLog.entity_id == item["id"],
        ).count() == 1


def test_concurrent_dine_in_opening_creates_exactly_one_active_order(admin, mesero, open_shift, tables):
    table = next(row for row in tables if row["number"] == 4)
    token = _token("mesero1")
    statuses = _post_concurrently(
        "/api/v1/orders",
        {"order_type": "DINE_IN", "table_id": table["id"], "persons_count": 2},
        [token, token],
    )
    assert sorted(statuses) == [201, 409]
    db = SessionLocal()
    try:
        active = (
            db.query(Order)
            .filter(
                Order.table_id == table["id"],
                Order.status.in_(
                    [OrderStatus.OPEN, OrderStatus.IN_PREPARATION, OrderStatus.READY, OrderStatus.DELIVERED]
                ),
            )
            .count()
        )
        assert active == 1
    finally:
        db.close()


def test_shift_close_serializes_with_order_creation(admin, mesero, open_shift, tables):
    table = next(row for row in tables if row["number"] == 5)
    admin_token = _token("admin")
    waiter_token = _token("mesero1")
    barrier = threading.Barrier(2)

    def close_shift() -> int:
        with TestClient(app) as client:
            client.headers["Authorization"] = f"Bearer {admin_token}"
            barrier.wait(timeout=10)
            return client.post(f"/api/v1/shifts/{open_shift['id']}/close").status_code

    def create_after_close_race() -> int:
        with TestClient(app) as client:
            client.headers["Authorization"] = f"Bearer {waiter_token}"
            barrier.wait(timeout=10)
            return client.post(
                "/api/v1/orders",
                json={"order_type": "DINE_IN", "table_id": table["id"], "persons_count": 2},
            ).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        close_status, create_status = list(pool.map(lambda fn: fn(), [close_shift, create_after_close_race]))

    assert close_status in (200, 409)
    if close_status == 200:
        assert create_status in (404, 409)
        db = SessionLocal()
        try:
            assert db.query(Order).filter(Order.shift_id == open_shift["id"]).count() == 0
        finally:
            db.close()
