from decimal import Decimal

from tests.conftest import create_command, create_order


def _create_paid_order(
    admin, cocina, parrilla, mesero, menu_lookup, table_number: int, price_item: str = "Pollo a la brasa"
):
    order = create_order(mesero, table_number=table_number, persons=3)
    command = create_command(mesero, order["id"], [{"menu_item_id": menu_lookup[price_item]["id"], "quantity": 1}])
    for item in command["items"]:
        area = item["preparation_area"]
        if area in ("KITCHEN", "GRILL"):
            area_api = cocina if area == "KITCHEN" else parrilla
            for status in ("PREPARING", "READY"):
                response = area_api.client.post(
                    f"/api/v1/orders/{order['id']}/items/{item['id']}/status",
                    json={"status": status},
                )
                assert response.status_code == 200, response.text
        response = mesero.client.post(
            f"/api/v1/orders/{order['id']}/items/{item['id']}/status",
            json={"status": "DELIVERED"},
        )
        assert response.status_code == 200, response.text

    total = _order_total(mesero, order["id"])
    pay = admin.client.post(
        f"/api/v1/orders/{order['id']}/payments",
        json={"method": "CASH", "amount": f"{total:.2f}"},
    )
    assert pay.status_code == 201, pay.text
    return order


def _order_total(api, order_id: str) -> float:
    detail = api.client.get(f"/api/v1/orders/{order_id}").json()
    return float(detail["total"])


def test_only_admin_opens_shift(mesero, open_shift):
    response = mesero.client.post("/api/v1/shifts/open")
    assert response.status_code == 403


def test_open_shift_conflict(admin, open_shift):
    response = admin.client.post("/api/v1/shifts/open")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "SHIFT_ALREADY_OPEN"


def test_close_shift_blocked_by_open_orders(admin, mesero, open_shift, menu_lookup):
    create_order(mesero, table_number=1)
    response = admin.client.post(f"/api/v1/shifts/{open_shift['id']}/close")
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "SHIFT_HAS_OPEN_ORDERS"


def test_close_shift_generates_snapshot(admin, mesero, cocina, parrilla, open_shift, menu_lookup):
    _create_paid_order(admin, cocina, parrilla, mesero, menu_lookup, table_number=1)
    _create_paid_order(admin, cocina, parrilla, mesero, menu_lookup, table_number=2, price_item="Parrilla especial")

    expense = mesero.client.post(
        "/api/v1/expenses",
        json={"amount": "40.00", "description": "Carbón"},
    )
    assert expense.status_code == 201

    purchase = cocina.client.post(
        "/api/v1/purchase-list",
        json={"area": "GRILL", "description": "Comprar carbón", "quantity_text": "10 kg"},
    )
    assert purchase.status_code == 201

    closed = admin.client.post(f"/api/v1/shifts/{open_shift['id']}/close")
    assert closed.status_code == 200, closed.text
    snapshot = closed.json()["snapshot"]
    assert snapshot is not None
    assert Decimal(snapshot["total_sales"]) == Decimal("63.00")
    assert Decimal(snapshot["total_expenses"]) == Decimal("40.00")
    assert Decimal(snapshot["net_result"]) == Decimal("23.00")
    assert snapshot["orders_count"] == 2
    assert snapshot["tables_served"] == 2
    assert snapshot["persons_served"] == 6
    assert snapshot["items_sold"] == 2
    assert snapshot["sales_by_payment_method"]["CASH"] == "63.00"
    assert list(snapshot["sales_by_waiter"]) == ["Ana Mesera"]
    assert snapshot["purchase_list"][0]["description"] == "Comprar carbón"

    again = admin.client.post(f"/api/v1/shifts/{open_shift['id']}/close")
    assert again.status_code == 409

    history = admin.client.get("/api/v1/shifts/history").json()
    assert len(history) == 1
    assert history[0]["status"] == "CLOSED"


def test_no_modifications_after_shift_closed(admin, mesero, cocina, parrilla, open_shift, menu_lookup):
    _create_paid_order(admin, cocina, parrilla, mesero, menu_lookup, table_number=1)
    admin.client.post(f"/api/v1/shifts/{open_shift['id']}/close")

    response = mesero.client.post("/api/v1/orders", json={"order_type": "TAKEAWAY"})
    assert response.status_code == 404
    assert response.json()["error"]["code"] == "NO_OPEN_SHIFT"


def test_expenses_and_receipt(admin, mesero, open_shift):
    response = mesero.client.post(
        "/api/v1/expenses",
        json={"amount": "15.50", "description": "Hielo", "receipt_url": "/uploads/abc.jpg"},
    )
    assert response.status_code == 201
    listed = mesero.client.get("/api/v1/expenses/current-shift").json()
    assert len(listed) == 1
    assert listed[0]["created_by_name"] == "Ana Mesera"
    assert listed[0]["receipt_url"] == "/uploads/abc.jpg"

    invalid = mesero.client.post("/api/v1/expenses", json={"amount": "-1", "description": "x"})
    assert invalid.status_code == 422


def test_purchase_list_permissions(cocina, mesero, open_shift):
    created = cocina.client.post("/api/v1/purchase-list", json={"area": "KITCHEN", "description": "Comprar papas"})
    assert created.status_code == 201
    forbidden = mesero.client.post("/api/v1/purchase-list", json={"area": "KITCHEN", "description": "x"})
    assert forbidden.status_code == 403
    item_id = created.json()["id"]
    assert cocina.client.delete(f"/api/v1/purchase-list/{item_id}").status_code == 204


def test_reports_sales_products_and_preparation(admin, mesero, cocina, parrilla, open_shift, menu_lookup):
    _create_paid_order(admin, cocina, parrilla, mesero, menu_lookup, table_number=1)
    _create_paid_order(admin, cocina, parrilla, mesero, menu_lookup, table_number=2, price_item="Anticuchos")

    sales = admin.client.get("/api/v1/reports/sales").json()
    assert Decimal(sales["total_sales"]) == Decimal("43.00")
    assert sales["orders_count"] == 2
    assert sales["persons_served"] == 6

    products = admin.client.get("/api/v1/reports/products").json()
    names = {line["name"]: line["quantity"] for line in products["lines"]}
    assert names["Pollo a la brasa"] == 1
    assert names["Anticuchos"] == 1
    assert products["total_items_sold"] == 2

    preparation = admin.client.get("/api/v1/reports/preparation").json()
    areas = {line["area"] for line in preparation["lines"]}
    assert "KITCHEN" in areas
    assert "GRILL" in areas

    current = admin.client.get("/api/v1/reports/current-shift").json()
    assert Decimal(current["total_sales"]) == Decimal("43.00")


def test_waiter_filter_in_sales_report(admin, mesero, cocina, parrilla, open_shift, menu_lookup):
    _create_paid_order(admin, cocina, parrilla, mesero, menu_lookup, table_number=1)
    sales = admin.client.get(
        "/api/v1/reports/sales", params={"waiter_id": mesero.client.get("/api/v1/auth/me").json()["id"]}
    ).json()
    assert Decimal(sales["total_sales"]) == Decimal("25.00")
