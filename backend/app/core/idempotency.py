from typing import Any
from uuid import UUID

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import ConflictError
from app.models import IdempotencyKey


def _load(db: Session, key: UUID) -> IdempotencyKey | None:
    return db.query(IdempotencyKey).filter(IdempotencyKey.key == key).first()


def begin_idempotent(
    db: Session,
    key: UUID | None,
    user_id: UUID | None,
    operation_type: str,
) -> dict[str, Any] | None:
    """Devuelve la respuesta previa si la operación ya fue procesada.

    Retorna None si la operación debe ejecutarse normalmente.
    """
    if key is None:
        return None
    row = _load(db, key)
    if row is None:
        db.add(
            IdempotencyKey(
                key=key,
                user_id=user_id,
                operation_type=operation_type,
                response_status=0,
                response_body=None,
            )
        )
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            row = _load(db, key)
            if row is None:
                raise
        else:
            return None
    if row is None:
        return None
    if row.response_status in (0, None):
        raise ConflictError(
            "IDEMPOTENCY_IN_PROGRESS",
            "La operación con este identificador ya se está procesando.",
        )
    return {"status": row.response_status, "body": row.response_body}


def complete_idempotent(
    db: Session,
    key: UUID | None,
    status: int,
    body: dict[str, Any],
) -> None:
    if key is None:
        return
    row = _load(db, key)
    if row is not None:
        row.response_status = status
        row.response_body = body
        db.flush()


def execute_idempotent(
    db: Session,
    key: UUID | None,
    user_id: UUID | None,
    operation_type: str,
    fn,
) -> tuple[int, dict[str, Any]]:
    """Ejecuta una operación protegida por clave de idempotencia.

    Si la clave ya fue procesada devuelve la respuesta almacenada sin repetir
    la operación. ``fn`` debe devolver ``(status_code, body_dict)`` y dejar los
    cambios pendientes en la sesión (sin confirmar).
    """
    stored = begin_idempotent(db, key, user_id, operation_type)
    if stored is not None:
        return int(stored["status"]), stored["body"]

    status, body = fn()
    complete_idempotent(db, key, status, body)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        row = _load(db, key)
        if row is not None and row.response_status not in (0, None):
            return int(row.response_status), row.response_body
        raise
    return status, body
