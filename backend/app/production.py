"""Read-only deployment checks. Never seed, migrate or reset real data here."""

from pathlib import Path

import httpx
from alembic.config import Config
from alembic.script import ScriptDirectory
from sqlalchemy import text

from app.config import settings
from app.core.security import verify_pin
from app.db import SessionLocal, engine
from app.models import User


def check_production() -> None:
    settings.validate_production_security()
    root = Path(__file__).resolve().parent.parent
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    expected = ScriptDirectory.from_config(config).get_current_head()
    with engine.connect() as connection:
        actual = connection.execute(text("SELECT version_num FROM alembic_version")).scalar()
        if actual != expected:
            raise RuntimeError("Migraciones pendientes; ejecute alembic upgrade head antes del arranque.")
    with SessionLocal() as db:
        if not db.query(User.id).filter(User.role == "ADMIN", User.is_active.is_(True)).first():
            raise RuntimeError("Cree el administrador con python -m scripts.bootstrap_admin antes del arranque.")
        for user in db.query(User).filter(User.is_active.is_(True)):
            if verify_pin(user.pin_hash, "1234"):
                raise RuntimeError("Existe una cuenta activa con PIN demo 1234. Cambie su PIN antes del despliegue.")
    with httpx.Client(timeout=15) as client:
        result = client.get(
            f"{settings.supabase_url.rstrip('/')}/storage/v1/bucket/{settings.supabase_storage_bucket}",
            headers={
                "Authorization": f"Bearer {settings.supabase_service_key}",
                "apikey": settings.supabase_service_key,
            },
        )
        result.raise_for_status()
        if result.json().get("public") is not False:
            raise RuntimeError("El bucket de comprobantes debe ser privado.")


if __name__ == "__main__":
    check_production()
    print("Configuración, migraciones, administrador y almacenamiento privado verificados.")
