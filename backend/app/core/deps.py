from typing import Annotated
from uuid import UUID

from fastapi import Depends, Header, Request
from sqlalchemy.orm import Session

from app.core.errors import ApiError, ForbiddenError, NotFoundError
from app.core.security import decode_token
from app.db import get_db
from app.models import Shift, User

DbSession = Annotated[Session, Depends(get_db)]

ROLE_WAITER = "WAITER"
ROLE_KITCHEN = "KITCHEN"
ROLE_GRILL = "GRILL"
ROLE_ADMIN = "ADMIN"

ALL_ROLES = {ROLE_WAITER, ROLE_KITCHEN, ROLE_GRILL, ROLE_ADMIN}


def _extract_token(request: Request, authorization: str | None) -> str:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip()
    token = request.query_params.get("token")
    if token:
        return token
    raise ApiError(401, "UNAUTHORIZED", "Falta el token de autenticación.")


def get_current_user(
    request: Request,
    db: DbSession,
    authorization: Annotated[str | None, Header()] = None,
) -> User:
    token = _extract_token(request, authorization)
    payload = decode_token(token, expected_type="access")
    try:
        user_id = UUID(payload["sub"])
    except (KeyError, ValueError) as exc:
        raise ApiError(401, "INVALID_TOKEN", "Token inválido.") from exc
    user = db.get(User, user_id)
    if user is None or not user.is_active:
        raise ApiError(401, "INVALID_TOKEN", "Usuario inexistente o inactivo.")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def require_roles(*roles: str):
    allowed = set(roles)

    def dependency(user: CurrentUser) -> User:
        if user.role not in allowed:
            raise ForbiddenError(
                "ROLE_REQUIRED",
                f"Esta operación requiere un rol: {', '.join(sorted(allowed))}.",
            )
        return user

    return dependency


def get_device_id(device_id: Annotated[str | None, Header(alias="X-Device-Id")] = None) -> str | None:
    return device_id


DeviceId = Annotated[str | None, Depends(get_device_id)]


def get_open_shift(db: DbSession) -> Shift:
    shift = db.query(Shift).filter(Shift.status == "OPEN").order_by(Shift.opened_at.desc()).first()
    if shift is None:
        raise NotFoundError("NO_OPEN_SHIFT", "No hay un turno abierto. Abra un turno para operar.")
    return shift


OpenShift = Annotated[Shift, Depends(get_open_shift)]


AdminUser = Annotated[User, Depends(require_roles(ROLE_ADMIN))]
WaiterUser = Annotated[User, Depends(require_roles(ROLE_WAITER, ROLE_ADMIN))]
KitchenUser = Annotated[User, Depends(require_roles(ROLE_KITCHEN, ROLE_ADMIN))]
GrillUser = Annotated[User, Depends(require_roles(ROLE_GRILL, ROLE_ADMIN))]
AreaUser = Annotated[User, Depends(require_roles(ROLE_KITCHEN, ROLE_GRILL, ROLE_ADMIN))]
StaffUser = Annotated[User, Depends(require_roles(*ALL_ROLES))]


def ensure_order_in_open_shift(db: Session, shift_id: UUID) -> None:
    shift = db.query(Shift).filter(Shift.id == shift_id).populate_existing().with_for_update().one_or_none()
    if shift is None:
        raise NotFoundError("SHIFT_NOT_FOUND", "El turno del pedido no existe.")
    if shift.status != "OPEN":
        raise ApiError(409, "SHIFT_CLOSED", "El turno está cerrado. No se pueden modificar pedidos.")
