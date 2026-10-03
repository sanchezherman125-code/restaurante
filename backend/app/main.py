import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api import (
    auth,
    billing,
    expenses,
    menu,
    orders,
    preparation,
    receipts,
    reports,
    shifts,
    tables,
    users,
    ws,
)
from app.config import settings
from app.core.errors import ApiError
from app.db import Base, engine
from app.ws.hub import hub

logger = logging.getLogger("app.http")


@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio

    hub.set_loop(asyncio.get_running_loop())
    yield
    hub.set_loop(None)


def create_app() -> FastAPI:
    settings.validate_production_security()
    app = FastAPI(
        title="Sistema de Gestión de Pedidos — Restaurante",
        version="1.0.0",
        lifespan=lifespan,
        docs_url="/api/docs",
        openapi_url="/api/openapi.json",
        redoc_url=None,
    )

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origin_list,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
        expose_headers=["X-Request-Id"],
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request_id = request.headers.get("X-Request-Id") or uuid.uuid4().hex
        start = time.perf_counter()
        response = await call_next(request)
        duration_ms = round((time.perf_counter() - start) * 1000, 1)
        response.headers["X-Request-Id"] = request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path.startswith("/api"):
            logger.info(
                "request_id=%s route=%s %s status=%s duration_ms=%s",
                request_id,
                request.method,
                request.url.path,
                response.status_code,
                duration_ms,
            )
        return response

    @app.exception_handler(ApiError)
    async def api_error_handler(request: Request, exc: ApiError):
        return JSONResponse(status_code=exc.status_code, content=exc.to_payload())

    @app.exception_handler(RequestValidationError)
    async def validation_error_handler(request: Request, exc: RequestValidationError):
        details = []
        for err in exc.errors():
            details.append(
                {
                    "field": ".".join(str(p) for p in err.get("loc", [])),
                    "message": err.get("msg", ""),
                }
            )
        return JSONResponse(
            status_code=422,
            content={
                "error": {
                    "code": "VALIDATION_ERROR",
                    "message": "Datos inválidos.",
                    "details": {"errors": details},
                }
            },
        )

    @app.exception_handler(Exception)
    async def generic_error_handler(request: Request, exc: Exception):
        logger.exception("error no controlado")
        return JSONResponse(
            status_code=500,
            content={
                "error": {
                    "code": "INTERNAL_ERROR",
                    "message": "Error interno del servidor.",
                    "details": {},
                }
            },
        )

    @app.get("/health", tags=["system"])
    def health() -> dict:
        return {"status": "ok", "environment": settings.environment}

    for router in (
        auth.router,
        users.router,
        tables.router,
        menu.router,
        orders.router,
        preparation.router,
        billing.router,
        expenses.expenses_router,
        expenses.purchase_router,
        shifts.router,
        reports.router,
        receipts.router,
        ws.router,
    ):
        app.include_router(router, prefix="/api/v1")

    from pathlib import Path

    uploads_dir = Path(__file__).resolve().parent.parent / "uploads"
    uploads_dir.mkdir(parents=True, exist_ok=True)
    app.mount("/uploads", StaticFiles(directory=str(uploads_dir)), name="uploads")

    return app


app = create_app()


def init_db() -> None:
    """Únicamente para desarrollo local sin Alembic. Producción usa migraciones."""
    Base.metadata.create_all(engine)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
