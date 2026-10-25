# Estabilización funcional V1 (2026-10-25)

Rama: `fix/v1-estabilizacion-funcional`. Alcance: corregir defectos confirmados de la V1 para un solo
restaurante, sin módulos, pantallas, roles ni dependencias nuevas, y sin cambiar los contratos REST
existentes. Todos los cambios de API son aditivos y los clientes anteriores siguen funcionando.

## Defectos, causa raíz y corrección

### P0-01 — La PWA perdía la interfaz al recargar sin conexión

- **Causa.** `session.restore()` borraba tokens e identidad ante *cualquier* error de `/auth/me`,
  incluido un fallo de red. Además, `tryRefresh()` devolvía `false` tanto si el refresh era inválido
  como si no había red, y `apiRequest` limpiaba los tokens en ambos casos. Sin caché de consultas,
  el salón tampoco tenía datos que mostrar.
- **Corrección.**
  - `refreshSession()` distingue `refreshed | invalid | unreachable`. Sin red o con 5xx se lanza
    `NetworkError` y la sesión se conserva. Solo un rechazo real limpia los tokens y notifica
    `onSessionExpired`.
  - `restore()` conserva al usuario sin red solo si coincide con el `sub` del token local
    (`unverified`). `revalidate()` lo confirma al volver la red.
  - La cola no convierte un `SESSION_EXPIRED` en `SYNC_ERROR`: la operación queda pendiente con su UUID.
  - `offline/queryCache.ts` persiste por usuario las consultas operativas, con `dehydrate`/`hydrate`
    de React Query (sin dependencias nuevas). Se purga al cambiar de usuario o cerrar sesión.
- **Por qué así.** La cola, la idempotencia y la autenticación del servidor no cambian. No se guarda
  ninguna credencial adicional y el servidor sigue validando cada petición.

### P0-02 — No se podía volver a una mesa con comanda pendiente

- **Causa.** `TableTile` tenía `disabled={… || pending}`. `TableOrderPage` no mostraba el contenido de
  la cola, y un registro con error desaparecía de la vista sin explicación.
- **Corrección.** La mesa se puede abrir. La página muestra las líneas en cola, separa
  borrador / pendiente / confirmado / error, y permite reintentar o descartar una primera comanda
  rechazada. `pendingOrders.sync` limpia el error al reintentar y elimina el registro si la operación
  se descartó. Usa `snapshotAt` para no borrar con una lectura anterior a su creación. Al confirmarse
  operaciones se invalidan pedidos, mesas, tableros, gastos y reportes.

### P0-03 — Gastos y resultado neto en cero sin ventas

- **Causa.** `_shift_ids(orders)` obtenía los turnos a partir de los pedidos. Sin pedidos no había
  turnos, y por tanto tampoco gastos.
- **Corrección.** `services/reports.select_shifts()` elige primero los turnos y, después, los pedidos
  y los gastos de esos turnos. Los importes se calculan con `Decimal`. `POST /expenses` emite
  `expense.created` al administrador. El panel invalida los reportes con ese evento y con `order.paid`,
  y refresca sus importes cada 15 s (los pagos parciales no emiten evento). Un neto negativo se muestra
  como `-S/ 80.00`.

### P0-04 — «Todo» mostraba el turno actual

- **Causa.** «Todo» enviaba la consulta sin parámetros, que el backend interpreta como turno actual.
  Además, los límites de fecha se calculaban en UTC.
- **Corrección.** Nuevo `scope=all` (opcional; sin parámetros se mantiene el turno actual). Los días
  se calculan en `America/Lima` (`business_timezone`, que ya existía y no se usaba), con fin exclusivo,
  también en `/shifts/history`. Un turno pertenece al día local en que se abrió. `ReportsPage` añade
  «Turno actual» como período seleccionable y calcula las fechas en hora de Perú.

### P0-05 — Se podía desactivar una mesa ocupada

- **Causa.** `PATCH /tables/{id}` no comprobaba la ocupación, y abrir un pedido no comprobaba
  `is_active`.
- **Corrección.** Las dos operaciones bloquean la fila de la mesa (`FOR UPDATE`). El orden de bloqueo
  es turno → mesa → pedido, sin ciclos. Desactivar una mesa ocupada devuelve 409 `TABLE_OCCUPIED` y
  abrir una mesa inactiva, 409 `TABLE_INACTIVE`. El pedido existente no cambia. Una mesa inactiva con
  pedido vivo (datos anteriores) se muestra ocupada y sigue accesible.

### P1-01 — Pedidos pagados

El backend ya rechazaba comandas y cancelaciones en un pedido `PAID`, pero permitía preparar y
entregar. Ahora la interfaz del mesero oculta la carta y «Cancelar», mantiene «Entregado» y renombra
«Cobrar» como «Ver pago». El tablero no ofrece «Cancelar plato» si `order_general_status` es `PAID`.

### P1-02 — Cancelaciones offline

«Producto cancelado» solo se anuncia cuando el servidor lo confirma. Una cancelación o entrega en cola
se marca «pendiente de envío» en el plato y oculta la acción repetida. Si el servidor ya muestra el
plato cancelado o entregado, prevalece el estado del servidor.

### P1-03 — Carta y disponibilidad

- `GET /menu` excluía las categorías inactivas pero no sus productos, y la comanda los aceptaba.
  Ahora ambos aplican la misma regla (404 `MENU_ITEM_NOT_FOUND`).
- El administrador no podía reactivar productos ni categorías porque nunca los recibía. Su pantalla
  ya contemplaba lo inactivo. Ahora usa `include_inactive=true`, que solo admite al administrador.
- Crear un producto y cambiar una categoría emiten `menu.changed`.
- Si un producto se agota mientras se arma la comanda, el carrito lo marca y bloquea el envío. El
  servidor sigue respondiendo 409 `ITEM_SOLD_OUT` sin crear un pedido parcial.

## Pruebas añadidas

- Backend: `tests/test_v1_stabilization.py` (20 pruebas). 15 fallan con el código anterior.
- Frontend (Vitest): `session.test.ts`, `pendingOrders.test.ts`, `queryCache.test.ts`,
  `LocalOrders.test.tsx`, `ReportsPage.test.ts`, `TablesAdminPage.test.tsx`, y ampliaciones de
  `client.test.ts`, `queue.test.ts`, `BoardPage.test.tsx` y `useElapsed.test.ts`. 25 fallan con el
  código anterior.
- E2E: `e2e/stabilization.spec.ts` (recarga offline de la PWA, mesa pendiente, sincronización única,
  gasto en el panel, «Todo», mesa ocupada). Con el frontend anterior falla en la mesa deshabilitada.

## Reproducir la validación

```bash
docker compose up -d db db-test
cd backend
.venv/bin/python -m ruff check .
.venv/bin/python -m pytest -o addopts="" -q
DATABASE_ENV=test ENVIRONMENT=test DATABASE_URL=postgresql+psycopg://restaurante:restaurante@localhost:5433/restaurante_test \
  .venv/bin/python -m alembic check
cd ../frontend
npx tsc --noEmit && npx eslint . && npx vitest run && npm run build
npx playwright test
```

## Riesgos y límites conocidos

- La copia local de consultas vive en `localStorage` (máximo 24 h) y contiene datos operativos del
  usuario (pedidos activos, mesas, carta). Se borra al cerrar sesión, al expirar la sesión o al cambiar
  de usuario. Un dispositivo que se apaga sin cerrar sesión la conserva hasta el siguiente ingreso.
- Un usuario recuperado sin conexión es `unverified`: ve sus datos locales y encola operaciones, pero
  nada llega al servidor sin un token válido.
- `/reports/current-shift` sin turno abierto sigue mostrando el último turno, igual que antes; el panel
  y los reportes lo indican.
- Con `waiter_id`, los gastos corresponden a los turnos del período completo (no se atribuyen a un
  mesero). Ningún cliente actual usa ese filtro.
- Los pagos parciales no emiten evento: el panel los refleja en un máximo de 15 s.

## Resultados de la validación (2026-10-25, entorno local, PostgreSQL 16 en Docker)

| Verificación | Resultado |
|---|---|
| Ruff | sin errores |
| Pytest (PostgreSQL real de pruebas) | 222 aprobadas (202 previas + 20 nuevas) |
| Alembic check | sin operaciones pendientes |
| TypeScript / ESLint | sin errores |
| Vitest | 139 aprobadas (96 previas + 43 nuevas) |
| Build de producción | correcto (lo ejecuta Playwright) |
| Playwright | 24 aprobadas; 1 omitida: `screenshots.spec.ts`, solo genera capturas con `SHOTS_DIR` (no es funcional, ya se omitía antes) |
