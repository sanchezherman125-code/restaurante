import logging
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from sqlalchemy import text
from starlette.middleware.trustedhost import TrustedHostMiddleware

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


def _backfill_preparation_tasks() -> None:
    """Da su tarea equivalente a platos creados por una instancia anterior durante un despliegue."""
    from app.db import SessionLocal
    from app.services.preparation import backfill_missing_tasks

    try:
        with SessionLocal() as db:
            created = backfill_missing_tasks(db)
        if created:
            logger.warning("Se crearon %s tareas de preparación faltantes", created)
    except Exception:
        # Antes de aplicar la migración 0007 la tabla no existe; el arranque no debe fallar por eso.
        logger.exception("No se pudo completar el relleno de tareas de preparación")


@asynccontextmanager
async def lifespan(app: FastAPI):
    import asyncio

    hub.set_loop(asyncio.get_running_loop())
    if settings.is_production:
        from app.production import check_production

        await asyncio.to_thread(check_production)
    await asyncio.to_thread(_backfill_preparation_tasks)
    yield
    hub.set_loop(None)


def create_app() -> FastAPI:
    settings.validate_production_security()
    app = FastAPI(
        title="Sistema de Gestión de Pedidos — Restaurante",
        version="1.0.0",
        lifespan=lifespan,
        docs_url=None if settings.is_production else "/api/docs",
        openapi_url=None if settings.is_production else "/api/openapi.json",
        redoc_url=None,
    )
    app.add_middleware(TrustedHostMiddleware, allowed_hosts=[h.strip() for h in settings.allowed_hosts.split(",")])

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
        if request.url.path.startswith("/api") or request.url.path.startswith("/uploads"):
            response.headers["Cache-Control"] = "no-store"
        if settings.is_production:
            response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
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

    @app.api_route("/health", methods=["GET", "HEAD"], tags=["system"])
    def health() -> dict:
        return {"status": "ok", "environment": settings.environment}

    @app.get("/ready", tags=["system"])
    def ready() -> JSONResponse:
        try:
            with engine.connect() as connection:
                connection.execute(text("SELECT 1"))
        except Exception:
            return JSONResponse(status_code=503, content={"status": "unavailable"})
        return JSONResponse(content={"status": "ok"})

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
    app.add_api_route("/uploads/{filename}", receipts.download_receipt, methods=["GET"], include_in_schema=False)

    return app


app = create_app()


def init_db() -> None:
    """Únicamente para desarrollo local sin Alembic. Producción usa migraciones."""
    Base.metadata.create_all(engine)


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("app.main:app", host="0.0.0.0", port=8000, reload=True)
