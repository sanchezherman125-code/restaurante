from functools import lru_cache
from urllib.parse import urlparse

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    environment: str = "development"
    log_level: str = "INFO"

    database_url: str = "postgresql+psycopg://restaurante:restaurante@localhost:5432/restaurante"
    database_url_test: str = "postgresql+psycopg://restaurante:restaurante@localhost:5433/restaurante_test"
    test_database_url: str = ""
    database_env: str = "development"

    jwt_secret: str = "dev-secret-cambiar"
    jwt_access_token_minutes: int = 30
    jwt_refresh_token_days: int = 14
    jwt_algorithm: str = "HS256"

    cors_origins: str = "http://localhost:5173,http://localhost:4173"

    supabase_url: str = ""
    supabase_service_key: str = ""
    supabase_storage_bucket: str = "receipts"

    frontend_url: str = "http://localhost:5173"

    login_max_attempts: int = 5
    login_lockout_minutes: int = 5

    business_timezone: str = "America/Lima"

    max_receipt_bytes: int = 5 * 1024 * 1024
    allowed_receipt_mimes: tuple[str, ...] = (
        "image/jpeg",
        "image/png",
        "image/webp",
        "application/pdf",
    )

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_test(self) -> bool:
        return self.environment == "test"

    def require_test_database(self) -> str:
        """Return the dedicated E2E URL only after explicit safety checks."""
        if self.database_env != "test":
            raise RuntimeError("El reset E2E requiere DATABASE_ENV=test.")
        if not self.test_database_url:
            raise RuntimeError("El reset E2E requiere TEST_DATABASE_URL.")
        database_name = urlparse(self.test_database_url).path.strip("/").lower()
        if "test" not in database_name and "e2e" not in database_name:
            raise RuntimeError("TEST_DATABASE_URL debe apuntar a una base identificada como test/e2e.")
        return self.test_database_url

    @property
    def active_database_url(self) -> str:
        if self.database_env == "test":
            return self.require_test_database()
        return self.database_url

    def validate_production_security(self) -> None:
        if self.environment in {"development", "test"}:
            return
        if self.jwt_secret == "dev-secret-cambiar" or len(self.jwt_secret) < 32:
            raise RuntimeError("JWT_SECRET seguro (mínimo 32 caracteres) es obligatorio fuera de desarrollo.")
        if not self.supabase_url or not self.supabase_service_key:
            raise RuntimeError("Supabase Storage es obligatorio fuera de desarrollo.")


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
