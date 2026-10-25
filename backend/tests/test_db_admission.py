"""Control de admisión: nunca hay más peticiones /api en curso que conexiones en el pool."""

import asyncio

from app.config import settings
from app.core.admission import DatabaseAdmissionMiddleware
from app.main import app


def _http(path: str) -> dict:
    return {"type": "http", "path": path, "method": "GET", "headers": []}


def test_limits_concurrent_api_requests_and_lets_the_rest_wait_without_threads():
    in_flight = 0
    peak = 0

    async def endpoint(scope, receive, send):
        nonlocal in_flight, peak
        in_flight += 1
        peak = max(peak, in_flight)
        await asyncio.sleep(0.01)
        in_flight -= 1

    middleware = DatabaseAdmissionMiddleware(endpoint, limit=3)

    async def scenario():
        await asyncio.gather(*(middleware(_http("/api/v1/orders/active"), None, None) for _ in range(20)))

    asyncio.run(scenario())
    assert peak == 3


def test_health_and_websockets_are_never_queued():
    started = []

    async def endpoint(scope, receive, send):
        started.append(scope["path"])
        await asyncio.sleep(0.05)

    middleware = DatabaseAdmissionMiddleware(endpoint, limit=1)

    async def scenario():
        busy = asyncio.create_task(middleware(_http("/api/v1/tables"), None, None))
        await asyncio.sleep(0)
        await asyncio.wait_for(middleware(_http("/health"), None, None), timeout=1)
        await asyncio.wait_for(middleware({"type": "websocket", "path": "/api/v1/ws"}, None, None), timeout=1)
        await busy

    asyncio.run(scenario())
    assert started == ["/api/v1/tables", "/health", "/api/v1/ws"]


def test_application_limit_matches_pool_capacity():
    from app.db import engine

    admission = next(m for m in app.user_middleware if m.cls is DatabaseAdmissionMiddleware)
    assert admission.kwargs["limit"] == settings.db_pool_size + settings.db_max_overflow
    assert engine.pool.size() + engine.pool._max_overflow == admission.kwargs["limit"]


def test_websocket_still_authenticates_through_a_worker_thread(client):
    token = client.post("/api/v1/auth/login", json={"username": "admin", "pin": "1234"}).json()["access_token"]
    with client.websocket_connect("/api/v1/ws") as ws:
        ws.send_json({"type": "auth", "token": token})
        ready = ws.receive_json()
    assert ready["event"] == "connection.ready"
    assert ready["data"]["role"] == "ADMIN"
