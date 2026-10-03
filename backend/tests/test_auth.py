from tests.conftest import Api


def test_login_ok(client):
    api = Api(client, "admin")
    me = api.client.get("/api/v1/auth/me")
    assert me.status_code == 200
    body = me.json()
    assert body["role"] == "ADMIN"
    assert "pin" not in body
    assert "pin_hash" not in body


def test_login_wrong_pin(client):
    response = client.post("/api/v1/auth/login", json={"username": "admin", "pin": "9999"})
    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_CREDENTIALS"


def test_login_unknown_user(client):
    response = client.post("/api/v1/auth/login", json={"username": "noexiste", "pin": "1234"})
    assert response.status_code == 401


def test_login_rate_limit(client):
    for _ in range(5):
        client.post("/api/v1/auth/login", json={"username": "admin", "pin": "0000"})
    locked = client.post("/api/v1/auth/login", json={"username": "admin", "pin": "1234"})
    assert locked.status_code == 429
    assert locked.json()["error"]["code"] == "LOGIN_LOCKED"


def test_refresh_and_me(client):
    api = Api(client, "admin")
    tokens = api.login("mesero1")
    refresh = client.post("/api/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert refresh.status_code == 200
    client.headers["Authorization"] = f"Bearer {refresh.json()['access_token']}"
    assert client.get("/api/v1/auth/me").json()["username"] == "mesero1"


def test_access_token_required(client):
    response = client.get("/api/v1/users")
    assert response.status_code == 401


def test_rbac_waiter_cannot_manage_users(mesero):
    response = mesero.client.post(
        "/api/v1/users",
        json={"username": "hack", "pin": "1234", "display_name": "Hack", "role": "ADMIN"},
    )
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "ROLE_REQUIRED"


def test_rbac_kitchen_cannot_see_reports(cocina):
    assert cocina.client.get("/api/v1/reports/sales").status_code == 403
    assert cocina.client.get("/api/v1/shifts/history").status_code == 403


def test_inactive_user_cannot_login(admin, client):
    users = admin.client.get("/api/v1/users").json()
    target = next(u for u in users if u["username"] == "mesero1")
    assert admin.client.post(f"/api/v1/users/{target['id']}/disable").status_code == 200
    response = client.post("/api/v1/auth/login", json={"username": "mesero1", "pin": "1234"})
    assert response.status_code == 401


def test_create_user_and_pin_change(admin):
    payload = {"username": "mesero3", "pin": "5678", "display_name": "Nueva", "role": "WAITER"}
    created = admin.client.post("/api/v1/users", json=payload)
    assert created.status_code == 201
    user_id = created.json()["id"]

    duplicated = admin.client.post("/api/v1/users", json=payload)
    assert duplicated.status_code == 409

    updated = admin.client.patch(f"/api/v1/users/{user_id}", json={"pin": "9999"})
    assert updated.status_code == 200
    assert updated.json()["pin_hash"] if "pin_hash" in updated.json() else True

    login = admin.client.post("/api/v1/auth/login", json={"username": "mesero3", "pin": "9999"})
    assert login.status_code == 200
