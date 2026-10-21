import json
import sys
from types import SimpleNamespace
from unittest.mock import Mock

from pydantic import ValidationError

from app.config import settings
from app.db import SessionLocal
from app.models import PushSubscription, User
from app.schemas.ops import PushSubscriptionCreate
from app.services.push import deliver_push, notification_for


def test_push_payloads_are_generic_and_command_role_filter_is_area_scoped():
    message, roles = notification_for("command.created", {"areas": ["KITCHEN"], "table_name": "Mesa privada"})
    assert roles == {"KITCHEN", "ADMIN"}
    assert message["route"] == "/comandas"
    assert "Mesa privada" not in str(message)
    assert notification_for("order.updated", {}) is None


def test_push_subscription_endpoint_rejects_unknown_hosts():
    try:
        PushSubscriptionCreate.model_validate(
            {"endpoint": "https://127.0.0.1/admin", "keys": {"auth": "a", "p256dh": "b"}}
        )
    except ValidationError:
        pass
    else:
        raise AssertionError("A user-controlled push endpoint must not allow SSRF")


def test_push_sends_only_to_active_users_in_matching_area(monkeypatch, admin, cocina, parrilla, mesero):
    sent = []
    class WebPushException(Exception):
        pass

    fake = SimpleNamespace(
        WebPushException=WebPushException,
        webpush=lambda subscription_info, **kwargs: sent.append(subscription_info["endpoint"]),
    )
    monkeypatch.setitem(sys.modules, "pywebpush", fake)
    monkeypatch.setattr(settings, "vapid_public_key", "public")
    monkeypatch.setattr(settings, "vapid_private_key", "private")
    monkeypatch.setattr(settings, "vapid_subject", "mailto:test@example.test")
    with SessionLocal() as db:
        ids = {
            username: db.query(User).filter_by(username=username).one().id
            for username in ("admin", "cocina1", "parrilla1", "mesero1")
        }
        for username in ids:
            db.add(PushSubscription(
                user_id=ids[username], device_id="test-device", endpoint=f"https://fcm.googleapis.com/{username}",
                keys={"auth": "a", "p256dh": "b"},
            ))
        db.commit()
    deliver_push("evt", "command.created", {"areas": ["KITCHEN"]})
    assert set(sent) == {"https://fcm.googleapis.com/admin", "https://fcm.googleapis.com/cocina1"}


def test_expired_push_subscriptions_are_deleted(monkeypatch, admin):
    class Expired(Exception):
        response = SimpleNamespace(status_code=410)

    monkeypatch.setitem(
        sys.modules, "pywebpush", SimpleNamespace(webpush=Mock(side_effect=Expired()), WebPushException=Expired)
    )
    monkeypatch.setattr(settings, "vapid_public_key", "public")
    monkeypatch.setattr(settings, "vapid_private_key", "private")
    monkeypatch.setattr(settings, "vapid_subject", "mailto:test@example.test")
    with SessionLocal() as db:
        user = db.query(User).filter_by(username="admin").one()
        db.add(PushSubscription(
            user_id=user.id, device_id="test-device", endpoint="https://fcm.googleapis.com/expired",
            keys={"auth": "a", "p256dh": "b"},
        ))
        db.commit()
        sub_id = db.query(PushSubscription).filter_by(endpoint="https://fcm.googleapis.com/expired").one().id
    deliver_push("evt", "order.ready", {"created_by_waiter_id": "00000000-0000-0000-0000-000000000000"})
    with SessionLocal() as db:
        assert db.get(PushSubscription, sub_id) is None


def test_ready_push_opens_a_role_valid_route(monkeypatch, admin, mesero):
    sent = []

    class WebPushException(Exception):
        pass

    fake = SimpleNamespace(
        WebPushException=WebPushException,
        webpush=lambda subscription_info, data, **kwargs: sent.append((subscription_info["endpoint"], data)),
    )
    monkeypatch.setitem(sys.modules, "pywebpush", fake)
    monkeypatch.setattr(settings, "vapid_public_key", "public")
    monkeypatch.setattr(settings, "vapid_private_key", "private")
    monkeypatch.setattr(settings, "vapid_subject", "mailto:test@example.test")
    with SessionLocal() as db:
        waiter = db.query(User).filter_by(username="mesero1").one()
        admin_user = db.query(User).filter_by(username="admin").one()
        db.add_all([
            PushSubscription(
                user_id=waiter.id, device_id="waiter-device",
                endpoint="https://fcm.googleapis.com/waiter-route", keys={"auth": "a", "p256dh": "b"},
            ),
            PushSubscription(
                user_id=admin_user.id, device_id="admin-device",
                endpoint="https://fcm.googleapis.com/admin-route", keys={"auth": "a", "p256dh": "b"},
            ),
        ])
        db.commit()
        waiter_id = str(waiter.id)
    deliver_push("ready-event", "order_item.ready", {"preparation_area": "KITCHEN", "created_by_waiter_id": waiter_id})
    routes = {endpoint: json.loads(payload)["route"] for endpoint, payload in sent}
    assert routes["https://fcm.googleapis.com/waiter-route"] == "/pedidos"
    assert routes["https://fcm.googleapis.com/admin-route"] == "/comandas"


def test_subscription_delete_is_user_owned_and_logout_cleans_only_current_device(monkeypatch, admin, mesero):
    monkeypatch.setattr(settings, "vapid_public_key", "public")
    monkeypatch.setattr(settings, "vapid_private_key", "private")
    monkeypatch.setattr(settings, "vapid_subject", "mailto:test@example.test")
    admin_device = {"X-Device-Id": "admin-device"}
    payload = {"endpoint": "https://fcm.googleapis.com/owned", "keys": {"auth": "a", "p256dh": "b"}}
    assert admin.client.post("/api/v1/push/subscriptions", json=payload, headers=admin_device).status_code == 201
    assert mesero.client.request(
        "DELETE", "/api/v1/push/subscriptions", json={"endpoint": payload["endpoint"]}
    ).status_code == 204
    with SessionLocal() as db:
        subscription = db.query(PushSubscription).filter_by(endpoint=payload["endpoint"]).one()
        assert str(subscription.user_id) == admin.client.get("/api/v1/auth/me").json()["id"]

    assert admin.client.post("/api/v1/auth/logout", headers=admin_device).status_code == 204
    with SessionLocal() as db:
        assert db.query(PushSubscription).filter_by(endpoint=payload["endpoint"]).count() == 0
