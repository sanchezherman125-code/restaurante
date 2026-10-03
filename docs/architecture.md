# Arquitectura

## 1. Vista general

```text
┌────────────────────────────┐        HTTP/REST + WebSocket         ┌────────────────────────────┐
│  Frontend PWA (React)      │ ───────────────────────────────────► │  Backend FastAPI           │
│  mesero / cocina /         │  /api/v1/...   ·   /api/v1/ws       │  auth · pedidos · cobros   │
│  parrilla / admin          │ ◄─────────────────────────────────── │  turnos · reportes · WS    │
└─────────────┬──────────────┘                                      └──────────────┬──────────────┘
              │ IndexedDB (cola offline)                                           │ SQLAlchemy
              ▼                                                                    ▼
     restaurante-offline                                                   PostgreSQL 16
```

- El frontend se sirve como PWA (manifest + service worker con precache y `navigateFallback`).
- En desarrollo, Vite hace de proxy de `/api`, `/uploads`, `/health` y `ws` hacia `localhost:8000`.

## 2. Roles y pantallas

| Rol | Constante | Pantallas | Canal WebSocket |
|---|---|---|---|
| Mesero | `WAITER` | mesas, orden de mesa, pedidos activos, cobro, gastos | `waiters` |
| Cocina | `KITCHEN` | tablero de comandas, lista de compras | `kitchen` |
| Parrilla | `GRILL` | tablero de comandas, lista de compras | `grill` |
| Dueño | `ADMIN` | panel, pedidos, mesas, carta, usuarios, turnos, reportes, historial, gastos | `admin` |

El canal **no lo elige el cliente**: el backend lo deriva del token y lo devuelve en el
mensaje de bienvenida (`connection.ready`).

## 3. Autenticación

- Login por usuario + PIN → `POST /api/v1/auth/login`.
- PIN hasheado con **Argon2id**; acceso JWT (30 min) + refresh JWT (14 días).
- Rate limit de login: 5 intentos / 5 minutos por usuario (`LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCKOUT_MINUTES`).
- El cliente renueva el access token automáticamente en 401 y, si el refresh falla, limpia la sesión.
- Todas las peticiones llevan `X-Device-Id` (UUID persistido en `localStorage`) para auditoría.

## 4. Dominio: pedido, comanda e ítem

- **Pedido (`orders`)**: atención de una mesa (o para llevar). Estado:
  `OPEN → IN_PREPARATION → READY → DELIVERED → PAID → CLOSED`.
- **Comanda (`commands`)**: lote de productos enviado a preparación; cada pedido lleva
  numeración secuencial (`sequence_number`) y opcionalmente un `client_operation_id` idempotente.
- **Ítem (`order_items`)**: un producto concreto con su estado:
  `PENDING → PREPARING → READY → DELIVERED` (+ `CANCELLED`).
- Cada ítem tiene `preparation_area`: `KITCHEN`, `GRILL` o `WAITER`.
  Los ítems de mesero **no** pasan por preparación: de `PENDING` solo pueden ir a `DELIVERED` o `CANCELLED`.

Regla de "listo": el pedido pasa a `READY` cuando **todos** sus ítems no cancelados de área
`KITCHEN`/`GRILL` están en `READY` o `DELIVERED`. En ese momento el backend emite `order.ready`
a los canales `waiters` y `admin`.

## 5. Flujo de un pedido

```text
MESERO                BACKEND                  COCINA/PARRILLA           MESERO (otro disp.)
  │  POST /orders        │                           │                          │
  │─────────────────────►│  order.created ───────────┼─────────────────────────►│
  │  POST /orders/{id}/commands                       │                          │
  │─────────────────────►│  command.created ────────►│                          │
  │                      │                           │ PATCH .../status         │
  │                      │◄──────────────────────────│  PREPARING               │
  │                      │  order_item.updated ──────┼─────────────────────────►│
  │                      │◄──────────────────────────│  READY                   │
  │                      │  order_item.ready ────────┼─────────────────────────►│
  │  order.ready ◄───────┼───────────────────────────┴───────────────────────── │  toast "Listo para entregar"
  │  PATCH .../status DELIVERED                        │                        │
  │─────────────────────►│  order.updated ────────────┼────────────────────────►│
  │  POST .../payments (ADMIN o WAITER según permiso) │                        │
  │─────────────────────►│  order.paid ───────────────┼───────────────────────► │
```

Los tiempos de preparación (`expected_prep_minutes`) se informan en el tablero de cocina/parrilla
y se usan para el aviso de proximidad; el cronómetro se calcula en el cliente desde
`preparation_started_at`.

## 6. Tiempo real (WebSocket)

- Endpoint: `GET /api/v1/ws?token=<access>&device_id=<uuid>` (también acepta el token por
  header `Authorization: Bearer`).
- El hub (`app/ws/hub.py`) hace *broadcast* a canales: `waiters`, `kitchen`, `grill`, `admin`.
- El cliente (`frontend/src/websocket/useSocket.ts`) reconecta con backoff (1 s → 30 s),
  mantiene un ping cada 25 s y, al reconectar, invalida todas las queries de React Query
  (recuperación §17 del speac).
- Cada evento dispara invalidaciones de caché + toast + sonido (según evento y rol).

## 7. Modo offline (resumen)

El detalle completo está en [`offline-sync.md`](./offline-sync.md). En síntesis:

1. Si `fetch` falla por red, la operación se guarda en **IndexedDB** como `LOCAL_PENDING`.
2. Un sincronizador reintenta con backoff exponencial (1 s → 60 s) y también al recuperar conexión.
3. Las dependencias (pedido → comanda) se resuelven con el id real devuelto por el servidor.
4. Cada reenvío lleva `Idempotency-Key` / `client_operation_id` para que el servidor no duplique.

## 8. Seguridad

- RBAC en cada endpoint (`CurrentUser` con rol requerido).
- Argon2id + JWT + rate limit + CORS restringido (`CORS_ORIGINS`).
- Validación Pydantic en todos los payloads; errores con estructura
  `{error: {code, message, details}}` (§75).
- Auditoría de acciones relevantes en `audit_logs` (login, cambios de estado, pagos, altas/bajas).
- Dinero siempre como `Decimal` con dos decimales (§69); fechas en UTC con zona
  `America/Lima` para reportes (§70).

## 9. Estructura del código

**Backend** (`app/`)

- `api/` → routers HTTP/WS (solo validación, autorización y respuesta).
- `services/` → lógica de negocio (transiciones, totales, reportes, hub de eventos).
- `models/` → SQLAlchemy; `schemas/` → Pydantic.
- `core/` → seguridad (JWT, Argon2id, rate limiter, auditoría).
- `ws/hub.py` → registro de conexiones por canal y broadcast.

**Frontend** (`src/`)

- `api/client.ts` → cliente HTTP con refresh automático e idempotencia.
- `offline/queue-db.ts` + `offline/queue.ts` → cola IndexedDB y su sincronizador.
- `stores/` → zustand: sesión, UI (toasts/conexión), cola, pedidos pendientes.
- `websocket/useSocket.ts` → cliente realtime.
- `pages/` → una carpeta por rol; componentes compartidos en `components/`.
