import secrets
import time
from collections import defaultdict, deque
from datetime import UTC, datetime, timedelta
from typing import Any

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerifyMismatchError

from app.config import settings
from app.core.errors import ApiError

_hasher = PasswordHasher(time_cost=2, memory_cost=64 * 1024, parallelism=2)


def hash_pin(pin: str) -> str:
    return _hasher.hash(pin)


def verify_pin(pin_hash: str, pin: str) -> bool:
    try:
        return _hasher.verify(pin_hash, pin)
    except (VerifyMismatchError, InvalidHashError):
        return False
    except Exception:
        return False


def needs_rehash(pin_hash: str) -> bool:
    try:
        return _hasher.check_needs_rehash(pin_hash)
    except Exception:
        return False


def create_access_token(user_id: str, role: str, username: str) -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": user_id,
        "role": role,
        "username": username,
        "type": "access",
        "iat": now,
        "exp": now + timedelta(minutes=settings.jwt_access_token_minutes),
        "jti": secrets.token_hex(8),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def create_refresh_token(user_id: str, role: str, username: str) -> str:
    now = datetime.now(UTC)
    payload = {
        "sub": user_id,
        "role": role,
        "username": username,
        "type": "refresh",
        "iat": now,
        "exp": now + timedelta(days=settings.jwt_refresh_token_days),
        "jti": secrets.token_hex(8),
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_token(token: str, expected_type: str = "access") -> dict[str, Any]:
    try:
        payload = jwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])
    except jwt.ExpiredSignatureError as exc:
        raise ApiError(401, "TOKEN_EXPIRED", "La sesión expiró. Inicie sesión nuevamente.") from exc
    except jwt.InvalidTokenError as exc:
        raise ApiError(401, "INVALID_TOKEN", "Token inválido.") from exc
    if payload.get("type") != expected_type:
        raise ApiError(401, "INVALID_TOKEN", "Tipo de token inválido.")
    return payload


class LoginRateLimiter:
    """Limitación de intentos de login en memoria (por proceso)."""

    def __init__(self) -> None:
        self._attempts: dict[str, deque[float]] = defaultdict(deque)
        self._lock_until: dict[str, float] = {}

    def _key(self, username: str, ip: str) -> str:
        return f"{username.lower()}|{ip}"

    def check(self, username: str, ip: str) -> None:
        key = self._key(username, ip)
        now = time.monotonic()
        until = self._lock_until.get(key, 0)
        if now < until:
            remaining = int(until - now)
            raise ApiError(
                429,
                "LOGIN_LOCKED",
                f"Demasiados intentos. Intente de nuevo en {remaining} segundos.",
                {"retry_after_seconds": remaining},
            )

    def register_failure(self, username: str, ip: str) -> None:
        key = self._key(username, ip)
        now = time.monotonic()
        window = settings.login_lockout_minutes * 60
        q = self._attempts[key]
        q.append(now)
        while q and now - q[0] > window:
            q.popleft()
        if len(q) >= settings.login_max_attempts:
            self._lock_until[key] = now + window
            q.clear()

    def reset(self, username: str, ip: str) -> None:
        key = self._key(username, ip)
        self._attempts.pop(key, None)
        self._lock_until.pop(key, None)


rate_limiter = LoginRateLimiter()
