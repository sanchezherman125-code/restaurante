# API REST + WebSocket

Base URL en desarrollo: `http://localhost:8000` (el frontend usa el proxy de Vite, por lo que
las URLs relativas parten de `/api/v1/...`). Documentación interactiva: `/api/docs` (Swagger).

## 1. Convenciones

- **Auth:** `Authorization: Bearer <access_token>` en todas las rutas salvo `/health`,
  `/api/v1/auth/login` y `/api/v1/auth/refresh`.
- **Dispositivo:** `X-Device-Id: <uuid>` (opcional, usado para auditoría).
- **Idempotencia:** header `Idempotency-Key: <uuid>` y/o campo `client_operation_id` en el body
  (ver §4).
- **Errores:**

```json
{ "error": { "code": "TABLE_ALREADY_OPEN", "message": "La mesa ya está abierta.", "details": {} } }
```

- **Moneda:** cadenas decimales con dos cifras (`"12.00"`).
- **Fechas:** ISO 8601 en UTC.

## 2. Endpoints

Roles: `Staff` = cualquier usuario autenticado; `Admin`; `Waiter`; `Kitchen`; `Grill`; `Area` = cocina o parrilla.

### Auth

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| POST | `/api/v1/auth/login` | público | usuario + PIN → access/refresh; rate limit 5 intentos / 5 min |
| POST | `/api/v1/auth/refresh` | público | renueva el par de tokens |
| POST | `/api/v1/auth/logout` | Staff | borra cookies/refresh |
| GET | `/api/v1/auth/me` | Staff | usuario de la sesión |

### Usuarios (§48)

| Método | Ruta | Rol |
|---|---|---|
| GET | `/api/v1/users` | Admin |
| POST | `/api/v1/users` | Admin |
| PATCH | `/api/v1/users/{user_id}` | Admin |
| POST | `/api/v1/users/{user_id}/disable` | Admin |

### Mesas (§49)

| Método | Ruta | Rol | Descripción |
|---|---|---|---|
| GET | `/api/v1/tables` | Staff | lista con estado (`libre`/`ocupada`) |
| POST | `/api/v1/tables` | Admin | crea mesa |
| PATCH | `/api/v1/tables/{table_id}` | Admin | edita/activa/desactiva |

### Carta (§50)

| Método | Ruta | Rol |
|---|---|---|
| GET | `/api/v1/menu` | Staff |
| GET/POST | `/api/v1/menu/categories` | Staff / Admin |
| PATCH | `/api/v1/menu/categories/{category_id}` | Admin |
| POST | `/api/v1/menu/items` | Admin |
| PATCH | `/api/v1/menu/items/{item_id}` | Admin |
| PATCH | `/api/v1/menu/items/{item_id}/availability` | Kitchen/Grill/Admin |

### Pedidos (§51)

| Método | Ruta | Rol | Idempotencia |
|---|---|---|---|
| GET | `/api/v1/orders/active` | Staff (`?area=KITCHEN\|GRILL\|WAITER`) | — |
| POST | `/api/v1/orders` | Waiter/Admin | `client_operation_id` o header `Idempotency-Key` |
| GET | `/api/v1/orders/{order_id}` | Staff | — |
| POST | `/api/v1/orders/{order_id}/commands` | Waiter/Admin | `client_operation_id` o header |
| POST | `/api/v1/orders/{order_id}/items` | Waiter/Admin | — |
| PATCH | `/api/v1/orders/{order_id}/items/{item_id}` | Waiter/Admin | — |
| POST | `/api/v1/orders/{order_id}/items/{item_id}/cancel` | Waiter/Admin | — |
| POST | `/api/v1/orders/{order_id}/items/{item_id}/status` | según área | — |
| GET | `/api/v1/orders/{order_id}/billing` | Staff | — |
| GET/POST | `/api/v1/orders/{order_id}/payments` | Staff / según permiso | `client_operation_id` (body) |
| POST | `/api/v1/orders/{order_id}/splits` | Staff | sin idempotencia |

Transiciones de ítem permitidas (§9): `PENDING→PREPARING|READY|DELIVERED|CANCELLED`,
`PREPARING→READY|CANCELLED`, `READY→DELIVERED`. El endpoint de cambio de estado rechaza
`CANCELLED` (usar `/cancel`, que registra motivo y si ya se había iniciado la preparación).

### Vistas de preparación (§52)

| Método | Ruta | Rol |
|---|---|---|
| GET | `/api/v1/preparation/kitchen` | Kitchen/Admin |
| GET | `/api/v1/preparation/grill` | Grill/Admin |

Agrupan ítems por mesa/pedido, con `summary` y tiempos de preparación.

### Gastos y lista de compras (§54, §55)

| Método | Rota | Rol |
|---|---|---|
| GET/POST | `/api/v1/expenses` | Staff (requiere turno abierto para crear) |
| GET | `/api/v1/expenses/current-shift` | Staff |
| GET | `/api/v1/expenses/{expense_id}` | Staff |
| GET | `/api/v1/purchase-list/current` | Staff |
| POST | `/api/v1/purchase-list` | Kitchen/Grill/Admin |
| DELETE | `/api/v1/purchase-list/{item_id}` | Kitchen/Grill/Admin |

### Turnos (§56)

| Método | Ruta | Rol |
|---|---|---|
| GET | `/api/v1/shifts/current` | Staff |
| POST | `/api/v1/shifts/open` | Admin |
| POST | `/api/v1/shifts/{shift_id}/close` | Admin (bloqueado si hay pedidos abiertos) |
| GET | `/api/v1/shifts/history` | Admin |
| GET | `/api/v1/shifts/{shift_id}/report` | Admin |

### Reportes (§57)

| Método | Ruta | Rol |
|---|---|---|
| GET | `/api/v1/reports/current-shift` | Admin |
| GET | `/api/v1/reports/sales` | Admin (`?date_from&date_to`) |
| GET | `/api/v1/reports/products` | Admin |
| GET | `/api/v1/reports/preparation` | Admin |
| GET | `/api/v1/reports/shifts/{shift_id}` | Admin |

### Comprobantes y push (§33)

| Método | Ruta | Rol |
|---|---|---|
| POST | `/api/v1/receipts` | Staff (multipart, JPEG/PNG/WebP/PDF ≤ 5 MB) |
| POST | `/api/v1/push/subscriptions` | Staff |

### Salud

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | liveness |

## 3. WebSocket

```text
GET /api/v1/ws?token=<access_token>&device_id=<uuid>
```

También acepta `Authorization: Bearer` en headers. El token es el mismo access token del login.

Mensaje de bienvenida:

```json
{ "event": "connection.ready", "data": { "user_id": "…", "role": "WAITER", "channels": ["waiters"] } }
```

Canales (asignados por el servidor según el rol): `waiters`, `kitchen`, `grill`, `admin`.

| Evento | Canales | Datos |
|---|---|---|
| `connection.ready` | propio | `user_id`, `role`, `channels` |
| `pong` | propio | — |
| `tables.changed` | waiters, admin | — |
| `menu.changed` | todos | — |
| `availability.changed` | todos | `name`, `status` |
| `order.created` | waiters, admin | pedido |
| `order.updated` | waiters, admin | pedido |
| `command.created` | kitchen, grill, waiters, admin | `order_id`, `sequence_number`, resumen |
| `order_item.updated` | admin + área del ítem | ítem |
| `order_item.ready` | waiters, kitchen, grill, admin | ítem |
| `order.ready` | waiters, admin | `order_id`, `table_name`, `table_number`, `message` |
| `order.paid` | waiters, admin | `order_id`, `paid_amount` |
| `purchase_list.changed` | kitchen, grill, admin | — |
| `shift.opened` / `shift.closed` | admin | turno |

El cliente responde a los eventos invalidando las queries de React Query correspondientes,
mostrando un toast y, para `order.ready` / `command.created` / `availability.changed`,
reproduciendo un sonido de aviso (si está activado).

## 4. Idempotencia (§22)

`POST /orders`, `POST /orders/{id}/commands` y `POST /orders/{id}/payments` guardan la
respuesta en la tabla `idempotency_keys` indexada por `(key, user_id, operation_type)`:

1. Primera llamada → ejecuta y guarda `response_status` + `response_body`.
2. Reenvío con la misma clave → devuelve la **misma** respuesta (201) sin crear nada nuevo.
3. Clave repetida con distinta operación → la clave es del cliente y se conserva.

```bash
curl -X POST http://localhost:8000/api/v1/orders/$ID/commands \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: 9f0d9a1e-…" \
  -d '{"items":[{"menu_item_id":"…","quantity":1}]}'
```

La cola offline envía siempre `client_operation_id` = `client_operation_id` de la operación
local, de modo que un reenvío nunca duplica el recurso.
