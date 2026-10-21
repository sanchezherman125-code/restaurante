"""Operator recovery for an existing account before a production upgrade."""

import getpass
import os
from datetime import UTC, datetime

from app.core.security import hash_pin
from app.db import SessionLocal
from app.models import AuthSession, User
from app.schemas.auth import UserUpdate


def run() -> None:
    username = os.environ.get("ADMIN_USERNAME") or input("Usuario a actualizar: ")
    pin = os.environ.get("ADMIN_PIN") or getpass.getpass("Nuevo PIN privado (6–10 dígitos): ")
    if len(pin) < 6 or pin in {"123456", "12345678", "000000", "111111"}:
        raise ValueError("Use un PIN privado de 6–10 dígitos que no sea una secuencia común.")
    payload = UserUpdate(pin=pin)
    with SessionLocal() as db:
        user = db.query(User).filter(User.username == username.lower()).one_or_none()
        if user is None:
            raise RuntimeError("Usuario inexistente.")
        user.pin_hash = hash_pin(payload.pin)
        db.query(AuthSession).filter(AuthSession.user_id == user.id).update({"revoked_at": datetime.now(UTC)})
        db.commit()
    print("PIN actualizado y sesiones anteriores revocadas.")


if __name__ == "__main__":
    run()
