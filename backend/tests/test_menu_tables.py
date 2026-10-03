import uuid


def test_menu_structure(mesero, menu_lookup):
    assert "Pollo a la brasa" in menu_lookup
    assert menu_lookup["Pollo a la brasa"]["preparation_area"] == "KITCHEN"
    assert menu_lookup["Parrilla especial"]["preparation_area"] == "GRILL"
    assert menu_lookup["Inca Kola 500ml"]["preparation_area"] is None
    assert menu_lookup["Inca Kola 500ml"]["requires_preparation"] is False


def test_admin_creates_category_and_item(admin, menu_lookup):
    category = admin.client.post("/api/v1/menu/categories", json={"name": "Promociones", "sort_order": 99})
    assert category.status_code == 201

    item = admin.client.post(
        "/api/v1/menu/items",
        json={
            "category_id": category.json()["id"],
            "name": "Combo familiar",
            "price": "60.00",
            "preparation_area": "KITCHEN",
            "expected_prep_minutes": 25,
        },
    )
    assert item.status_code == 201
    assert item.json()["price"] == "60.00"

    updated = admin.client.patch(f"/api/v1/menu/items/{item.json()['id']}", json={"price": "65.00"})
    assert updated.status_code == 200
    assert updated.json()["price"] == "65.00"


def test_price_change_is_audited(admin, menu_lookup):
    item = menu_lookup["Pollo a la brasa"]
    admin.client.patch(f"/api/v1/menu/items/{item['id']}", json={"price": "27.50"})
    from app.db import SessionLocal
    from app.models import AuditLog

    db = SessionLocal()
    try:
        logs = (
            db.query(AuditLog)
            .filter(AuditLog.action == "MENU_PRICE_CHANGED", AuditLog.entity_id == str(item["id"]))
            .all()
        )
        assert logs, "Debe registrarse auditoría de cambio de precio"
        assert logs[-1].after_data["price"] == "27.50"
    finally:
        db.close()


def test_availability_toggle(admin, cocina, mesero, menu_lookup):
    item = menu_lookup["Ensalada mixta"]
    response = cocina.client.patch(f"/api/v1/menu/items/{item['id']}/availability", json={"status": "SOLD_OUT"})
    assert response.status_code == 200
    assert response.json()["availability_status"] == "SOLD_OUT"

    menu = mesero.client.get("/api/v1/menu").json()
    salad = next(i for i in menu["items"] if i["id"] == item["id"])
    assert salad["is_available"] is False

    restored = cocina.client.patch(f"/api/v1/menu/items/{item['id']}/availability", json={"status": "AVAILABLE"})
    assert restored.json()["is_available"] is True


def test_availability_requires_area_role(admin, mesero, menu_lookup):
    item = menu_lookup["Ensalada mixta"]
    response = mesero.client.patch(f"/api/v1/menu/items/{item['id']}/availability", json={"status": "SOLD_OUT"})
    assert response.status_code == 403


def test_tables_crud_and_status(admin, mesero):
    created = admin.client.post("/api/v1/tables", json={"name": "Mesa VIP", "number": 50})
    assert created.status_code == 201
    table_id = created.json()["id"]

    duplicated = admin.client.post("/api/v1/tables", json={"name": "Otra", "number": 50})
    assert duplicated.status_code == 409

    waiter_cannot = mesero.client.post("/api/v1/tables", json={"name": "X", "number": 99})
    assert waiter_cannot.status_code == 403

    updated = admin.client.patch(f"/api/v1/tables/{table_id}", json={"name": "Mesa 50"})
    assert updated.status_code == 200
    assert updated.json()["name"] == "Mesa 50"


def test_unknown_menu_item_returns_404(mesero, open_shift, tables):
    order_response = mesero.client.post(
        "/api/v1/orders",
        json={
            "order_type": "DINE_IN",
            "table_id": tables[0]["id"],
            "persons_count": 2,
        },
    )
    order = order_response.json()
    response = mesero.client.post(
        f"/api/v1/orders/{order['id']}/commands",
        json={"items": [{"menu_item_id": str(uuid.uuid4()), "quantity": 1}]},
    )
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "MENU_ITEM_NOT_FOUND"
