from uuid import UUID

from fastapi import APIRouter

from app.core.deps import AdminUser, DbSession
from app.core.errors import ConflictError, NotFoundError
from app.core.security import hash_pin
from app.models import User
from app.schemas.auth import UserCreate, UserOut, UserUpdate

router = APIRouter(prefix="/users", tags=["users"])


@router.get("", response_model=list[UserOut])
def list_users(db: DbSession, _: AdminUser) -> list[UserOut]:
    users = db.query(User).order_by(User.display_name.asc()).all()
    return [UserOut.model_validate(u) for u in users]


@router.post("", response_model=UserOut, status_code=201)
def create_user(payload: UserCreate, db: DbSession, _: AdminUser) -> UserOut:
    exists = db.query(User).filter(User.username == payload.username.lower()).first()
    if exists is not None:
        raise ConflictError("USERNAME_TAKEN", "Ya existe un usuario con ese nombre.")
    new_user = User(
        username=payload.username.lower(),
        pin_hash=hash_pin(payload.pin),
        display_name=payload.display_name,
        role=payload.role.value,
        is_active=True,
    )
    db.add(new_user)
    db.commit()
    db.refresh(new_user)
    return UserOut.model_validate(new_user)


@router.patch("/{user_id}", response_model=UserOut)
def update_user(user_id: UUID, payload: UserUpdate, db: DbSession, _: AdminUser) -> UserOut:
    target = db.get(User, user_id)
    if target is None:
        raise NotFoundError("USER_NOT_FOUND", "Usuario no encontrado.")
    data = payload.model_dump(exclude_unset=True)
    if "pin" in data:
        target.pin_hash = hash_pin(data.pop("pin"))
    if data.get("role") is not None:
        data["role"] = data["role"].value
    for key, value in data.items():
        setattr(target, key, value)
    db.commit()
    db.refresh(target)
    return UserOut.model_validate(target)


@router.post("/{user_id}/disable", response_model=UserOut)
def disable_user(user_id: UUID, db: DbSession, admin: AdminUser) -> UserOut:
    target = db.get(User, user_id)
    if target is None:
        raise NotFoundError("USER_NOT_FOUND", "Usuario no encontrado.")
    if target.id == admin.id:
        raise ConflictError("CANNOT_DISABLE_SELF", "No puede desactivar su propia cuenta.")
    target.is_active = False
    db.commit()
    db.refresh(target)
    return UserOut.model_validate(target)
