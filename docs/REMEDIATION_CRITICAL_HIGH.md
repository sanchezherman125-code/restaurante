# REMEDIACIÓN CRITICAL/HIGH V1

Fecha: 2026-10-02. Alcance: sólo hallazgos `CRITICAL` y `HIGH` de `CODEX_AUDIT_V1.md` y dependencias directas.

## CRITICAL

### C-01 — Respuesta perdida duplica comandas

- **Severidad:** CRITICAL
- **Causa raíz:** el primer intento online no tenía una identidad persistida; al fallar la respuesta se encolaba otro UUID.
- **Archivos modificados:** `frontend/src/lib/send.ts`, `frontend/src/offline/queue-db.ts`, `frontend/src/stores/queue.ts`, `frontend/src/api/endpoints.ts`, `frontend/src/pages/waiter/TablesPage.tsx`, `frontend/src/pages/waiter/TableOrderPage.tsx`.
- **Solución:** `sendOrQueue` persiste la operación antes del primer `fetch`; el mismo UUID se transmite como `client_operation_id` e `Idempotency-Key` online, offline y en retry. La comanda local ya no muestra “enviada”.
- **Regresión:** `frontend/src/lib/send.test.ts` simula commit de servidor + respuesta perdida y verifica que el retry conserva UUID; `backend/tests/test_concurrency.py::test_same_command_uuid_is_idempotent_under_real_concurrency` usa dos requests concurrentes reales.
- **Estado:** FIXED

### C-02 — Pagos concurrentes sobrepasan el saldo

- **Severidad:** CRITICAL
- **Causa raíz:** lectura/modificación de `paid_amount` sin bloqueo ni refresco de la fila.
- **Archivos modificados:** `backend/app/api/billing.py`.
- **Solución:** el flujo bloquea el turno y el pedido con `SELECT ... FOR UPDATE OF orders`, recarga el valor persistido, valida, crea pago, audita y confirma en una transacción. También valida que `split_id` pertenezca al pedido.
- **Regresión:** `backend/tests/test_concurrency.py::test_concurrent_payments_never_exceed_order_total` ejecuta dos POST simultáneos contra PostgreSQL; uno responde 201 y el otro 422.
- **Estado:** FIXED

### C-03 — Dos pedidos activos por mesa

- **Severidad:** CRITICAL
- **Causa raíz:** patrón consultar-y-luego-insertar sin garantía de base de datos.
- **Archivos modificados:** `backend/app/models/orders.py`, `backend/alembic/versions/0002_critical_high_integrity.py`, `backend/app/api/orders.py`.
- **Solución:** índice único parcial PostgreSQL `uq_orders_active_dine_in_table` para `DINE_IN` y estados `OPEN/IN_PREPARATION/READY/DELIVERED`; error de restricción se traduce a 409 controlado.
- **Regresión:** `backend/tests/test_concurrency.py::test_concurrent_dine_in_opening_creates_exactly_one_active_order` usa dos solicitudes simultáneas y comprueba exactamente una fila activa.
- **Estado:** FIXED

## HIGH

### H-01 — Cola detenida en `SENDING`

- **Severidad:** HIGH
- **Causa raíz:** la cola sólo procesaba `LOCAL_PENDING`; una recarga dejaba `SENDING` sin ruta de recuperación.
- **Archivos modificados:** `frontend/src/offline/queue-db.ts`, `frontend/src/stores/queue.ts`, `frontend/src/offline/queue.test.ts`.
- **Solución:** el arranque recupera `SENDING` a `LOCAL_PENDING` sin cambiar UUID y fuerza flush seguro.
- **Regresión:** `recupera un SENDING interrumpido...` verifica `SENDING → LOCAL_PENDING → SYNCED` con la misma clave.
- **Estado:** FIXED

### H-02 — Cancelación sin autorización por área/propiedad

- **Severidad:** HIGH
- **Causa raíz:** cualquier usuario autenticado podía cancelar cualquier item.
- **Archivos modificados:** `backend/app/api/orders.py`, `backend/tests/test_orders.py`.
- **Solución:** ADMIN puede cancelar; WAITER sólo su pedido; KITCHEN/GRILL sólo items de su área. Lectura de pedidos se limita a ADMIN o mesero creador.
- **Regresión:** cocina no puede cancelar producto GRILL ni leer detalles de pedido.
- **Estado:** FIXED

### H-03 — IDOR de pedidos, cobros y gastos

- **Severidad:** HIGH
- **Causa raíz:** dependencias `StaffUser` sin autorización por recurso.
- **Archivos modificados:** `backend/app/api/orders.py`, `backend/app/api/billing.py`, `backend/app/api/expenses.py`, pruebas de órdenes y billing.
- **Solución:** preparación no accede a `/orders/active`; detalle/cobro/pagos requieren ADMIN o mesero creador; gasto individual y lista actual se restringen al creador, salvo ADMIN.
- **Regresión:** llamadas directas KITCHEN a detalle, billing y payments devuelven 403.
- **Estado:** FIXED

### H-04 — Cierre de turno compite con mutaciones

- **Severidad:** HIGH
- **Causa raíz:** el cierre y las mutaciones no serializaban sobre el turno.
- **Archivos modificados:** `backend/app/core/deps.py`, `backend/app/api/orders.py`, `backend/app/api/billing.py`, `backend/app/api/expenses.py`, `backend/app/api/shifts.py`, `backend/tests/test_concurrency.py`.
- **Solución:** las mutaciones bloquean y revalidan el turno; cierre bloquea turno y pedidos antes de snapshot.
- **Regresión:** `test_shift_close_serializes_with_order_creation` ejecuta ambas operaciones en paralelo y verifica que un turno cerrado no recibe pedido posterior.
- **Estado:** FIXED

### H-05 — JWT en URL, origen WS y escalado de hub

- **Severidad:** HIGH
- **Causa raíz:** token por query string, sin validación `Origin`, hub únicamente en memoria.
- **Archivos modificados:** `backend/app/api/ws.py`, `frontend/src/websocket/useSocket.ts`, `backend/tests/test_e2e.py`, `frontend/vite.config.ts`, `frontend/playwright.config.ts`, `docs/deployment.md`.
- **Solución:** JWT pasa por el primer mensaje WebSocket de autenticación (con timeout), nunca por URL; se valida `Origin` contra `CORS_ORIGINS`, y la guía de despliegue limita explícitamente V1 a una instancia/un worker; el cliente resincroniza REST al reconectar.
- **Regresión:** prueba WebSocket backend autentica con el mensaje inicial y conserva conexión autenticada.
- **Estado:** FIXED para el despliegue V1 de un proceso; un despliegue multiinstancia requiere broker compartido y no está autorizado por esta V1.

### H-06 — Comprobantes arbitrarios/publicación insegura

- **Severidad:** HIGH
- **Causa raíz:** se confiaba sólo en MIME y extensión declarados por el cliente.
- **Archivos modificados:** `backend/app/api/receipts.py`, `backend/app/config.py`, `backend/app/main.py`, `backend/tests/test_receipts_security.py`.
- **Solución:** MIME/extensión deben coincidir y los bytes deben tener firma válida JPEG/PNG/WebP/PDF; fuera de desarrollo el arranque exige Supabase Storage configurado.
- **Regresión:** archivo falso con MIME PNG devuelve 422; firma PNG válida se acepta.
- **Estado:** FIXED

### H-07 — JWT por defecto y rate limit por proceso

- **Severidad:** HIGH
- **Causa raíz:** secreto por defecto válido para arranque y limiter sólo en memoria.
- **Archivos modificados:** `backend/app/config.py`, `backend/app/core/login_rate.py`, `backend/app/api/auth.py`, `backend/app/models/operations.py`, `backend/alembic/versions/0002_critical_high_integrity.py`, `backend/tests/conftest.py`.
- **Solución:** producción/piloto rechaza secreto débil y storage ausente; rate limit se persiste en PostgreSQL y usa advisory lock por usuario/IP para serializar el primer fallo incluso entre procesos.
- **Regresión:** suite de auth existente valida bloqueo; la tabla y restricción se validan en migración limpia.
- **Estado:** FIXED

## Validación ejecutada

- Backend Ruff: OK.
- Backend pytest PostgreSQL: **68 passed**, incluidas 4 regresiones de concurrencia real y RBAC/recibos.
- Frontend lint/typecheck: OK.
- Frontend Vitest: **17 passed**.
- Frontend build PWA: OK.
- Alembic en base aislada: `upgrade head` a `0002_critical_high_integrity` y `downgrade base` OK.
- E2E Playwright en PostgreSQL y puertos aislados: **2 passed** (`§73` flujo principal y `§74` offline/idempotencia). La configuración admite `E2E_APP_PORT`/`E2E_API_PORT` para no reutilizar un servidor de desarrollo ajeno; el backend temporal recibe el origen exacto permitido.

## Pendientes fuera de alcance

- MEDIUM: 8.
- LOW: 4.

No se declara aptitud para piloto. La segunda auditoría independiente debe validar los cambios y decidir el veredicto final.
