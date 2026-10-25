import asyncio
import logging
import uuid

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import settings
from app.core.security import decode_token
from app.db import SessionLocal
from app.models import User
from app.services.auth import validate_session
from app.ws.hub import Connection, hub

logger = logging.getLogger("app.ws")
router = APIRouter()


def _active_role(payload: dict) -> str:
    """Valida sesión y usuario con la base de datos y devuelve el rol vigente.

    Es código síncrono: se ejecuta en un hilo. En el bucle de eventos, esperar una conexión del pool
    congelaría todo el servidor (HTTP y /health incluidos) mientras el pool estuviera ocupado.
    """
    with SessionLocal() as db:
        validate_session(db, payload)
        user = db.get(User, uuid.UUID(payload["sub"]))
        if user is None or not user.is_active:
            raise ValueError("Usuario inexistente o inactivo")
        return user.role


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    origin = websocket.headers.get("origin")
    if origin and origin not in settings.cors_origin_list:
        await websocket.close(code=4403)
        return
    await websocket.accept()
    try:
        auth = await asyncio.wait_for(websocket.receive_json(), timeout=5)
        if auth.get("type") != "auth" or not isinstance(auth.get("token"), str):
            raise ValueError("mensaje de autenticación inválido")
        token = auth["token"]
        device_id = auth.get("device_id") if isinstance(auth.get("device_id"), str) else None
        payload = decode_token(token, expected_type="access")
        user_id = payload["sub"]
        role = payload.get("role", "")
    except WebSocketDisconnect:
        return
    except Exception:
        await websocket.close(code=4401)
        return

    try:
        role = await asyncio.to_thread(_active_role, payload)
    except Exception:
        await websocket.close(code=4401)
        return

    channels = hub.channels_for_role(role)

    def send(message: dict) -> None:
        asyncio.ensure_future(websocket.send_json(message))

    conn = Connection(
        user_id=str(user_id),
        role=role,
        device_id=device_id,
        channels=channels,
        send=send,
        loop=asyncio.get_running_loop(),
    )
    conn_id = hub.register(conn)
    logger.info("ws conectado user=%s role=%s channels=%s", user_id, role, sorted(channels))

    await websocket.send_json(
        {
            "event": "connection.ready",
            "data": {"user_id": str(user_id), "role": role, "channels": sorted(channels)},
        }
    )

    try:
        while True:
            try:
                message = await asyncio.wait_for(websocket.receive_text(), timeout=30)
            except TimeoutError:
                message = ""
            try:
                current_payload = decode_token(token, expected_type="access")
                if await asyncio.to_thread(_active_role, current_payload) != role:
                    raise ValueError("Permisos cambiados")
            except Exception:
                await websocket.close(code=4401)
                break
            if message.strip().lower() in {"ping", '{"type":"ping"}'}:
                await websocket.send_json({"event": "pong", "data": {}})
    except WebSocketDisconnect:
        pass
    finally:
        hub.unregister(conn_id)
