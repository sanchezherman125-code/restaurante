import asyncio
import logging
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger("app.ws")

CHANNELS_BY_ROLE = {
    "WAITER": {"waiters"},
    "KITCHEN": {"kitchen"},
    "GRILL": {"grill"},
    "ADMIN": {"waiters", "kitchen", "grill", "admin"},
}


@dataclass
class Connection:
    user_id: str
    role: str
    device_id: str | None
    channels: set[str]
    send: Any
    loop: asyncio.AbstractEventLoop | None = None
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)


class ConnectionHub:
    def __init__(self) -> None:
        self._connections: dict[int, Connection] = {}
        self._loop: asyncio.AbstractEventLoop | None = None
        self._seq = 0

    def set_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def register(self, connection: Connection) -> int:
        self._seq += 1
        conn_id = self._seq
        self._connections[conn_id] = connection
        return conn_id

    def unregister(self, conn_id: int) -> None:
        self._connections.pop(conn_id, None)

    def channels_for_role(self, role: str) -> set[str]:
        return set(CHANNELS_BY_ROLE.get(role, set()))

    def broadcast(self, event: str, payload: dict[str, Any], channels: set[str] | None = None) -> None:
        message = {"event": event, "data": payload}
        targets = [c for c in self._connections.values() if channels is None or c.channels & channels]
        for conn in targets:
            loop = conn.loop if conn.loop is not None else self._loop
            if loop is None or loop.is_closed():
                continue
            try:
                loop.call_soon_threadsafe(self._dispatch, conn, message)
            except RuntimeError:
                logger.debug("Loop cerrado; se descarta mensaje WebSocket")

    def _dispatch(self, conn: Connection, message: dict[str, Any]) -> None:
        try:
            conn.send(message)
        except Exception:
            logger.exception("No se pudo enviar mensaje WebSocket")


hub = ConnectionHub()
