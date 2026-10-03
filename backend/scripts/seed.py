"""Carga datos iniciales: usuarios, mesas, categorías y carta de ejemplo.

Uso:  python -m scripts.seed
"""

from decimal import Decimal

from app.core.security import hash_pin
from app.db import SessionLocal
from app.models import MenuCategory, MenuItem, RestaurantTable, User

USERS = [
    ("admin", "1234", "Dueño", "ADMIN"),
    ("mesero1", "1234", "Ana Mesera", "WAITER"),
    ("mesero2", "1234", "Luis Mesero", "WAITER"),
    ("cocina1", "1234", "Cocina", "KITCHEN"),
    ("parrilla1", "1234", "Parrilla", "GRILL"),
]

TABLES = [(f"Mesa {i}", i) for i in range(1, 11)]

MENU = {
    "Entradas": [
        ("Causa limeña", "12.00", "KITCHEN", 10),
        ("Papa a la huancaína", "10.00", "KITCHEN", 8),
        ("Anticuchos", "18.00", "GRILL", 15),
    ],
    "Fondos": [
        ("Pollo a la brasa", "25.00", "KITCHEN", 20),
        ("Parrilla especial", "38.00", "GRILL", 15),
        ("Lomo saltado", "32.00", "KITCHEN", 15),
        ("Ensalada mixta", "9.00", "KITCHEN", 5),
    ],
    "Bebidas": [
        ("Inca Kola 500ml", "6.00", None, None),
        ("Agua mineral 620ml", "5.00", None, None),
        ("Chicha morada 1L", "8.00", None, None),
    ],
    "Postres": [
        ("Picarones", "11.00", "KITCHEN", 10),
        ("Mazamorra morada", "8.00", "KITCHEN", 5),
    ],
}


def run() -> None:
    db = SessionLocal()
    try:
        if db.query(User).first() is not None:
            print("Ya existen datos. No se hace nada.")
            return

        for username, pin, display_name, role in USERS:
            db.add(
                User(
                    username=username,
                    pin_hash=hash_pin(pin),
                    display_name=display_name,
                    role=role,
                )
            )

        for name, number in TABLES:
            db.add(RestaurantTable(name=name, number=number))

        for index, (category_name, items) in enumerate(MENU.items()):
            category = MenuCategory(name=category_name, sort_order=index)
            db.add(category)
            db.flush()
            for name, price, area, minutes in items:
                db.add(
                    MenuItem(
                        category_id=category.id,
                        name=name,
                        description=None,
                        price=Decimal(price),
                        preparation_area=area,
                        requires_preparation=area is not None,
                        expected_prep_minutes=minutes,
                    )
                )

        db.commit()
        print("Datos iniciales creados:")
        for username, pin, _display_name, role in USERS:
            print(f"  - {username} / {pin} ({role})")
    finally:
        db.close()


if __name__ == "__main__":
    run()
