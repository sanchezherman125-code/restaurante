"""Best-effort Web Push delivery for a small allowlist of operational events."""

import base64
import hmac
import json
import logging
from typing import Any
from uuid import UUID

from app.config import settings
from app.db import SessionLocal
from app.models import PushSubscription, User

logger = logging.getLogger("app.push")

# Web Push payloads deliberately contain no order, table, customer, or payment data.
EVENTS: dict[str, tuple[str, str, str, set[str]]] = {
    "command.created": (
        "Nueva comanda", "Hay una nueva comanda en tu área.", "/comandas", {"KITCHEN", "GRILL", "ADMIN"}
    ),
    "order_item.ready": (
        "Preparación terminada", "Un producto está listo.", "/comandas", {"ADMIN", "WAITER"}
    ),
    "order.ready": ("Pedido listo", "Un pedido está listo para entregar.", "/pedidos", {"WAITER", "ADMIN"}),
    "order.paid": ("Pago registrado", "Se registró el pago de un pedido.", "/mesas", {"WAITER", "ADMIN"}),
}


def _vapid_private_key() -> Any:
    key = settings.vapid_private_key
    if not key.lstrip().startswith("-----BEGIN"):
        return key
    try:
        from cryptography.hazmat.primitives import serialization
        from py_vapid import Vapid

        parsed = Vapid.from_pem(key.encode("utf-8"))
        derived = parsed.public_key.public_bytes(
            serialization.Encoding.X962,
            serialization.PublicFormat.UncompressedPoint,
        )
        padded = settings.vapid_public_key + "=" * ((4 - len(settings.vapid_public_key) % 4) % 4)
        configured = base64.urlsafe_b64decode(padded)
        if not hmac.compare_digest(derived, configured):
            raise ValueError("VAPID key pair mismatch")
        return parsed
    except Exception:
        # Do not include configuration values in logs; the private key is a secret.
        logger.error("La clave VAPID privada no es válida o no coincide con la pública.")
        return None


def notification_for(event: str, data: dict[str, Any]) -> tuple[dict[str, str], set[str]] | None:
    definition = EVENTS.get(event)
    if definition is None:
        return None
    title, body, route, roles = definition
    if event == "command.created":
        areas = set(data.get("areas") or [])
        roles = {"ADMIN"}
        if "KITCHEN" in areas:
            roles.add("KITCHEN")
        if "GRILL" in areas:
            roles.add("GRILL")
    elif event == "order_item.ready":
        # Solo se emite cuando todas las tareas del plato terminaron: el aviso es para quien lo entrega.
        roles = {"ADMIN", "WAITER"}
    return {"title": title, "body": body, "route": route}, roles


def deliver_push(event_id: str, event: str, data: dict[str, Any]) -> None:
    if not settings.vapid_public_key or not settings.vapid_private_key or not settings.vapid_subject:
        return
    notification = notification_for(event, data)
    if notification is None:
        return
    message, roles = notification
    owner = data.get("created_by_waiter_id")
    try:
        from pywebpush import WebPushException, webpush
    except ImportError:
        logger.error("Web Push configurado pero falta la dependencia pywebpush")
        return
    vapid_key = _vapid_private_key()
    if vapid_key is None:
        return

    with SessionLocal() as db:
        query = db.query(PushSubscription, User).join(User, PushSubscription.user_id == User.id).filter(
            User.is_active.is_(True), User.role.in_(roles), PushSubscription.device_id.is_not(None)
        )
        if owner and "WAITER" in roles:
            query = query.filter((User.role != "WAITER") | (User.id == UUID(str(owner))))
        for subscription, user in query.all():
            try:
                user_message = message
                if event == "order_item.ready" and user.role == "WAITER":
                    user_message = {**message, "route": "/pedidos"}
                webpush(
                    subscription_info={"endpoint": subscription.endpoint, "keys": subscription.keys},
                    data=json.dumps({"id": event_id, **user_message}, separators=(",", ":")),
                    vapid_private_key=vapid_key,
                    vapid_claims={"sub": settings.vapid_subject},
                    timeout=5.0,
                    ttl=180,
                )
            except WebPushException as exc:
                status = getattr(getattr(exc, "response", None), "status_code", None)
                if status in {404, 410}:
                    db.delete(subscription)
                    logger.info("Push subscription expirada eliminada user=%s", subscription.user_id)
                else:
                    logger.warning("Proveedor Web Push rechazó envío status=%s", status)
            except Exception:
                # A provider/network outage must never affect the committed operation.
                logger.exception("Error de entrega Web Push")
        try:
            db.commit()
        except Exception:
            db.rollback()
            logger.exception("No se pudieron eliminar suscripciones Web Push expiradas")
