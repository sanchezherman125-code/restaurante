import uuid
from unittest.mock import Mock

import pytest
from alembic.autogenerate import compare_metadata
from alembic.migration import MigrationContext
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.config import Settings
from app.core.security import hash_pin
from app.db import Base, SessionLocal, engine
from app.models import AuditLog, MenuItem, User
from app.ws.hub import Connection, ConnectionHub, hub
from tests.conftest import Api, create_command, create_order


def test_migrations_match_models():
    with engine.connect() as conn:
        assert compare_metadata(MigrationContext.configure(conn), Base.metadata) == []
        assert conn.execute(text(
            "SELECT count(*) FROM pg_tables WHERE schemaname = 'public' AND NOT rowsecurity"
        )).scalar() == 0


def test_health_allows_get_and_head_without_exposing_a_head_body(client):
    get_response = client.get("/health")
    head_response = client.head("/health")

    assert get_response.status_code == head_response.status_code == 200
    assert get_response.json()["status"] == "ok"
    assert head_response.content == b""
    assert head_response.headers["X-Content-Type-Options"] == "nosniff"


def test_database_rejects_invalid_price(menu_lookup):
    with SessionLocal() as db:
        item = db.get(MenuItem, uuid.UUID(menu_lookup["Pollo a la brasa"]["id"]))
        item.price = -1
        with pytest.raises(IntegrityError):
            db.commit()


def test_logout_revokes_access_and_refresh(client):
    tokens = client.post("/api/v1/auth/login", json={"username": "admin", "pin": "1234"}).json()
    headers = {"Authorization": f"Bearer {tokens['access_token']}"}
    assert client.post("/api/v1/auth/logout", headers=headers).status_code == 204
    assert client.get("/api/v1/auth/me", headers=headers).status_code == 401
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]}).status_code == 401


def test_refresh_rotates_and_pin_change_revokes_sessions(admin, client):
    user = admin.client.post("/api/v1/users", json={
        "username": "sessiontest", "pin": "1234", "display_name": "Sesión", "role": "WAITER",
    }).json()
    tokens = client.post("/api/v1/auth/login", json={"username": "sessiontest", "pin": "1234"}).json()
    refreshed = client.post("/api/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert refreshed.status_code == 200
    assert client.post("/api/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]}).status_code == 401
    assert admin.client.patch(f"/api/v1/users/{user['id']}", json={"pin": "654321"}).status_code == 200
    headers = {"Authorization": f"Bearer {refreshed.json()['access_token']}"}
    assert client.get("/api/v1/auth/me", headers=headers).status_code == 401


def test_idempotency_cannot_replay_another_users_response(admin, mesero, open_shift):
    payload = {"amount": "5.00", "description": "Hielo", "client_operation_id": str(uuid.uuid4())}
    first = admin.client.post("/api/v1/expenses", json=payload)
    second = mesero.client.post("/api/v1/expenses", json=payload)
    assert first.status_code == 201
    assert second.status_code == 409
    assert second.json()["error"]["code"] == "IDEMPOTENCY_KEY_REUSED"


def test_command_idempotency_is_scoped_to_order(mesero, open_shift, menu_lookup):
    first_order = create_order(mesero, table_number=1)
    second_order = create_order(mesero, table_number=2)
    payload = {"items": [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}],
               "client_operation_id": str(uuid.uuid4())}
    assert mesero.client.post(f"/api/v1/orders/{first_order['id']}/commands", json=payload).status_code == 201
    assert mesero.client.post(f"/api/v1/orders/{second_order['id']}/commands", json=payload).status_code == 409


def test_waiter_cannot_deliver_another_waiters_item(admin, mesero, client, open_shift, menu_lookup):
    admin.client.post("/api/v1/users", json={
        "username": "otherwaiter", "display_name": "Otro", "role": "WAITER", "pin": "654321",
    })
    other = Api(client)
    other.login("otherwaiter", "654321")
    order = create_order(other)
    command = create_command(other, order["id"], [{"menu_item_id": menu_lookup["Inca Kola 500ml"]["id"]}])
    path = f"/api/v1/orders/{order['id']}/items/{command['items'][0]['id']}/status"
    assert mesero.client.post(path, json={"status": "DELIVERED"}).status_code == 403


def test_kitchen_mutation_does_not_return_other_area_or_financial_totals(cocina, mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [
        {"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]},
        {"menu_item_id": menu_lookup["Parrilla especial"]["id"]},
    ])
    item = next(item for item in command["items"] if item["preparation_area"] == "KITCHEN")
    response = cocina.client.post(f"/api/v1/orders/{order['id']}/items/{item['id']}/status",
                                  json={"status": "PREPARING"})
    assert response.status_code == 200
    body = response.json()
    assert "total" not in body and "paid_amount" not in body and "commands" not in body
    assert {item["preparation_area"] for item in body["items"]} == {"KITCHEN"}


def test_cancellation_replay_has_one_audit_event(mesero, open_shift, menu_lookup):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])
    item = command["items"][0]
    path = f"/api/v1/orders/{order['id']}/items/{item['id']}/cancel"
    payload = {"reason": "No disponible", "client_operation_id": str(uuid.uuid4())}
    first = mesero.client.post(path, json=payload)
    second = mesero.client.post(path, json=payload)
    assert first.status_code == second.status_code == 200
    assert first.json() == second.json()
    with SessionLocal() as db:
        assert db.query(AuditLog).filter(AuditLog.action == "ITEM_CANCELLED").count() == 1


def test_production_preflight_requires_private_storage(monkeypatch):
    from app import production

    with SessionLocal() as db:
        db.query(User).update({"is_active": False})
        db.add(User(username="deployadmin", role="ADMIN", display_name="Deploy",
                    pin_hash=hash_pin("649287"), is_active=True))
        db.commit()
    response = Mock()
    response.json.return_value = {"public": True}
    client = Mock()
    client.get.return_value = response
    client.__enter__ = Mock(return_value=client)
    client.__exit__ = Mock(return_value=False)
    monkeypatch.setattr(production.httpx, "Client", Mock(return_value=client))
    with pytest.raises(RuntimeError, match="privado"):
        production.check_production()
    response.json.return_value = {"public": False}
    production.check_production()


def test_receipts_are_private(mesero, cocina, admin, client):
    uploaded = mesero.client.post("/api/v1/receipts", files={
        "file": ("receipt.png", b"\x89PNG\r\n\x1a\nminimal", "image/png"),
    })
    assert uploaded.status_code == 201
    url = uploaded.json()["url"]
    assert url.startswith("/api/v1/receipts/")
    assert client.get(url).status_code == 401
    assert cocina.client.get(url).status_code == 403
    assert mesero.client.get(url).status_code == 200
    assert admin.client.get(url).headers["cache-control"] == "no-store"


def test_no_realtime_event_before_commit_or_after_rollback(monkeypatch):
    broadcast = Mock()
    monkeypatch.setattr(hub, "broadcast", broadcast)
    with SessionLocal() as db:
        hub.after_commit(db, "test.event", {"id": "1"}, {"admin"})
        db.execute(text("SELECT 1"))
        assert not broadcast.called
        db.rollback()
        db.commit()
        assert not broadcast.called
        hub.after_commit(db, "test.event", {"id": "2"}, {"admin"})
        db.commit()
    broadcast.assert_called_once_with("test.event", {"id": "2"}, {"admin"})


def test_realtime_order_events_only_reach_owner_and_admin():
    realtime = ConnectionHub()
    loop = Mock()
    loop.is_closed.return_value = False
    loop.call_soon_threadsafe.side_effect = lambda callback, *args: callback(*args)
    owner, other, admin = Mock(), Mock(), Mock()
    for user_id, role, send in (("owner", "WAITER", owner), ("other", "WAITER", other), ("admin", "ADMIN", admin)):
        realtime.register(Connection(user_id=user_id, role=role, device_id=None,
                                     channels={"waiters"}, send=send, loop=loop))
    realtime.broadcast("order.ready", {"created_by_waiter_id": "owner"}, {"waiters"})
    owner.assert_called_once()
    admin.assert_called_once()
    other.assert_not_called()


@pytest.mark.parametrize("override", [
    {"jwt_secret": "cambie-este-secreto-en-produccion-muy-largo"},
    {"database_url": "postgresql+psycopg://u:p@db/postgres"},
    {"cors_origins": "*"},
    {"allowed_hosts": "*"},
    {"database_env": "test"},
    {"supabase_url": "http://unsafe.example"},
])
def test_production_refuses_insecure_configuration(override):
    config = {
        "environment": "production", "database_env": "production",
        "jwt_secret": "a-random-secret-with-more-than-32-characters",
        "database_url": "postgresql+psycopg://u:p@db/postgres?sslmode=require",
        "supabase_url": "https://project.supabase.co", "supabase_service_key": "private-key",
        "frontend_url": "https://front.example", "cors_origins": "https://front.example",
        "allowed_hosts": "api.example",
    }
    with pytest.raises(RuntimeError):
        Settings(_env_file=None, **(config | override)).validate_production_security()
