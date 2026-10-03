from datetime import UTC, datetime, timedelta

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.config import settings
from app.core.errors import ApiError
from app.models import LoginAttempt


def _row_for_update(db: Session, username: str, ip: str) -> LoginAttempt | None:
    key = f"{username.lower()}|{ip}"
    # A transaction-scoped advisory lock also serializes the first failed login,
    # before there is a row to lock. PostgreSQL is the shared limiter state.
    db.execute(text("SELECT pg_advisory_xact_lock(hashtext(:key))"), {"key": key})
    return (
        db.query(LoginAttempt)
        .filter(LoginAttempt.username == username.lower(), LoginAttempt.ip == ip)
        .with_for_update()
        .one_or_none()
    )


def check(db: Session, username: str, ip: str) -> None:
    row = _row_for_update(db, username, ip)
    now = datetime.now(UTC)
    if row and row.locked_until and row.locked_until > now:
        remaining = max(1, int((row.locked_until - now).total_seconds()))
        raise ApiError(
            429,
            "LOGIN_LOCKED",
            f"Demasiados intentos. Intente de nuevo en {remaining} segundos.",
            {"retry_after_seconds": remaining},
        )


def register_failure(db: Session, username: str, ip: str) -> None:
    now = datetime.now(UTC)
    row = _row_for_update(db, username, ip)
    window = timedelta(minutes=settings.login_lockout_minutes)
    if row is None:
        row = LoginAttempt(username=username.lower(), ip=ip, failures=0, window_started_at=now)
        db.add(row)
    elif now - row.window_started_at > window:
        row.failures = 0
        row.window_started_at = now
        row.locked_until = None
    row.failures += 1
    if row.failures >= settings.login_max_attempts:
        row.locked_until = now + window
        row.failures = 0
    db.commit()


def reset(db: Session, username: str, ip: str) -> None:
    row = _row_for_update(db, username, ip)
    if row is not None:
        db.delete(row)
