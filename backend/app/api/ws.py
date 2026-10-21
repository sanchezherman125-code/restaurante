import asyncio
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import settings
from app.core.security import decode_token
from app.db import SessionLocal
from app.models import User
from app.services.auth import validate_session
from app.ws.hub import Connection, hub

logger = logging.getLogger("app.ws")
router = APIRouter()


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

    db = SessionLocal()
    try:
        validate_session(db, payload)
        user = db.get(User, __import__("uuid").UUID(user_id))
        if user is None or not user.is_active:
            await websocket.close(code=4401)
            return
        role = user.role
    except Exception:
        await websocket.close(code=4401)
        return
    finally:
        db.close()

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
                with SessionLocal() as session_db:
                    validate_session(session_db, current_payload)
                    current_user = session_db.get(User, __import__("uuid").UUID(user_id))
                    if current_user is None or not current_user.is_active or current_user.role != role:
                        raise ValueError("Usuario inactivo o permisos cambiados")
            except Exception:
                await websocket.close(code=4401)
                break
            if message.strip().lower() in {"ping", '{"type":"ping"}'}:
                await websocket.send_json({"event": "pong", "data": {}})
    except WebSocketDisconnect:
        pass
    finally:
        hub.unregister(conn_id)
