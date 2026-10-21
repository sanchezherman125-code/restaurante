"""Create the first administrator without demo users or printed credentials."""

import getpass
import os

from app.core.security import hash_pin
from app.db import SessionLocal
from app.models import User
from app.schemas.auth import UserCreate


def run() -> None:
    with SessionLocal() as db:
        if db.query(User.id).filter(User.role == "ADMIN").first():
            print("Ya existe un administrador; no se modifica ninguna cuenta.")
            return
    username = os.environ.get("ADMIN_USERNAME") or input("Usuario administrador: ")
    pin = os.environ.get("ADMIN_PIN") or getpass.getpass("PIN privado (6–10 dígitos): ")
    if len(pin) < 6 or pin in {"123456", "12345678", "000000", "111111"}:
        raise ValueError("Use un PIN privado de 6–10 dígitos que no sea una secuencia común.")
    payload = UserCreate(username=username, pin=pin, display_name="Administrador", role="ADMIN")
    with SessionLocal() as db:
        if db.query(User.id).filter(User.role == "ADMIN").first():
            raise RuntimeError("Ya existe un administrador; gestione las cuentas desde la aplicación.")
        db.add(
            User(
                username=payload.username.lower(),
                pin_hash=hash_pin(payload.pin),
                display_name=payload.display_name,
                role="ADMIN",
                is_active=True,
            )
        )
        db.commit()
    print("Administrador creado. Configure las mesas, carta y personal desde la aplicación.")


if __name__ == "__main__":
    run()
