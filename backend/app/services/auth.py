import secrets
import uuid
from datetime import UTC, datetime, timedelta

from sqlalchemy.orm import Session

from app.config import settings
from app.core.errors import UnauthorizedError
from app.core.security import create_access_token, create_refresh_token
from app.models import AuthSession, User
from app.schemas.auth import TokenResponse


def validate_session(db: Session, payload: dict, *, lock: bool = False) -> AuthSession:
    try:
        session_id = uuid.UUID(payload["sid"])
        user_id = uuid.UUID(payload["sub"])
    except (KeyError, ValueError, TypeError) as exc:
        raise UnauthorizedError("INVALID_TOKEN", "Sesión inválida.") from exc
    query = db.query(AuthSession).filter(AuthSession.id == session_id)
    if lock:
        query = query.with_for_update()
    session = query.one_or_none()
    if (
        session is None
        or session.user_id != user_id
        or session.revoked_at is not None
        or session.expires_at <= datetime.now(UTC)
    ):
        raise UnauthorizedError("INVALID_TOKEN", "Sesión expirada o revocada.")
    return session


def issue_tokens(db: Session, user: User, session: AuthSession | None = None) -> TokenResponse:
    if session is None:
        session = AuthSession(id=uuid.uuid4(), user_id=user.id)
        db.add(session)
    session.refresh_jti = secrets.token_hex(32)
    session.expires_at = datetime.now(UTC) + timedelta(days=settings.jwt_refresh_token_days)
    return TokenResponse(
        access_token=create_access_token(str(user.id), user.role, user.username, str(session.id)),
        refresh_token=create_refresh_token(
            str(user.id),
            user.role,
            user.username,
            str(session.id),
            session.refresh_jti,
        ),
    )
