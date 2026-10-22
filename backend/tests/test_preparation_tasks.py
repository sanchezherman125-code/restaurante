"""Platos preparados en varias áreas: un producto comercial, varias tareas internas."""

import uuid
from decimal import Decimal

import pytest
from sqlalchemy import text

from app.db import SessionLocal
from app.models import AuditLog, MenuItem, Order, OrderItem, OrderItemPreparationTask, Payment
from app.services.preparation import backfill_missing_tasks
from tests.conftest import create_command, create_order
from tests.test_concurrency import _post_requests_concurrently, _token
from tests.test_e2e import client_session

ALITAS_STEPS = [
    {"name": "Preparar alitas", "area": "GRILL", "expected_minutes": 12},
    {"name": "Preparar papas", "area": "KITCHEN", "expected_minutes": 7},
]


@pytest.fixture
def events(monkeypatch):
    recorded: list[tuple[str, dict, set | None]] = []
    monkeypatch.setattr("app.ws.hub.hub.broadcast", lambda e, p, c=None: recorded.append((e, p, c)))
    return recorded


def make_dish(admin, *, name="Alitas con papas", price="25.00", steps=None) -> dict:
    category = admin.client.get("/api/v1/menu").json()["categories"][0]
    response = admin.client.post("/api/v1/menu/items", json={
        "category_id": category["id"], "name": name, "price": price,
        "requires_preparation": True, "preparation_steps": steps or ALITAS_STEPS,
    })
    assert response.status_code == 201, response.text
    return response.json()


@pytest.fixture
def alitas(admin):
    dish = make_dish(admin)
    yield dish
    with SessionLocal() as db:
        db.query(MenuItem).filter(MenuItem.id == dish["id"]).update({"is_active": False})
        db.commit()


def order_with_dish(mesero, dish, quantity=1, table_number=1) -> tuple[dict, dict]:
    order = create_order(mesero, table_number=table_number)
    command = create_command(mesero, order["id"], [{"menu_item_id": dish["id"], "quantity": quantity}])
    return order, command["items"][0]


def task_of(item: dict, area: str) -> dict:
    return next(t for t in item["tasks"] if t["area"] == area)


def set_task(api, order_id, item, area, status, **extra):
    return api.client.post(
        f"/api/v1/orders/{order_id}/items/{item['id']}/tasks/{task_of(item, area)['id']}/status",
        json={"status": status, **extra},
    )


def get_item(api, order_id, item_id) -> dict:
    order = api.client.get(f"/api/v1/orders/{order_id}").json()
    return next(i for i in order["items"] if i["id"] == item_id)


def ready_events(events):
    return [e for e in events if e[0] == "order_item.ready"]


def board(api, area):
    return api.client.get(f"/api/v1/preparation/{area}").json()


# --- catálogo -------------------------------------------------------------------------------------------


def test_admin_defines_multi_area_recipe_with_single_price(admin, alitas):
    assert alitas["price"] == "25.00"
    assert [(s["name"], s["area"], s["expected_minutes"], s["sort_order"]) for s in alitas["preparation_steps"]] == [
        ("Preparar alitas", "GRILL", 12, 0), ("Preparar papas", "KITCHEN", 7, 1),
    ]
    # Resumen derivado para clientes antiguos: área principal y tiempo crítico (tareas en paralelo).
    assert alitas["preparation_area"] == "GRILL"
    assert alitas["expected_prep_minutes"] == 12


@pytest.mark.parametrize("steps", [
    [{"name": "", "area": "KITCHEN"}],
    [{"name": "   ", "area": "KITCHEN"}],
    [{"name": "x", "area": "WAITER"}],
    [{"name": "x", "area": "BAR"}],
    [{"name": "x", "area": "KITCHEN", "expected_minutes": -1}],
    [{"name": "x", "area": "KITCHEN", "expected_minutes": 601}],
    [{"name": "x", "area": "KITCHEN", "is_active": False}],
    [{"name": f"t{i}", "area": "KITCHEN"} for i in range(13)],
])
def test_recipe_validation(admin, steps):
    category = admin.client.get("/api/v1/menu").json()["categories"][0]
    response = admin.client.post("/api/v1/menu/items", json={
        "category_id": category["id"], "name": "Plato inválido", "price": "10.00", "preparation_steps": steps,
    })
    assert response.status_code == 422


def test_direct_delivery_product_cannot_have_steps(admin):
    category = admin.client.get("/api/v1/menu").json()["categories"][0]
    response = admin.client.post("/api/v1/menu/items", json={
        "category_id": category["id"], "name": "Gaseosa", "price": "5.00", "requires_preparation": False,
        "preparation_area": None, "preparation_steps": ALITAS_STEPS,
    })
    assert response.status_code == 422


def test_single_step_and_same_area_steps_are_supported(admin):
    single = make_dish(admin, name="Sopa", steps=[{"name": "Sopa", "area": "KITCHEN", "expected_minutes": 9}])
    same_area = make_dish(admin, name="Combo cocina", steps=[
        {"name": "Freír", "area": "KITCHEN", "expected_minutes": 8},
        {"name": "Armar", "area": "KITCHEN", "expected_minutes": 3},
    ])
    assert len(single["preparation_steps"]) == 1 and single["preparation_area"] == "KITCHEN"
    assert [s["area"] for s in same_area["preparation_steps"]] == ["KITCHEN", "KITCHEN"]


def test_legacy_single_area_create_still_works_and_creates_one_step(admin):
    category = admin.client.get("/api/v1/menu").json()["categories"][0]
    response = admin.client.post("/api/v1/menu/items", json={
        "category_id": category["id"], "name": "Legacy", "price": "10.00",
        "preparation_area": "GRILL", "expected_prep_minutes": 14,
    })
    assert response.status_code == 201
    steps = response.json()["preparation_steps"]
    assert [(s["name"], s["area"], s["expected_minutes"]) for s in steps] == [("Legacy", "GRILL", 14)]


def test_update_reorders_edits_and_deletes_steps(admin, alitas):
    papas, alitas_step = alitas["preparation_steps"][1], alitas["preparation_steps"][0]
    response = admin.client.patch(f"/api/v1/menu/items/{alitas['id']}", json={"preparation_steps": [
        {"id": papas["id"], "name": "Freír papas", "area": "KITCHEN", "expected_minutes": 9},
        {"id": alitas_step["id"], "name": "Preparar alitas", "area": "GRILL", "expected_minutes": 12},
        {"name": "Salsas", "area": "KITCHEN", "expected_minutes": 2},
    ]})
    assert response.status_code == 200, response.text
    steps = response.json()["preparation_steps"]
    assert [s["name"] for s in steps] == ["Freír papas", "Preparar alitas", "Salsas"]
    assert steps[0]["id"] == papas["id"]  # se conserva la identidad al editar
    assert response.json()["preparation_area"] == "KITCHEN"
    response = admin.client.patch(f"/api/v1/menu/items/{alitas['id']}", json={"preparation_steps": [
        {"id": alitas_step["id"], "name": "Preparar alitas", "area": "GRILL", "expected_minutes": 12},
    ]})
    assert [s["name"] for s in response.json()["preparation_steps"]] == ["Preparar alitas"]
    with SessionLocal() as db:
        assert db.query(AuditLog).filter(AuditLog.action == "MENU_PREPARATION_CHANGED").count() == 2


def test_update_rejects_empty_steps_and_foreign_step_ids(admin, alitas):
    assert admin.client.patch(f"/api/v1/menu/items/{alitas['id']}", json={"preparation_steps": []}).status_code == 422
    other = make_dish(admin, name="Otro", steps=[{"name": "Otro", "area": "KITCHEN"}])
    foreign = other["preparation_steps"][0]["id"]
    response = admin.client.patch(f"/api/v1/menu/items/{alitas['id']}", json={"preparation_steps": [
        {"id": foreign, "name": "x", "area": "KITCHEN"},
    ]})
    assert response.status_code == 409


def test_legacy_edit_of_multi_step_product_is_refused_instead_of_corrupting_recipe(admin, alitas):
    response = admin.client.patch(f"/api/v1/menu/items/{alitas['id']}", json={"preparation_area": "KITCHEN"})
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "PREPARATION_STEPS_REQUIRED"
    assert len(admin.client.get("/api/v1/menu").json()["items"]) > 0
    # Un cambio ajeno a la preparación (o reenviar requires_preparation=true) no toca la receta.
    assert admin.client.patch(f"/api/v1/menu/items/{alitas['id']}", json={"price": "26.00"}).status_code == 200
    resent = admin.client.patch(f"/api/v1/menu/items/{alitas['id']}", json={"requires_preparation": True})
    assert resent.status_code == 200
    assert [s["name"] for s in resent.json()["preparation_steps"]] == ["Preparar alitas", "Preparar papas"]


def test_only_admin_edits_recipes(mesero, cocina, alitas):
    for api in (mesero, cocina):
        response = api.client.patch(f"/api/v1/menu/items/{alitas['id']}", json={"preparation_steps": [
            {"name": "x", "area": "KITCHEN"},
        ]})
        assert response.status_code == 403


# --- comanda y tableros ---------------------------------------------------------------------------------


def test_shared_dish_is_one_item_one_charge_two_tasks(mesero, alitas, open_shift):
    order, item = order_with_dish(mesero, alitas)
    assert item["menu_item_name_snapshot"] == "Alitas con papas"
    assert len(item["tasks"]) == 2
    assert {(t["name"], t["area"], t["status"], t["expected_minutes"]) for t in item["tasks"]} == {
        ("Preparar alitas", "GRILL", "PENDING", 12), ("Preparar papas", "KITCHEN", "PENDING", 7),
    }
    assert all("price" not in t and "unit_price_snapshot" not in t for t in item["tasks"])
    detail = mesero.client.get(f"/api/v1/orders/{order['id']}").json()
    assert len(detail["items"]) == 1
    assert Decimal(detail["total"]) == Decimal("25.00")
    billing = mesero.client.get(f"/api/v1/orders/{order['id']}/billing").json()
    assert [(i["name"], i["quantity"], i["total"]) for i in billing["items"]] == [("Alitas con papas", 1, "25.00")]


def test_each_board_shows_only_its_task_with_other_area_progress(mesero, cocina, parrilla, alitas, open_shift):
    order_with_dish(mesero, alitas)
    kitchen = board(cocina, "kitchen")
    grill = board(parrilla, "grill")
    assert [t["name"] for g in kitchen for t in g["tasks"]] == ["Preparar papas"]
    assert [t["name"] for g in grill for t in g["tasks"]] == ["Preparar alitas"]
    kt = kitchen[0]["tasks"][0]
    assert kt["item_name"] == "Alitas con papas" and kt["quantity"] == 1 and kt["expected_minutes"] == 7
    assert [(o["name"], o["area"], o["status"]) for o in kt["other_tasks"]] == [("Preparar alitas", "GRILL", "PENDING")]
    assert kitchen[0]["other_areas"] == {"GRILL": "PENDING"}
    assert grill[0]["other_areas"] == {"KITCHEN": "PENDING"}


def test_command_notification_reaches_only_participating_areas(mesero, alitas, menu_lookup, open_shift, events):
    order = create_order(mesero)
    create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])  # solo cocina
    _, payload, channels = next(e for e in events if e[0] == "command.created")
    assert payload["areas"] == ["KITCHEN"]
    assert channels == {"admin", "waiters", "kitchen"}
    events.clear()
    order2 = create_order(mesero, table_number=2)
    create_command(mesero, order2["id"], [{"menu_item_id": alitas["id"]}])
    _, payload, channels = next(e for e in events if e[0] == "command.created")
    assert payload["areas"] == ["GRILL", "KITCHEN"]
    assert channels == {"admin", "waiters", "kitchen", "grill"}
    events.clear()
    order3 = create_order(mesero, table_number=3)
    create_command(mesero, order3["id"], [{"menu_item_id": menu_lookup["Inca Kola 500ml"]["id"]}])  # directo
    _, payload, channels = next(e for e in events if e[0] == "command.created")
    assert payload["areas"] == [] and channels == {"admin", "waiters"}


def test_areas_only_modify_their_own_tasks(mesero, cocina, parrilla, alitas, open_shift):
    order, item = order_with_dish(mesero, alitas)
    assert set_task(cocina, order["id"], item, "GRILL", "PREPARING").status_code == 403
    assert set_task(parrilla, order["id"], item, "KITCHEN", "PREPARING").status_code == 403
    assert set_task(mesero, order["id"], item, "KITCHEN", "PREPARING").status_code == 403
    assert set_task(cocina, order["id"], item, "KITCHEN", "PREPARING").status_code == 200
    assert get_item(mesero, order["id"], item["id"])["status"] == "PREPARING"
    assert task_of(get_item(mesero, order["id"], item["id"]), "GRILL")["status"] == "PENDING"


def test_admin_manages_both_areas(admin, mesero, alitas, open_shift):
    order, item = order_with_dish(mesero, alitas)
    for area in ("KITCHEN", "GRILL"):
        assert set_task(admin, order["id"], item, area, "PREPARING").status_code == 200
        assert set_task(admin, order["id"], item, area, "READY").status_code == 200
    assert get_item(admin, order["id"], item["id"])["status"] == "READY"


@pytest.mark.parametrize("first,second", [("KITCHEN", "GRILL"), ("GRILL", "KITCHEN")])
def test_dish_is_ready_only_when_both_tasks_are_ready(
    mesero, cocina, parrilla, alitas, open_shift, events, first, second,
):
    apis = {"KITCHEN": cocina, "GRILL": parrilla}
    order, item = order_with_dish(mesero, alitas)
    for area in (first, second):
        assert set_task(apis[area], order["id"], item, area, "PREPARING").status_code == 200
    detail = get_item(mesero, order["id"], item["id"])
    assert detail["status"] == "PREPARING" and detail["preparation_started_at"] is not None

    response = set_task(apis[first], order["id"], item, first, "READY")
    assert response.status_code == 200
    detail = get_item(mesero, order["id"], item["id"])
    assert detail["status"] == "PREPARING" and detail["ready_at"] is None
    assert mesero.client.get(f"/api/v1/orders/{order['id']}").json()["status"] == "IN_PREPARATION"
    assert ready_events(events) == []  # no se anuncia un plato a medias
    # La otra área ve el avance y sigue viendo su tarea pendiente.
    other_board = board(apis[second], "kitchen" if second == "KITCHEN" else "grill")
    assert other_board[0]["tasks"][0]["other_tasks"][0]["status"] == "READY"
    # Ni siquiera con la tarea propia terminada puede entregarse el plato.
    blocked = mesero.client.post(
        f"/api/v1/orders/{order['id']}/items/{item['id']}/status", json={"status": "DELIVERED"},
    )
    assert blocked.status_code == 409

    assert set_task(apis[second], order["id"], item, second, "READY").status_code == 200
    detail = get_item(mesero, order["id"], item["id"])
    assert detail["status"] == "READY" and detail["ready_at"] is not None
    assert mesero.client.get(f"/api/v1/orders/{order['id']}").json()["status"] == "READY"
    assert len(ready_events(events)) == 1

    delivered = mesero.client.post(f"/api/v1/orders/{order['id']}/items/{item['id']}/status",
                                   json={"status": "DELIVERED"})
    assert delivered.status_code == 200
    assert get_item(mesero, order["id"], item["id"])["status"] == "DELIVERED"
    assert len(ready_events(events)) == 1


def test_waiter_gets_exactly_one_ready_notification_and_areas_get_progress_events(
    mesero, cocina, parrilla, alitas, open_shift, events,
):
    from app.services.push import notification_for

    order, item = order_with_dish(mesero, alitas)
    set_task(cocina, order["id"], item, "KITCHEN", "PREPARING")
    set_task(cocina, order["id"], item, "KITCHEN", "READY")
    set_task(parrilla, order["id"], item, "GRILL", "PREPARING")
    set_task(parrilla, order["id"], item, "GRILL", "READY")
    ready = ready_events(events)
    assert len(ready) == 1
    _, payload, channels = ready[0]
    assert channels == {"waiters", "admin"}
    assert payload["created_by_waiter_id"] == order["created_by_waiter_id"]
    assert payload["areas"] == ["GRILL", "KITCHEN"]
    _, roles = notification_for("order_item.ready", payload)
    assert roles == {"ADMIN", "WAITER"}
    progress = [e for e in events if e[0] == "preparation_task.updated"]
    assert [(e[1]["task_area"], e[1]["task_status"]) for e in progress] == [
        ("KITCHEN", "PREPARING"), ("KITCHEN", "READY"), ("GRILL", "PREPARING"), ("GRILL", "READY"),
    ]
    assert all(e[2] == {"admin", "kitchen", "grill"} for e in progress)
    assert "Preparar" not in str(notification_for("preparation_task.updated", payload))  # no es evento push


def test_repeated_stale_and_skipped_updates(mesero, cocina, alitas, open_shift, events):
    order, item = order_with_dish(mesero, alitas)
    assert set_task(cocina, order["id"], item, "KITCHEN", "READY").status_code == 409  # no se salta PREPARING
    assert set_task(cocina, order["id"], item, "KITCHEN", "PREPARING").status_code == 200
    started = task_of(get_item(mesero, order["id"], item["id"]), "KITCHEN")["started_at"]
    # Un PREPARING repetido o atrasado no cambia nada ni emite eventos.
    count = len(events)
    assert set_task(cocina, order["id"], item, "KITCHEN", "PREPARING").status_code == 200
    assert len(events) == count
    assert set_task(cocina, order["id"], item, "KITCHEN", "READY").status_code == 200
    assert set_task(cocina, order["id"], item, "KITCHEN", "PREPARING").status_code == 200  # llegó tarde
    refreshed = task_of(get_item(mesero, order["id"], item["id"]), "KITCHEN")
    assert refreshed["status"] == "READY" and refreshed["started_at"] == started
    assert set_task(cocina, order["id"], item, "KITCHEN", "READY").status_code == 200
    with SessionLocal() as db:
        assert db.query(AuditLog).filter(AuditLog.action == "TASK_STATUS_CHANGED").count() == 2


def test_task_status_rejects_non_forward_values(cocina, mesero, alitas, open_shift):
    order, item = order_with_dish(mesero, alitas)
    for bad in ("PENDING", "CANCELLED", "DELIVERED"):
        assert set_task(cocina, order["id"], item, "KITCHEN", bad).status_code == 422


def test_task_update_is_idempotent_by_operation_id(mesero, cocina, parrilla, alitas, open_shift, events):
    order, item = order_with_dish(mesero, alitas)
    key = str(uuid.uuid4())
    first = set_task(cocina, order["id"], item, "KITCHEN", "PREPARING", client_operation_id=key)
    replay = set_task(cocina, order["id"], item, "KITCHEN", "PREPARING", client_operation_id=key)
    assert first.status_code == replay.status_code == 200 and first.json() == replay.json()
    # Misma clave reutilizada por otro usuario o con otra operación no se acepta.
    assert set_task(parrilla, order["id"], item, "GRILL", "PREPARING", client_operation_id=key).status_code == 409
    assert len([e for e in events if e[0] == "preparation_task.updated"]) == 1


def test_item_level_endpoint_only_moves_the_callers_area(mesero, cocina, parrilla, alitas, open_shift):
    """Compatibilidad: operaciones offline antiguas usan /items/{id}/status."""
    order, item = order_with_dish(mesero, alitas)
    path = f"/api/v1/orders/{order['id']}/items/{item['id']}/status"
    assert cocina.client.post(path, json={"status": "PREPARING"}).status_code == 200
    assert cocina.client.post(path, json={"status": "READY"}).status_code == 200
    detail = get_item(mesero, order["id"], item["id"])
    assert task_of(detail, "KITCHEN")["status"] == "READY" and task_of(detail, "GRILL")["status"] == "PENDING"
    assert detail["status"] == "PREPARING"
    assert parrilla.client.post(path, json={"status": "READY"}).status_code == 409  # sin PREPARING previo
    assert parrilla.client.post(path, json={"status": "PREPARING"}).status_code == 200
    assert parrilla.client.post(path, json={"status": "READY"}).status_code == 200
    assert get_item(mesero, order["id"], item["id"])["status"] == "READY"
    mutated = cocina.client.post(path, json={"status": "READY"}).json()  # reintento tardío
    assert all(t["status"] == "READY" for t in mutated["items"][0]["tasks"])


def test_concurrent_completion_emits_one_ready_event(mesero, alitas, open_shift, events, cocina, parrilla):
    tokens = {"KITCHEN": _token("cocina1"), "GRILL": _token("parrilla1")}
    for round_number in range(1, 4):
        order, item = order_with_dish(mesero, alitas, table_number=round_number)
        for area, api in (("KITCHEN", cocina), ("GRILL", parrilla)):
            assert set_task(api, order["id"], item, area, "PREPARING").status_code == 200
        requests = [
            (f"/api/v1/orders/{order['id']}/items/{item['id']}/tasks/{task_of(item, area)['id']}/status",
             {"status": "READY"}, tokens[area])
            for area in ("KITCHEN", "GRILL")
        ]
        assert _post_requests_concurrently(requests) == [200, 200]
        assert get_item(mesero, order["id"], item["id"])["status"] == "READY"
        assert len([e for e in ready_events(events) if e[1]["item_id"] == item["id"]]) == 1
    assert len(ready_events(events)) == 3


def test_concurrent_duplicate_taps_are_harmless(mesero, alitas, open_shift, events, cocina):
    order, item = order_with_dish(mesero, alitas)
    token = _token("cocina1")
    path = f"/api/v1/orders/{order['id']}/items/{item['id']}/tasks/{task_of(item, 'KITCHEN')['id']}/status"
    assert _post_requests_concurrently([(path, {"status": "PREPARING"}, token)] * 3) == [200, 200, 200]
    assert len([e for e in events if e[0] == "preparation_task.updated"]) == 1


def test_three_units_are_one_line_with_two_tasks(mesero, cocina, parrilla, admin, alitas, open_shift, events):
    order, item = order_with_dish(mesero, alitas, quantity=3)
    assert item["quantity"] == 3 and len(item["tasks"]) == 2
    detail = mesero.client.get(f"/api/v1/orders/{order['id']}").json()
    assert Decimal(detail["total"]) == Decimal("75.00")
    assert board(cocina, "kitchen")[0]["tasks"][0]["quantity"] == 3
    for area, api in (("KITCHEN", cocina), ("GRILL", parrilla)):
        set_task(api, order["id"], item, area, "PREPARING")
        set_task(api, order["id"], item, area, "READY")
    assert len(ready_events(events)) == 1
    mesero.client.post(f"/api/v1/orders/{order['id']}/items/{item['id']}/status", json={"status": "DELIVERED"})
    pay = admin.client.post(f"/api/v1/orders/{order['id']}/payments", json={"method": "YAPE", "amount": "75.00"})
    assert pay.status_code == 201 and pay.json()["became_paid"] is True
    products = admin.client.get("/api/v1/reports/products").json()
    line = next(row for row in products["lines"] if row["name"] == "Alitas con papas")
    assert (line["quantity"], Decimal(line["revenue"])) == (3, Decimal("75.00"))
    assert products["total_items_sold"] == 3
    sales = admin.client.get("/api/v1/reports/current-shift").json()
    assert Decimal(sales["total_sales"]) == Decimal("75.00")


# --- cancelaciones --------------------------------------------------------------------------------------


def test_cancel_before_start_cancels_dish_and_all_tasks_once(mesero, cocina, parrilla, alitas, open_shift, events):
    order, item = order_with_dish(mesero, alitas)
    response = mesero.client.post(f"/api/v1/orders/{order['id']}/items/{item['id']}/cancel", json={"reason": "x"})
    assert response.status_code == 200
    detail = get_item(mesero, order["id"], item["id"])
    assert detail["status"] == "CANCELLED" and detail["cancelled_after_preparation_started"] is False
    assert {t["status"] for t in detail["tasks"]} == {"CANCELLED"}
    order_detail = mesero.client.get(f"/api/v1/orders/{order['id']}").json()
    assert Decimal(order_detail["total"]) == Decimal("0.00")
    assert board(cocina, "kitchen") == [] and board(parrilla, "grill") == []
    # Una cancelación repetida es un conflicto y no descuenta dos veces.
    again = mesero.client.post(f"/api/v1/orders/{order['id']}/items/{item['id']}/cancel", json={"reason": "x"})
    assert again.status_code == 409
    assert set_task(cocina, order["id"], item, "KITCHEN", "PREPARING").status_code == 409
    assert ready_events(events) == []


def test_cancel_during_preparation_cancels_every_area(mesero, cocina, parrilla, admin, alitas, open_shift, menu_lookup):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [
        {"menu_item_id": alitas["id"]}, {"menu_item_id": menu_lookup["Inca Kola 500ml"]["id"]},
    ])
    item = next(i for i in command["items"] if i["menu_item_name_snapshot"] == "Alitas con papas")
    set_task(cocina, order["id"], item, "KITCHEN", "PREPARING")
    set_task(cocina, order["id"], item, "KITCHEN", "READY")
    set_task(parrilla, order["id"], item, "GRILL", "PREPARING")
    # El área puede cancelar el plato completo; el efecto alcanza también a la otra área.
    response = parrilla.client.post(
        f"/api/v1/orders/{order['id']}/items/{item['id']}/cancel", json={"reason": "sin gas"},
    )
    assert response.status_code == 200
    detail = get_item(admin, order["id"], item["id"])
    assert detail["status"] == "CANCELLED" and detail["cancelled_after_preparation_started"] is True
    assert {t["status"] for t in detail["tasks"]} == {"CANCELLED"}
    assert Decimal(admin.client.get(f"/api/v1/orders/{order['id']}").json()["total"]) == Decimal("6.00")
    assert board(cocina, "kitchen") == []
    with SessionLocal() as db:
        assert db.query(AuditLog).filter(AuditLog.action == "ITEM_CANCELLED").count() == 1


def test_waiter_of_another_order_and_unrelated_area_cannot_cancel(mesero, cocina, menu_lookup, open_shift):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Parrilla especial"]["id"]}])
    item = command["items"][0]
    assert cocina.client.post(f"/api/v1/orders/{order['id']}/items/{item['id']}/cancel", json={}).status_code == 403


@pytest.mark.parametrize("blocked_status,code", [("PAID", "ORDER_ALREADY_PAID"), ("CLOSED", "ORDER_ALREADY_CLOSED")])
def test_cancellation_rejected_for_paid_or_closed_orders(
    admin, mesero, alitas, open_shift, blocked_status, code,
):
    order, item = order_with_dish(mesero, alitas)
    if blocked_status == "PAID":
        assert admin.client.post(f"/api/v1/orders/{order['id']}/payments",
                                 json={"method": "CASH", "amount": "25.00"}).status_code == 201
    else:
        with SessionLocal() as db:
            db.execute(text("UPDATE orders SET status = 'CLOSED' WHERE id = :id"), {"id": order["id"]})
            db.commit()
    response = mesero.client.post(f"/api/v1/orders/{order['id']}/items/{item['id']}/cancel", json={"reason": "x"})
    assert response.status_code == 409 and response.json()["error"]["code"] == code
    detail = get_item(admin, order["id"], item["id"])
    assert detail["status"] == "PENDING" and {t["status"] for t in detail["tasks"]} == {"PENDING"}


# --- pago anticipado ------------------------------------------------------------------------------------


def test_paid_order_stays_on_boards_and_can_finish_preparation(
    admin, mesero, cocina, parrilla, alitas, open_shift, events,
):
    order, item = order_with_dish(mesero, alitas)
    pay = admin.client.post(f"/api/v1/orders/{order['id']}/payments", json={"method": "YAPE", "amount": "25.00"})
    assert pay.json()["became_paid"] is True
    assert mesero.client.get(f"/api/v1/orders/{order['id']}").json()["status"] == "PAID"
    # Estado financiero ≠ progreso de preparación: sigue visible en ambos tableros y para el mesero.
    assert [t["name"] for g in board(cocina, "kitchen") for t in g["tasks"]] == ["Preparar papas"]
    assert [t["name"] for g in board(parrilla, "grill") for t in g["tasks"]] == ["Preparar alitas"]
    assert board(cocina, "kitchen")[0]["order_general_status"] == "PAID"
    assert order["id"] in [o["id"] for o in mesero.client.get("/api/v1/orders/active").json()]
    assert order["id"] in [o["id"] for o in admin.client.get("/api/v1/orders/active?area=GRILL").json()]
    # El turno no puede cerrarse con un plato cobrado pero sin preparar.
    blocked = admin.client.post(f"/api/v1/shifts/{open_shift['id']}/close")
    assert blocked.status_code == 409 and blocked.json()["error"]["code"] == "SHIFT_HAS_OPEN_ORDERS"

    for area, api in (("KITCHEN", cocina), ("GRILL", parrilla)):
        assert set_task(api, order["id"], item, area, "PREPARING").status_code == 200
        assert set_task(api, order["id"], item, area, "READY").status_code == 200
    assert len(ready_events(events)) == 1
    assert mesero.client.get(f"/api/v1/orders/{order['id']}").json()["status"] == "PAID"  # no regresa a READY
    assert mesero.client.post(f"/api/v1/orders/{order['id']}/items/{item['id']}/status",
                              json={"status": "DELIVERED"}).status_code == 200
    assert board(cocina, "kitchen") == [] and board(parrilla, "grill") == []
    assert order["id"] not in [o["id"] for o in mesero.client.get("/api/v1/orders/active").json()]
    assert admin.client.post(f"/api/v1/shifts/{open_shift['id']}/close").status_code == 200
    with SessionLocal() as db:
        assert db.get(Order, order["id"]).paid_amount == Decimal("25.00")
        assert db.query(Payment).filter(Payment.order_id == order["id"]).count() == 1


def test_closed_orders_never_appear_on_boards(mesero, cocina, alitas, open_shift):
    order, _ = order_with_dish(mesero, alitas)
    with SessionLocal() as db:
        db.execute(text("UPDATE orders SET status = 'CLOSED' WHERE id = :id"), {"id": order["id"]})
        db.commit()
    assert board(cocina, "kitchen") == []


# --- receta versionada y datos históricos ---------------------------------------------------------------


def test_recipe_change_does_not_alter_existing_orders(admin, mesero, cocina, parrilla, alitas, open_shift):
    order, item = order_with_dish(mesero, alitas)
    original = [(t["name"], t["area"], t["expected_minutes"]) for t in item["tasks"]]
    papas = alitas["preparation_steps"][1]
    assert admin.client.patch(f"/api/v1/menu/items/{alitas['id']}", json={"preparation_steps": [
        {"id": papas["id"], "name": "Papas al horno", "area": "KITCHEN", "expected_minutes": 20},
    ]}).status_code == 200
    detail = get_item(mesero, order["id"], item["id"])
    assert [(t["name"], t["area"], t["expected_minutes"]) for t in detail["tasks"]] == original
    assert detail["expected_prep_minutes_snapshot"] == 12
    assert [t["name"] for g in board(parrilla, "grill") for t in g["tasks"]] == ["Preparar alitas"]
    # Una comanda nueva usa la receta nueva.
    order2 = create_order(mesero, table_number=2)
    new_item = create_command(mesero, order2["id"], [{"menu_item_id": alitas["id"]}])["items"][0]
    assert [(t["name"], t["area"]) for t in new_item["tasks"]] == [("Papas al horno", "KITCHEN")]
    # Y se puede terminar el pedido viejo cuyo paso ya no existe en el catálogo.
    for area, api in (("KITCHEN", cocina), ("GRILL", parrilla)):
        set_task(api, order["id"], item, area, "PREPARING")
        set_task(api, order["id"], item, area, "READY")
    assert get_item(mesero, order["id"], item["id"])["status"] == "READY"


def test_product_without_steps_gets_equivalent_single_task(mesero, cocina, open_shift):
    with SessionLocal() as db:
        legacy = MenuItem(category_id=db.query(MenuItem).first().category_id, name="Sin receta",
                          price=Decimal("7.00"), preparation_area="GRILL", requires_preparation=True,
                          expected_prep_minutes=6)
        db.add(legacy)
        db.commit()
        legacy_id = str(legacy.id)
    order = create_order(mesero)
    item = create_command(mesero, order["id"], [{"menu_item_id": legacy_id}])["items"][0]
    assert [(t["name"], t["area"], t["expected_minutes"]) for t in item["tasks"]] == [("Sin receta", "GRILL", 6)]
    with SessionLocal() as db:
        db.query(MenuItem).filter(MenuItem.id == legacy_id).update({"is_active": False})
        db.commit()


def test_items_created_by_an_older_instance_get_a_task_and_keep_working(mesero, cocina, menu_lookup, open_shift):
    order = create_order(mesero)
    item = create_command(mesero, order["id"], [{"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}])["items"][0]
    with SessionLocal() as db:
        db.query(OrderItemPreparationTask).filter(OrderItemPreparationTask.order_item_id == item["id"]).delete()
        db.commit()
    assert board(cocina, "kitchen") == []  # visible solo tras el relleno
    with SessionLocal() as db:
        assert backfill_missing_tasks(db) == 1
        assert backfill_missing_tasks(db) == 0  # idempotente
    assert len(board(cocina, "kitchen")[0]["tasks"]) == 1
    with SessionLocal() as db:
        db.query(OrderItemPreparationTask).filter(OrderItemPreparationTask.order_item_id == item["id"]).delete()
        db.commit()
    path = f"/api/v1/orders/{order['id']}/items/{item['id']}/status"
    assert cocina.client.post(path, json={"status": "PREPARING"}).status_code == 200  # reparación perezosa
    assert get_item(mesero, order["id"], item["id"])["tasks"][0]["status"] == "PREPARING"


def test_single_area_products_and_direct_items_keep_their_flows(
    mesero, cocina, parrilla, menu_lookup, open_shift, events,
):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [
        {"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]},
        {"menu_item_id": menu_lookup["Parrilla especial"]["id"]},
        {"menu_item_id": menu_lookup["Inca Kola 500ml"]["id"]},
    ])
    chicken, grill_item, soda = (next(i for i in command["items"] if i["menu_item_name_snapshot"] == n)
                                 for n in ("Pollo a la brasa", "Parrilla especial", "Inca Kola 500ml"))
    assert [t["area"] for t in chicken["tasks"]] == ["KITCHEN"]
    assert [t["area"] for t in grill_item["tasks"]] == ["GRILL"]
    assert soda["tasks"] == [] and soda["status"] == "PENDING"
    set_task(cocina, order["id"], chicken, "KITCHEN", "PREPARING")
    set_task(cocina, order["id"], chicken, "KITCHEN", "READY")
    assert get_item(mesero, order["id"], chicken["id"])["status"] == "READY"  # una sola tarea → plato listo
    assert len(ready_events(events)) == 1
    assert mesero.client.post(f"/api/v1/orders/{order['id']}/items/{soda['id']}/status",
                              json={"status": "DELIVERED"}).status_code == 200


# --- reportes -------------------------------------------------------------------------------------------


def test_reports_do_not_multiply_by_task(admin, mesero, cocina, parrilla, alitas, open_shift):
    order, item = order_with_dish(mesero, alitas, quantity=2)
    for area, api in (("KITCHEN", cocina), ("GRILL", parrilla)):
        set_task(api, order["id"], item, area, "PREPARING")
        set_task(api, order["id"], item, area, "READY")
    mesero.client.post(f"/api/v1/orders/{order['id']}/items/{item['id']}/status", json={"status": "DELIVERED"})
    assert admin.client.post(f"/api/v1/orders/{order['id']}/payments",
                             json={"method": "CARD", "amount": "50.00"}).status_code == 201
    report = admin.client.get(f"/api/v1/shifts/{open_shift['id']}/report").json()
    assert report["products"]["total_items_sold"] == 2
    assert [(line["name"], line["quantity"], Decimal(line["revenue"])) for line in report["products"]["lines"]] == [
        ("Alitas con papas", 2, Decimal("50.00"))
    ]
    assert Decimal(report["sales"]["total_sales"]) == Decimal("50.00")
    assert report["sales"]["orders_count"] == 1
    assert {line["area"]: line["items_measured"] for line in report["preparation"]["lines"]} == {
        "KITCHEN": 1, "GRILL": 1,
    }
    closed = admin.client.post(f"/api/v1/shifts/{open_shift['id']}/close").json()
    assert closed["snapshot"]["items_sold"] == 2 and Decimal(closed["snapshot"]["total_sales"]) == Decimal("50.00")


# --- tiempo real ----------------------------------------------------------------------------------------


def test_websocket_waiter_receives_one_dish_ready_across_reconnect(mesero, cocina, parrilla, alitas, open_shift):
    order, item = order_with_dish(mesero, alitas)

    def drain_until(ws, sentinel_command_id):
        seen = []
        while True:
            message = ws.receive_json()
            seen.append(message["event"])
            if message["event"] == "command.created" and message["data"]["command_id"] == sentinel_command_id:
                return seen

    with client_session(mesero) as ws:
        assert ws.receive_json()["event"] == "connection.ready"
        for area, api in (("KITCHEN", cocina), ("GRILL", parrilla)):
            set_task(api, order["id"], item, area, "PREPARING")
        set_task(cocina, order["id"], item, "KITCHEN", "READY")
        # Reconexión: se pierde la conexión antes de que termine la parrilla.
    with client_session(mesero) as ws:
        assert ws.receive_json()["event"] == "connection.ready"
        set_task(parrilla, order["id"], item, "GRILL", "READY")
        sentinel = create_command(mesero, order["id"], [{"menu_item_id": alitas["id"]}])["id"]
        seen = drain_until(ws, sentinel)
    assert seen.count("order_item.ready") == 1
    assert "preparation_task.updated" not in seen  # la tarea no es de interés del mesero
    assert get_item(mesero, order["id"], item["id"])["status"] == "READY"  # el estado se recupera por REST


def test_websocket_does_not_leak_events_to_other_waiter_or_uninvolved_area(
    admin, mesero, cocina, parrilla, menu_lookup, open_shift,
):
    from unittest.mock import Mock

    from app.ws.hub import Connection, ConnectionHub

    hub_ = ConnectionHub()
    loop = Mock()
    loop.is_closed.return_value = False
    loop.call_soon_threadsafe.side_effect = lambda callback, *args: callback(*args)
    boxes = {}
    for uid, role in (("w1", "WAITER"), ("w2", "WAITER"), ("k", "KITCHEN"), ("g", "GRILL"), ("a", "ADMIN")):
        boxes[uid] = Mock()
        hub_.register(Connection(user_id=uid, role=role, device_id=None,
                                 channels=hub_.channels_for_role(role), send=boxes[uid], loop=loop))
    hub_.broadcast("order_item.ready", {"created_by_waiter_id": "w1"}, {"waiters", "admin"})
    assert boxes["w1"].call_count == 1 and boxes["a"].call_count == 1
    assert boxes["w2"].call_count == 0 and boxes["k"].call_count == 0 and boxes["g"].call_count == 0
    hub_.broadcast("preparation_task.updated", {"created_by_waiter_id": "w1"}, {"admin", "kitchen"})
    assert boxes["k"].call_count == 1 and boxes["g"].call_count == 0 and boxes["w1"].call_count == 1


def test_push_payload_for_dish_ready_is_private():
    from app.services.push import notification_for

    message, roles = notification_for("order_item.ready", {
        "name": "Alitas con papas", "table_name": "Mesa 5", "total": "25.00", "created_by_waiter_id": "x",
    })
    assert set(message) == {"title", "body", "route"}
    assert "Alitas" not in str(message) and "Mesa" not in str(message) and "25" not in str(message)
    assert roles == {"ADMIN", "WAITER"}
    assert notification_for("preparation_task.updated", {}) is None


# --- integridad bajo concurrencia -----------------------------------------------------------------------


def test_same_payment_key_sent_concurrently_records_one_payment(admin, mesero, alitas, open_shift):
    order, _ = order_with_dish(mesero, alitas)
    token = _token("admin")
    key = str(uuid.uuid4())
    path = f"/api/v1/orders/{order['id']}/payments"
    body = {"method": "YAPE", "amount": "25.00", "client_operation_id": key}
    assert _post_requests_concurrently([(path, body, token)] * 3) == [201, 201, 201]
    with SessionLocal() as db:
        assert db.query(Payment).filter(Payment.order_id == order["id"]).count() == 1
        assert db.get(Order, order["id"]).paid_amount == Decimal("25.00")


def test_payment_racing_a_shared_dish_cancellation_keeps_money_consistent(
    admin, mesero, alitas, open_shift, menu_lookup,
):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [
        {"menu_item_id": alitas["id"]}, {"menu_item_id": menu_lookup["Inca Kola 500ml"]["id"]},
    ])
    dish = next(i for i in command["items"] if i["menu_item_name_snapshot"] == "Alitas con papas")
    requests = [
        (f"/api/v1/orders/{order['id']}/payments", {"method": "CASH", "amount": "25.00"}, _token("admin")),
        (f"/api/v1/orders/{order['id']}/items/{dish['id']}/cancel", {"reason": "carrera"}, _token("mesero1")),
    ]
    payment_status, cancel_status = _post_requests_concurrently(requests)
    assert (payment_status, cancel_status) in {(201, 409), (422, 200)}
    with SessionLocal() as db:
        persisted = db.get(Order, order["id"])
        paid = sum((p.amount for p in db.query(Payment).filter(Payment.order_id == order["id"])), Decimal("0"))
        assert persisted.paid_amount == paid <= persisted.total
        item = db.get(OrderItem, dish["id"])
        statuses = {t.status for t in item.tasks}
        assert (item.status, frozenset(statuses)) in {
            ("CANCELLED", frozenset({"CANCELLED"})), ("PENDING", frozenset({"PENDING"})),
        }


def test_task_completion_racing_cancellation_never_leaves_a_half_cancelled_dish(
    mesero, cocina, parrilla, alitas, open_shift, events,
):
    for round_number in range(1, 4):
        order, item = order_with_dish(mesero, alitas, table_number=round_number)
        set_task(cocina, order["id"], item, "KITCHEN", "PREPARING")
        set_task(parrilla, order["id"], item, "GRILL", "PREPARING")
        set_task(cocina, order["id"], item, "KITCHEN", "READY")
        requests = [
            (f"/api/v1/orders/{order['id']}/items/{item['id']}/tasks/{task_of(item, 'GRILL')['id']}/status",
             {"status": "READY"}, _token("parrilla1")),
            (f"/api/v1/orders/{order['id']}/items/{item['id']}/cancel", {"reason": "carrera"}, _token("mesero1")),
        ]
        task_status, cancel_status = _post_requests_concurrently(requests)
        with SessionLocal() as db:
            persisted = db.get(OrderItem, item["id"])
            statuses = {t.status for t in persisted.tasks}
            if persisted.status == "CANCELLED":
                assert statuses == {"CANCELLED"} and cancel_status == 200
            else:  # la parrilla ganó: el plato quedó listo y ya no es cancelable
                assert persisted.status == "READY" and statuses == {"READY"}
                assert task_status == 200 and cancel_status == 409
        ready_for_item = [e for e in ready_events(events) if e[1]["item_id"] == item["id"]]
        assert len(ready_for_item) == (1 if persisted.status == "READY" else 0)


# --- un solo aviso visible por finalización -------------------------------------------------------------


def visible_ready_notifications(events) -> list[str]:
    """Eventos que producen un aviso (toast/Push) al mesero: ``silent`` solo actualiza pantallas."""
    return [e[0] for e in events if e[0] in {"order.ready", "order_item.ready"} and not e[1].get("silent")]


def push_schedules(events) -> list[str]:
    """Reproduce los eventos en un hub real y devuelve los que programarían un Web Push."""
    from unittest.mock import Mock

    from app.ws.hub import ConnectionHub

    scheduled: list[str] = []
    hub_ = ConnectionHub()
    loop = Mock()
    loop.is_closed.return_value = False
    loop.call_soon_threadsafe.side_effect = lambda fn, *args: scheduled.append(args[1]) if len(args) == 3 else None
    hub_.set_loop(loop)
    for event, payload, channels in events:
        hub_.broadcast(event, payload, channels)
    return scheduled


def finish_dish(order, item, cocina, parrilla):
    for area, api in (("KITCHEN", cocina), ("GRILL", parrilla)):
        set_task(api, order["id"], item, area, "PREPARING")
        set_task(api, order["id"], item, area, "READY")


def test_single_dish_order_gives_one_visible_notification_and_one_push(
    mesero, cocina, parrilla, alitas, open_shift, events,
):
    order, item = order_with_dish(mesero, alitas)
    events.clear()
    finish_dish(order, item, cocina, parrilla)
    # Los eventos de actualización se conservan...
    assert [e[0] for e in events].count("order_item.ready") == 1
    assert [e[0] for e in events].count("order.ready") == 1
    assert next(e for e in events if e[0] == "order_item.ready")[1]["silent"] is True
    # ...pero la misma finalización produce un único aviso visible y un único Push.
    assert visible_ready_notifications(events) == ["order.ready"]
    assert push_schedules(events) == ["order.ready"]
    assert get_item(mesero, order["id"], item["id"])["status"] == "READY"


def test_multi_dish_order_notifies_once_per_completion(
    mesero, cocina, parrilla, alitas, menu_lookup, open_shift, events,
):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [
        {"menu_item_id": alitas["id"]}, {"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]},
    ])
    wings = next(i for i in command["items"] if i["menu_item_name_snapshot"] == "Alitas con papas")
    chicken = next(i for i in command["items"] if i["menu_item_name_snapshot"] == "Pollo a la brasa")
    events.clear()
    finish_dish(order, wings, cocina, parrilla)
    assert visible_ready_notifications(events) == ["order_item.ready"]  # un plato listo, el pedido aún no
    assert push_schedules(events) == ["order_item.ready"]
    events.clear()
    set_task(cocina, order["id"], chicken, "KITCHEN", "PREPARING")
    set_task(cocina, order["id"], chicken, "KITCHEN", "READY")
    assert visible_ready_notifications(events) == ["order.ready"]  # el último plato completa el pedido
    assert push_schedules(events) == ["order.ready"]
    assert [e[0] for e in events].count("order_item.ready") == 1  # el evento de datos no se pierde


def test_prepaid_dish_still_notifies_once_because_order_never_becomes_ready(
    admin, mesero, cocina, parrilla, alitas, open_shift, events,
):
    order, item = order_with_dish(mesero, alitas)
    assert admin.client.post(f"/api/v1/orders/{order['id']}/payments",
                             json={"method": "CASH", "amount": "25.00"}).status_code == 201
    events.clear()
    finish_dish(order, item, cocina, parrilla)
    assert visible_ready_notifications(events) == ["order_item.ready"]
    assert push_schedules(events) == ["order_item.ready"]


def test_cancellation_that_completes_the_order_notifies_once(mesero, cocina, menu_lookup, open_shift, events):
    order = create_order(mesero)
    command = create_command(mesero, order["id"], [
        {"menu_item_id": menu_lookup["Pollo a la brasa"]["id"]}, {"menu_item_id": menu_lookup["Causa limeña"]["id"]},
    ])
    chicken = next(i for i in command["items"] if i["menu_item_name_snapshot"] == "Pollo a la brasa")
    causa = next(i for i in command["items"] if i["menu_item_name_snapshot"] == "Causa limeña")
    set_task(cocina, order["id"], chicken, "KITCHEN", "PREPARING")
    set_task(cocina, order["id"], chicken, "KITCHEN", "READY")
    events.clear()
    assert mesero.client.post(f"/api/v1/orders/{order['id']}/items/{causa['id']}/cancel",
                              json={"reason": "x"}).status_code == 200
    assert visible_ready_notifications(events) == ["order.ready"]


def test_hub_never_schedules_push_for_silent_events():
    events = [
        ("order_item.ready", {"silent": True, "created_by_waiter_id": "w"}, {"waiters"}),
        ("order_item.ready", {"silent": False, "created_by_waiter_id": "w"}, {"waiters"}),
        ("order_item.ready", {"created_by_waiter_id": "w"}, {"waiters"}),
    ]
    assert push_schedules(events) == ["order_item.ready", "order_item.ready"]
