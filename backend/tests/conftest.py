import os

os.environ.setdefault(
    "DATABASE_URL",
    "postgresql+psycopg://restaurante:restaurante@localhost:5433/restaurante_test",
)
os.environ.setdefault("ENVIRONMENT", "test")
os.environ.setdefault("JWT_SECRET", "test-secret-de-al-menos-32-bytes-para-hs256")
os.environ.setdefault("LOGIN_MAX_ATTEMPTS", "5")
os.environ.setdefault("LOGIN_LOCKOUT_MINUTES", "5")

from decimal import Decimal  # noqa: E402

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import text  # noqa: E402

from app.core.security import hash_pin, rate_limiter  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import MenuCategory, MenuItem, RestaurantTable, User  # noqa: E402

OPERATIONAL_TABLES = [
    "audit_logs",
    "login_attempts",
    "idempotency_keys",
    "push_subscriptions",
    "purchase_list_items",
    "expenses",
    "payments",
    "bill_split_items",
    "bill_splits",
    "order_items",
    "commands",
    "orders",
    "shifts",
]

USERS = [
    ("admin", "1234", "Dueño", "ADMIN"),
    ("mesero1", "1234", "Ana Mesera", "WAITER"),
    ("cocina1", "1234", "Cocina", "KITCHEN"),
    ("parrilla1", "1234", "Parrilla", "GRILL"),
]

MENU = {
    "Entradas": [
        ("Causa limeña", "12.00", "KITCHEN", 10),
        ("Anticuchos", "18.00", "GRILL", 15),
    ],
    "Fondos": [
        ("Pollo a la brasa", "25.00", "KITCHEN", 20),
        ("Parrilla especial", "38.00", "GRILL", 15),
        ("Ensalada mixta", "9.00", "KITCHEN", 5),
    ],
    "Bebidas": [
        ("Inca Kola 500ml", "6.00", "WAITER", None),
        ("Agua mineral", "5.00", "WAITER", None),
    ],
}


@pytest.fixture(scope="session")
def db_created():
    Base.metadata.create_all(engine)
    yield
    Base.metadata.drop_all(engine)


def _seed_catalog(db) -> None:
    for username, pin, display_name, role in USERS:
        db.add(
            User(
                username=username,
                pin_hash=hash_pin(pin),
                display_name=display_name,
                role=role,
            )
        )
    for number in range(1, 6):
        db.add(RestaurantTable(name=f"Mesa {number}", number=number))
    for index, (category_name, items) in enumerate(MENU.items()):
        category = MenuCategory(name=category_name, sort_order=index)
        db.add(category)
        db.flush()
        for name, price, area, minutes in items:
            db.add(
                MenuItem(
                    category_id=category.id,
                    name=name,
                    price=Decimal(price),
                    preparation_area=None if area == "WAITER" else area,
                    requires_preparation=area != "WAITER",
                    expected_prep_minutes=minutes,
                )
            )
    db.commit()


@pytest.fixture(scope="session")
def catalog(db_created):
    db = SessionLocal()
    try:
        _seed_catalog(db)
    finally:
        db.close()
    yield


@pytest.fixture(autouse=True)
def clean_db(catalog):
    with engine.begin() as conn:
        conn.execute(text("TRUNCATE TABLE " + ", ".join(OPERATIONAL_TABLES) + " RESTART IDENTITY CASCADE"))
        conn.execute(
            text(
                "UPDATE menu_items SET is_available = TRUE, is_active = TRUE, price = CASE name "
                "WHEN 'Pollo a la brasa' THEN 25.00 WHEN 'Parrilla especial' THEN 38.00 "
                "WHEN 'Anticuchos' THEN 18.00 WHEN 'Causa limeña' THEN 12.00 "
                "WHEN 'Ensalada mixta' THEN 9.00 WHEN 'Inca Kola 500ml' THEN 6.00 "
                "WHEN 'Agua mineral' THEN 5.00 ELSE price END"
            )
        )
        conn.execute(text("DELETE FROM users WHERE username NOT IN ('admin', 'mesero1', 'cocina1', 'parrilla1')"))
        conn.execute(text("UPDATE users SET is_active = TRUE"))
        conn.execute(text("UPDATE restaurant_tables SET is_active = TRUE"))
    rate_limiter._attempts.clear()
    rate_limiter._lock_until.clear()
    yield


class Api:
    """Cliente HTTP de prueba con sesión por usuario."""

    def __init__(self, client: TestClient, username: str | None = None) -> None:
        self.client = client
        if username:
            self.login(username)

    def login(self, username: str, pin: str = "1234") -> dict:
        response = self.client.post("/api/v1/auth/login", json={"username": username, "pin": pin})
        assert response.status_code == 200, response.text
        tokens = response.json()
        self.client.headers["Authorization"] = f"Bearer {tokens['access_token']}"
        return tokens

    def logout_headers(self) -> None:
        self.client.headers.pop("Authorization", None)


@pytest.fixture
def client():
    with TestClient(app) as test_client:
        yield test_client


@pytest.fixture
def admin():
    with TestClient(app) as test_client:
        yield Api(test_client, "admin")


@pytest.fixture
def mesero():
    with TestClient(app) as test_client:
        yield Api(test_client, "mesero1")


@pytest.fixture
def cocina():
    with TestClient(app) as test_client:
        yield Api(test_client, "cocina1")


@pytest.fixture
def parrilla():
    with TestClient(app) as test_client:
        yield Api(test_client, "parrilla1")


@pytest.fixture
def open_shift(admin):
    response = admin.client.post("/api/v1/shifts/open")
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture
def menu_lookup(mesero):
    response = mesero.client.get("/api/v1/menu")
    assert response.status_code == 200, response.text
    return {item["name"]: item for item in response.json()["items"]}


@pytest.fixture
def tables(mesero):
    response = mesero.client.get("/api/v1/tables")
    assert response.status_code == 200, response.text
    return response.json()


def create_order(api: Api, table_number: int = 1, persons: int = 2, **extra) -> dict:
    tables_response = api.client.get("/api/v1/tables")
    tables = tables_response.json()
    table = next(t for t in tables if t["number"] == table_number)
    payload = {
        "order_type": "DINE_IN",
        "table_id": table["id"],
        "persons_count": persons,
        **extra,
    }
    response = api.client.post("/api/v1/orders", json=payload)
    assert response.status_code == 201, response.text
    return response.json()


def create_command(api: Api, order_id: str, items: list[dict], **extra) -> dict:
    response = api.client.post(f"/api/v1/orders/{order_id}/commands", json={"items": items, **extra})
    assert response.status_code == 201, response.text
    return response.json()
