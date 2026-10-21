from datetime import UTC, datetime

from fastapi import APIRouter, Request, Response

from app.core import audit as audit_actions
from app.core import login_rate
from app.core.deps import CurrentUser, DbSession, DeviceId, _extract_token
from app.core.errors import UnauthorizedError
from app.core.security import (
    decode_token,
    hash_pin,
    needs_rehash,
    verify_pin,
)
from app.models import PushSubscription, User
from app.schemas.auth import LoginRequest, RefreshRequest, TokenResponse, UserOut
from app.services.auth import issue_tokens, validate_session

router = APIRouter(prefix="/auth", tags=["auth"])


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest, request: Request, db: DbSession, response: Response) -> TokenResponse:
    ip = _client_ip(request)
    login_rate.check(db, payload.username, ip)

    user = db.query(User).filter(User.username == payload.username.lower()).first()
    if user is None or not user.is_active or not verify_pin(user.pin_hash, payload.pin):
        login_rate.register_failure(db, payload.username, ip)
        raise UnauthorizedError("INVALID_CREDENTIALS", "Usuario o PIN incorrecto.")

    login_rate.reset(db, payload.username, ip)
    if needs_rehash(user.pin_hash):
        user.pin_hash = hash_pin(payload.pin)

    audit_actions.audit(
        db,
        user_id=user.id,
        action=audit_actions.LOGIN,
        entity_type="users",
        entity_id=user.id,
        after_data={"username": user.username, "role": user.role},
    )
    tokens = issue_tokens(db, user)
    db.commit()

    response.headers["Cache-Control"] = "no-store"
    return tokens


@router.post("/refresh", response_model=TokenResponse)
def refresh(payload: RefreshRequest, db: DbSession, response: Response) -> TokenResponse:
    data = decode_token(payload.refresh_token, expected_type="refresh")
    session = validate_session(db, data, lock=True)
    if session.refresh_jti != data["jti"]:
        raise UnauthorizedError("INVALID_TOKEN", "El token de renovación ya fue utilizado.")
    user = db.get(User, __import__("uuid").UUID(data["sub"]))
    if user is None or not user.is_active:
        raise UnauthorizedError("INVALID_TOKEN", "Sesión inválida.")
    tokens = issue_tokens(db, user, session)
    db.commit()
    response.headers["Cache-Control"] = "no-store"
    return tokens


@router.post("/logout", status_code=204)
def logout(request: Request, db: DbSession, user: CurrentUser, device_id: DeviceId) -> Response:
    payload = decode_token(_extract_token(request, request.headers.get("authorization")))
    session = validate_session(db, payload, lock=True)
    session.revoked_at = datetime.now(UTC)
    if device_id:
        db.query(PushSubscription).filter(
            PushSubscription.user_id == user.id,
            PushSubscription.device_id == device_id,
        ).delete(synchronize_session=False)
    db.commit()
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


@router.get("/me", response_model=UserOut)
def me(user: CurrentUser) -> UserOut:
    return UserOut.model_validate(user)
