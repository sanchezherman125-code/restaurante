# API REST + WebSocket

Base URL en desarrollo: `http://localhost:8000` (el frontend usa el proxy de Vite, por lo que
las URLs relativas parten de `/api/v1/...`). Documentación interactiva: `/api/docs` (Swagger).

## 1. Convenciones

- **Auth:** `Authorization: Bearer <access_token>` en todas las rutas salvo `/health`,
  `/ready`, `/api/v1/auth/login` y `/api/v1/auth/refresh`.
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
| POST | `/api/v1/auth/refresh` | público con refresh válido | renueva el par y rota el refresh de un solo uso |
| POST | `/api/v1/auth/logout` | Staff | revoca la sesión en servidor, incluidos access y refresh |
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
| PATCH | `/api/v1/tables/{table_id}` | Admin | edita/activa/desactiva (409 `TABLE_OCCUPIED` si tiene un pedido vivo) |

### Carta (§50)

| Método | Ruta | Rol |
|---|---|---|
| GET | `/api/v1/menu` | Staff (`?include_inactive=true` solo Admin) |
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
| POST | `/api/v1/orders/open-with-command` | Waiter/Admin | `client_operation_id` o header |
| POST | `/api/v1/orders/{order_id}/cancel` | Waiter dueño/Admin | `client_operation_id` o header |
| POST | `/api/v1/orders/{order_id}/commands` | Waiter/Admin | `client_operation_id` o header |
| POST | `/api/v1/orders/{order_id}/items` | Waiter/Admin | — |
| PATCH | `/api/v1/orders/{order_id}/items/{item_id}` | Waiter/Admin | — |
| POST | `/api/v1/orders/{order_id}/items/{item_id}/cancel` | Waiter/Admin | — |
| POST | `/api/v1/orders/{order_id}/items/{item_id}/status` | según área | `client_operation_id` o header |
| POST | `/api/v1/orders/{order_id}/items/{item_id}/tasks/{task_id}/status` | Área de la tarea / Admin | `client_operation_id` o header |
| GET | `/api/v1/orders/{order_id}/billing` | Waiter dueño / Admin | — |
| GET/POST | `/api/v1/orders/{order_id}/payments` | Waiter dueño / Admin | `client_operation_id` (body) |
| POST | `/api/v1/orders/{order_id}/splits` | — | **retirado: responde 410 `SPLITS_DISABLED`** |

**Primera comanda de una mesa.** `POST /orders/open-with-command` (`table_id`, `persons_count`, `items[]`, `notes?`)
crea el pedido y su primera comanda en **una sola transacción**: si falla cualquier paso (producto agotado o inexistente,
mesa ocupada, error del servidor) no queda ningún pedido ni comanda, ni se notifica nada. La clave de idempotencia se
confirma junto con ambas filas, así que reintentar con la misma clave devuelve el mismo resultado sin duplicar. Dos
dispositivos que envían a la vez la primera comanda de una mesa: uno recibe 201 y el otro 409 `TABLE_ALREADY_OPEN`
(índice único de ocupación), sin pedidos ni comandas duplicados. La respuesta es el pedido (`id` = id del pedido) con la
comanda en `command`. `POST /orders` y `POST /orders/{id}/commands` no cambian.

**Liberar una mesa sin pedido.** `POST /orders/{id}/cancel` anula un pedido sin productos activos ni pagos
(`CANCELLED`, auditoría `ORDER_CANCELLED`); con productos o pagos responde 409 `ORDER_NOT_EMPTY`.

**Cobro.** Ya no existen divisiones. `POST .../payments` rechaza `split_id` con 422
`SPLIT_PAYMENTS_DISABLED`; el monto nunca puede superar el saldo pendiente (422
`PAYMENT_EXCEEDS_PENDING`). `GET .../billing` devuelve ítems (sin `split_quantity`), totales,
`pending_amount`, `payments` y `legacy_splits` (solo lectura, divisiones creadas antes del retiro).

**Pedido cancelado.** Si se cancelan todos los productos (sin pagos) el pedido pasa a `CANCELLED`: libera la mesa,
no bloquea el cierre de turno y rechaza pagos y comandas con 409 `ORDER_ALREADY_CANCELLED`.

**Tareas de preparación.** Cada plato con preparación trae `tasks[]` (`id`, `name`, `area`,
`status` `PENDING|PREPARING|READY|CANCELLED`, `expected_minutes`, `started_at`, `ready_at`). El
endpoint de tarea acepta `PREPARING` o `READY` y solo avanza: repetir o retrasar un estado es una
operación nula (200 sin eventos), saltarse un paso es 409 `INVALID_STATUS_TRANSITION`. El estado
del plato se deriva: `PREPARING` al iniciar la primera tarea y `READY` cuando **todas** terminan.
`POST .../items/{id}/status` se conserva por compatibilidad (colas offline antiguas): `PREPARING`/`READY`
actúan sobre las tareas **del área del usuario** (Admin: todas) y `DELIVERED` es del plato.
Cancelar (`.../cancel`) cancela el plato y todas sus tareas.

**Mesas.** Abrir un pedido y desactivar una mesa bloquean la misma fila (`restaurant_tables … FOR UPDATE`):
una mesa con pedido que ocupa la mesa (`occupies_table`, incluido un pedido pagado con platos sin entregar)
no se desactiva (409 `TABLE_OCCUPIED`, `details.order_id`) y una mesa inactiva no recibe pedidos nuevos
(409 `TABLE_INACTIVE`). Un pedido vivo en una mesa ya inactiva (datos anteriores) sigue accesible y
`GET /tables` lo informa con `status: "OPEN"`.

**Carta publicada.** `GET /menu` devuelve los productos activos **de categorías activas**, que es exactamente
lo que acepta una comanda: un producto de una categoría desactivada responde 404 `MENU_ITEM_NOT_FOUND`.
Con `include_inactive=true` (Admin) incluye categorías y productos desactivados para poder reactivarlos.
Crear un producto o cambiar una categoría emiten `menu.changed`.

**Catálogo.** `POST/PATCH /menu/items` aceptan `preparation_steps: [{id?, name, area, expected_minutes, is_active}]`
(1–12 tareas, áreas `KITCHEN|GRILL`, 0–600 min; el orden de la lista es el orden de visualización).
`PATCH` con la lista reemplaza la receta conservando el `id` de las tareas editadas. Sin la lista, un
cambio de `preparation_area`/`expected_prep_minutes` solo se admite si el producto tiene una tarea
(si tiene varias: 422 `PREPARATION_STEPS_REQUIRED`). `preparation_area` y `expected_prep_minutes` del
producto son un resumen derivado (área de la primera tarea activa y tiempo de la más larga).

Transiciones de ítem permitidas (§9): `PENDING→PREPARING|READY|DELIVERED|CANCELLED`,
`PREPARING→READY|CANCELLED`, `READY→DELIVERED`. El endpoint de cambio de estado rechaza
`CANCELLED` (usar `/cancel`, que registra motivo y si ya se había iniciado la preparación).

### Vistas de preparación (§52)

| Método | Ruta | Rol |
|---|---|---|
| GET | `/api/v1/preparation/kitchen` | Kitchen/Admin |
| GET | `/api/v1/preparation/grill` | Grill/Admin |

Agrupan por comanda. `tasks[]` contiene **solo las tareas del área** (con `item_name`, `quantity`,
`other_tasks[]` = progreso de las demás áreas del mismo plato); `other_areas` resume el estado de la
otra área en la comanda. El filtro es por estado de tarea/plato, no del pedido: un pedido `PAID` con
preparación pendiente sigue visible (se excluye solo `CLOSED`). `items[]` es obsoleto y se conserva
para clientes en caché.

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
| GET | `/api/v1/reports/sales` | Admin (`?date_from&date_to&shift_id&waiter_id&scope`) |
| GET | `/api/v1/reports/products` | Admin |
| GET | `/api/v1/reports/preparation` | Admin |
| GET | `/api/v1/reports/shifts/{shift_id}` | Admin |

Selección de turnos (la misma para ventas, gastos, productos y preparación). Prioridad:

1. `shift_id` → ese turno.
2. `date_from` / `date_to` → turnos **abiertos** en ese rango de días locales (`BUSINESS_TIMEZONE`,
   por defecto `America/Lima`); `date_to` incluye su día completo. Un turno abierto a las 23:30 pertenece
   al día en que se abrió aunque termine después de medianoche.
3. `scope=all` → historial completo. `scope=current` o sin parámetros → turno abierto; si no hay
   ninguno, el último registrado (comportamiento anterior, se mantiene por compatibilidad).

Los gastos se suman por turno seleccionado, **haya o no pedidos** en él; `waiter_id` filtra solo las ventas.
`/shifts/history` usa los mismos límites de día local.

### Comprobantes y push (§33)

| Método | Ruta | Rol |
|---|---|---|
| POST | `/api/v1/receipts` | Staff (multipart, JPEG/PNG/WebP/PDF ≤ 5 MB) |
| GET | `/api/v1/receipts/{filename}` | Propietario o ADMIN; descarga privada autenticada |
| POST | `/api/v1/push/subscriptions` | Staff |

### Salud

| Método | Ruta | Descripción |
|---|---|---|
| GET | `/health` | liveness |

## 3. WebSocket

```text
GET /api/v1/ws

// Primer mensaje después de abrir el WebSocket (máximo 5 segundos):
{"type":"auth","token":"<access_token>","device_id":"<uuid>"}
```

El token es el mismo access token del login y nunca se envía en la URL. Se comprueba Origin,
usuario activo y sesión revocable; al expirar se renueva por HTTP y se reconecta.
Los cambios de PIN/rol o la desactivación revocan las sesiones del usuario.
Los eventos de negocio se publican sólo después del commit.

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
| `command.created` | admin, waiters + **solo las áreas con tareas** | `order_id`, `sequence_number`, `areas` |
| `order_item.updated` | admin, waiters (dueño) + áreas con tareas | ítem |
| `preparation_task.updated` | admin + áreas con tareas (no push) | ítem + `task_area`, `task_status` |
| `order_item.ready` | waiters (dueño), admin — **una vez por plato**; `silent: true` si `order.ready` avisa lo mismo | ítem |
| `order.ready` | waiters, admin | `order_id`, `table_name`, `table_number`, `message` |
| `order.paid` | waiters, admin | `order_id`, `paid_amount` |
| `purchase_list.changed` | kitchen, grill, admin | — |
| `shift.opened` / `shift.closed` | admin | turno |
| `expense.created` | admin | `expense_id`, `shift_id` |

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
