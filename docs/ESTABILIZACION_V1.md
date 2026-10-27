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

---

# Correcciones de la auditoría Codex (sobre `4321dd2`)

Veredicto recibido: **B. Requiere correcciones**: cuatro hallazgos y E2E inestable (11 aprobadas,
13 fallidas, 1 omitida).

## Hallazgo 1 (P0): pérdida de la copia offline

- **Causa.** `saveQueryCache` guardaba solo consultas con `status === "success"` y reescribía la copia
  completa. Una actualización fallida (`error`, con datos todavía válidos) la borraba. Lo mismo pasaba
  cuando React Query descartaba de memoria una consulta sin uso (por ejemplo, la carta mientras se está
  en el salón).
- **Solución.** Se guarda toda consulta con datos, normalizada como última respuesta válida. Se fusiona
  con lo guardado y solo una respuesta más reciente reemplaza a otra. La vigencia de 24 h es por
  respuesta. Al restaurar, los datos quedan vencidos y se revalidan al reconectar. El servidor sigue
  autorizando cada operación: la copia solo se usa para mostrar.
- **Pruebas.** `queryCache.test.ts`: error de actualización con tres recargas seguidas y revalidación,
  consulta descartada de memoria, datos vencidos. Las dos primeras fallan con `4321dd2`. E2E
  «Codex 1»: la API cae con `navigator.onLine=true`, se recarga, se esperan los reintentos, se desconecta
  la red, se recarga otra vez y se revalida al volver.

## Hallazgo 2 (P0): carrera entre sesiones

- **Causa.** `refresh()` publicaba el resultado de una lectura de IndexedDB aunque, al terminar, la
  sesión fuera de otro usuario. `pendingOrders.sync` tomaba esa lectura como prueba de que la operación
  de Luis ya no existía y borraba su referencia. Además, `flushQueue` verificaba al propietario antes de
  un `await`, no inmediatamente antes de enviar.
- **Solución.** Generación de sesión en `stores/queue.ts`: cada lectura registra usuario y generación y
  se descarta si cambiaron. `ownerId` indica para quién es la lectura publicada. `pendingOrders` solo
  elimina registros con una lectura completa del usuario actual, iniciada después de crearlos. `flushQueue`
  envía en nombre de un único usuario (sesión y `sub` del token) y se detiene si cambian. La operación
  interrumpida vuelve intacta a `LOCAL_PENDING`.
- **Pruebas.** `queueSessionRace.test.ts` (lecturas demoradas resueltas en orden inverso: Luis solo ve
  lo suyo, sus referencias siguen intactas, ninguna operación se borra de IndexedDB) y `queue.test.ts`
  (cambio de sesión durante el envío; token de otro usuario).

## Hallazgo 3 (P0): operaciones offline trasladadas a otro turno

- **Causa.** Los endpoints asignaban siempre el turno abierto en el momento de sincronizar.
- **Solución.** Campo opcional `shift_id` (turno de origen) en gastos, apertura de pedido y comandas.
  Se compara dentro del bloqueo del turno: si no coincide, 409 `SHIFT_MISMATCH`, sin crear nada. En la
  cola queda `SYNC_ERROR` con su UUID, revisable y descartable. El frontend siempre lo envía: gasto y
  primera comanda con el turno abierto conocido, comandas con el turno del pedido o el de su operación
  padre. Sin turno conocido no se generan. Los clientes antiguos sin `shift_id` conservan el
  comportamiento anterior.
- **Pruebas.** `test_codex_shift_binding.py`, con PostgreSQL real: turno A con gasto y primera comanda
  pendientes, cierre de A, apertura de B, sincronización rechazada dos veces, cero registros y reportes de
  A y B en cero. Además, comanda con otro turno, compatibilidad y sin turno abierto. En el frontend,
  `OpenTableDraft.test.tsx`.

## Hallazgo 4 (P1): idempotencia de gastos después del cierre

- **Causa.** La dependencia `OpenShift` exigía un turno abierto antes de buscar la respuesta idempotente.
- **Solución.** En `POST /expenses`, `POST /orders` y `POST /orders/open-with-command` el turno se exige
  dentro de la operación idempotente. Un reenvío del mismo UUID, mismo usuario y misma operación devuelve
  la respuesta registrada; un UUID nuevo sin turno abierto sigue respondiendo 404, y el de otro usuario,
  409.
- **Pruebas.** Gasto con respuesta perdida, cierre y reenvío: mismo cuerpo y exactamente un gasto.
  UUID ajeno, UUID nuevo y sin token. Lo mismo para la primera comanda.

## E2E inestable: diagnóstico

Instrumentación: muestreo cada 2 s de `pg_stat_activity`, latencia de `/health` y renderers de Chromium.
Además, `faulthandler` y un script de carga determinista (`load_repro.py`: 120 peticiones concurrentes
autenticadas y reconexiones WebSocket durante 40 s contra un uvicorn sobre la base E2E).

- **Reproducción con `4321dd2`.** 11 aprobadas, 13 fallidas, 1 omitida, igual que Codex. A partir de la
  prueba 12, `pg_stat_activity` muestra 15 transacciones `idle in transaction` (el pool completo), su
  antigüedad crece sin parar hasta 289 s y `/health` no responde en 3 s. No hay bloqueos SQL.
- **Defecto del producto (livelock pool/threadpool).** Las dependencias síncronas
  (`get_current_user`) abren transacción y toman una conexión. El endpoint corre en otro salto al
  threadpool. Con más peticiones que conexiones, las nuevas ocupan los 40 hilos esperando conexión (30 s)
  y las que tienen conexión esperan hilo. Con entrada continua de peticiones, nunca avanzan. La WebSocket
  validaba la sesión con SQLAlchemy síncrono **en el bucle de eventos**, y cada reconexión congelaba el
  servidor entero mientras esperaba una conexión del pool.
- **Defecto del arnés.** Los contextos creados con `browser.newContext()` no se cerraban. Las páginas de
  pruebas anteriores seguían consultando y reconectando (20 a 34 renderers) y su carga acumulada disparaba
  el livelock.
- **Correcciones.** `DatabaseAdmissionMiddleware`: como máximo `DB_POOL_SIZE + DB_MAX_OVERFLOW`
  peticiones `/api` a la vez; el resto espera en el bucle de eventos sin hilo ni conexión. La
  autenticación de la WebSocket pasa a `asyncio.to_thread`. En el arnés, `e2e/fixtures.ts` cierra los
  contextos de cada prueba. No se aumentó ningún timeout.

| Carga determinista (40 s) | Correctas | Errores | `/health` OK | `idle in transaction` máx. |
|---|---|---|---|---|
| `4321dd2` | 92 | 140 | 0/13 | 15 (sin recuperarse) |
| Solo corrección WebSocket | 77 | 153 | 0/13 | 15, 26,8 s |
| WebSocket + admisión | 2228 | 0 | 42/42 (máx. 1,1 s) | 0,14 s; 0 al terminar |

## Resultados finales (2026-10-25, entorno local, PostgreSQL 16 en Docker)

| Verificación | Resultado |
|---|---|
| Ruff | sin errores |
| Pytest (PostgreSQL real) | 233 aprobadas (222 + 7 de turno e idempotencia + 4 de admisión) |
| Alembic check | sin operaciones pendientes |
| TypeScript / ESLint | sin errores |
| Vitest | 148 aprobadas |
| Build frontend/PWA | correcto (lo ejecuta cada pasada de Playwright) |
| Playwright completo, 3 pasadas seguidas | 25 aprobadas y 1 omitida en cada una (`screenshots.spec.ts`, requiere `SHOTS_DIR`) |
| Muestreo en las 3 pasadas | `/health` ≤ 44 ms con el servidor activo; ninguna transacción ociosa ≥ 1 s; 0 conexiones al terminar |

Con `4321dd2` el resultado fue intermitente: una pasada con 11 aprobadas y 13 fallidas (cuelgue
reproducido), otra con todo aprobado. Las tres pasadas con las correcciones terminaron sin fallos. La
carga determinista de la tabla anterior es la evidencia de que el cuelgue ya no puede producirse con
más peticiones que conexiones.

### Pendiente y riesgos residuales

- (Resuelto en la segunda auditoría, ver más abajo) Operaciones encoladas sin `shift_id` por versiones anteriores.
- Con más de `DB_POOL_SIZE + DB_MAX_OVERFLOW` peticiones simultáneas, las demás esperan turno: más
  latencia en picos, en lugar del cuelgue. Revisar el tamaño del pool según el plan de PostgreSQL.
- La validación en un dispositivo físico (PWA instalada, red real intermitente) no se hizo en este entorno.

---

# Segunda auditoría Codex (sobre `1aebaa1`): dos hallazgos ALTOS

## Hallazgo A: el reintento tras un 401 podía registrar la operación a nombre de otro usuario

- **Causa.** La comprobación de dueño de `flushQueue` ocurría antes de `apiRequest`. Ante un 401,
  `apiRequest` renovaba con el refresh token guardado *en ese momento* y reintentaba con el access token
  nuevo, sin comprobar que siguieran siendo del dueño. Si entretanto había ingresado B, el gasto de A
  quedaba creado por B y la operación local se marcaba `SYNCED`. Además, una renovación de A que
  terminaba después del ingreso de B reemplazaba los tokens de B.
- **Solución.** `apiRequest({ owner })` comprueba el `sub` del token guardado antes de enviar, al recibir
  el 401 (sin renovar ni invalidar la sesión ajena) y antes del reintento. Si no coincide, lanza
  `OwnerChangedError`, y la cola devuelve la operación intacta (mismo UUID, `LOCAL_PENDING`, dueño
  original). `refreshSession` devuelve `superseded` y no toca los tokens si otra sesión los reemplazó
  durante la renovación.
- **Pruebas.** `queue.test.ts` (A → cambio a B → 401 de A: un solo envío, sin renovación ni reintento,
  operación de A intacta y sesión de B válida; B ingresa durante la renovación de A; camino legítimo de
  A con renovación y reintento) y `client.test.ts`. E2E «Codex 2a» con el servidor real: interceptando
  solo el momento de la respuesta, no hay `/auth/refresh` ni segundo envío, no se crea ningún gasto,
  la operación sigue pendiente y el refresh token de B sigue siendo válido en el servidor. Con
  `1aebaa1`, las dos pruebas de cola y el E2E fallan (este registra un segundo envío).

## Hallazgo B: operaciones heredadas sin turno asignadas al turno siguiente

- **Causa.** Por compatibilidad, el servidor solo compara el turno si recibe `shift_id`, y el cliente
  actualizado enviaba sin revisión las operaciones que una versión anterior había dejado en la cola.
- **Solución.** En el cliente, un gasto, apertura de pedido o primera comanda sin `shift_id` queda en
  `SYNC_ERROR` (`LEGACY_WITHOUT_SHIFT`) sin enviarse, también al reintentar. Se conserva con su UUID
  para conciliarlo, y sus comandas encadenadas quedan igual. El contrato REST no cambia: un cliente
  antiguo sigue funcionando como antes, pero el cliente actual ya no reasigna su propia cola heredada.
- **Pruebas.** `queue.test.ts` (formato exacto de `4321dd2`: nada se envía, ni siquiera al reintentar;
  una comanda sobre un pedido existente sí se envía). E2E «Codex 2b»: cola de la versión anterior
  inyectada en IndexedDB y recarga del cliente; quedan «2 con error» con el motivo, la mesa aparece
  «No enviada» y no se crea ningún gasto ni pedido. Con `1aebaa1` las operaciones se sincronizaban
  (falla).

## Resultados de esta ronda

| Verificación | Resultado |
|---|---|
| Ruff | sin errores |
| Pytest (PostgreSQL real) | 233 aprobadas |
| Alembic check | sin operaciones pendientes |
| TypeScript / ESLint | sin errores |
| Vitest | 154 aprobadas (6 nuevas en esta ronda) |
| Build frontend/PWA | correcto (lo ejecuta Playwright) |
| Playwright completo | 27 aprobadas, 1 omitida (`screenshots.spec.ts`, requiere `SHOTS_DIR`) |
| Muestreo durante Playwright | `/health` ≤ 11 ms con el servidor activo, sin timeouts reales; ninguna transacción ociosa ≥ 1 s; 0 conexiones al terminar |

Pendiente: la validación de la PWA instalada en dispositivos físicos con red intermitente real no se
hizo en este entorno.

---

# Tercera auditoría Codex (sobre `7c752a6`): hallazgo A en el envío inmediato

- **Causa.** Solo `flushQueue` pasaba `owner` a `apiRequest`. El envío inmediato
  (`sendOrQueue → expensesApi.create`) no lo hacía: ante un 401 tras cambiar de A a B, renovaba con la
  sesión de B, reintentaba, registraba el gasto como de B y `sendOrQueue` borraba la operación de A.
- **Solución.** Toda petición autenticada queda ligada por defecto al dueño del token guardado al iniciarla
  (`owner` explícito o, si no se indica, el `sub` del token), durante el envío, la renovación y el
  reintento. Así se cubren todas las llamadas directas sin depender de que cada endpoint lo propague.
  `sendOrQueue` trata `OwnerChangedError` conservando la operación `LOCAL_PENDING` con su dueño y UUID
  (no la borra) y avisa «Sesión cambiada».
- **Pruebas.**
  - `send.test.ts` usa `sendOrQueue` y `expensesApi.create` reales: cambio de A a B antes del 401 y
    durante la renovación (ningún reintento, operación pendiente de A con el mismo UUID, credenciales de
    B intactas), más el camino normal de A (renovación y reintento con el mismo UUID).
  - `client.test.ts`: dueño implícito.
  - E2E «Codex 3» con el servidor real por la vía inmediata: ningún gasto creado, sin `/auth/refresh`,
    un solo envío, operación de A pendiente y refresh token de B válido en el servidor.
  - Con `7c752a6` fallan las dos pruebas de cambio, la de dueño implícito y el E2E, que registra una
    renovación con la sesión de B.

## Resultados de esta ronda

| Verificación | Resultado |
|---|---|
| Ruff | sin errores |
| Pytest (PostgreSQL real) | 233 aprobadas |
| Alembic check | sin operaciones pendientes |
| TypeScript / ESLint | sin errores |
| Vitest | 158 aprobadas (4 nuevas) |
| Build frontend/PWA | correcto (lo ejecuta Playwright) |
| Playwright completo | 28 aprobadas, 1 omitida (`screenshots.spec.ts`, requiere `SHOTS_DIR`) |
| Muestreo durante Playwright | `/health` ≤ 25 ms con el servidor activo, sin timeouts reales; ninguna transacción ociosa ≥ 1 s; 0 conexiones al terminar |

Pendiente: la validación de la PWA instalada en dispositivos físicos con red intermitente real.

---

# Cuarta auditoría Codex (sobre `41100be`): cambio de usuario durante la escritura inicial

- **Causa.** `sendOrQueue` creaba la operación para A y esperaba la escritura en IndexedDB. Después
  ejecutaba la petición, y `apiRequest` tomaba como dueño el `sub` del token *en ese momento*. Si B había
  ingresado durante la escritura, la petición salía como B (201, `created_by_user_id = B`) y la operación
  de A se borraba. No hacía falta un 401.
- **Solución.** Tras `await enqueue(...)`, `sendOrQueue` comprueba que la sesión y el token sigan siendo
  de `queued.owner_user_id`; si no, aplica el tratamiento de `OwnerChangedError` (operación pendiente de A,
  mismo UUID, ninguna petición). La petición de `exec` se liga explícitamente a ese dueño con
  `withRequestOwner` (vinculación síncrona que `apiRequest` lee al iniciar), así que no depende de las
  credenciales guardadas. Todos los `exec` actuales inician su petición sin `await` previo.
- **Pruebas.**
  - `send.test.ts`: cambio de A a B durante la escritura inicial (cero peticiones, operación pendiente de
    A, credenciales de B intactas) y cambio solo de las credenciales guardadas. Se conservan las pruebas
    de 401 y renovación.
  - `client.test.ts`: `withRequestOwner`.
  - E2E «Codex 4» en Chromium, con IndexedDB y servidor reales y sin simular respuestas HTTP: una
    transacción ocupa la cola, B ingresa y se libera. Cero `POST /expenses` y `/auth/refresh`, ningún
    gasto, operación de A pendiente y refresh token de B válido.
  - Con `41100be` fallan las dos unitarias y el E2E, que registra el gasto como `admin` en la base E2E.

## Resultados de esta ronda

| Verificación | Resultado |
|---|---|
| Ruff | sin errores |
| Pytest (PostgreSQL real) | 233 aprobadas |
| Alembic check | sin operaciones pendientes |
| TypeScript / ESLint | sin errores |
| Vitest | 161 aprobadas (3 nuevas) |
| Build frontend/PWA | correcto (lo ejecuta Playwright) |
| Playwright completo | 29 aprobadas, 1 omitida (`screenshots.spec.ts`, requiere `SHOTS_DIR`) |
| Muestreo durante Playwright | `/health` ≤ 40 ms con el servidor activo, sin timeouts reales; ninguna transacción ociosa ≥ 1 s; 0 conexiones al terminar |

Pendiente: la validación de la PWA instalada en dispositivos físicos con red intermitente real.

---

# Arranque de la PWA detenido en la pantalla de carga (rama `fix/pwa-arranque-offline`)

- **Síntoma.** La PWA queda en el indicador de carga inicial (`AppRouter` con `initialized === false`)
  antes de mostrar el salón.
- **Causa.** `restore()` esperaba la respuesta de `/auth/me` antes de terminar la inicialización. Sin red
  la petición falla al instante, pero con una red que no responde (Wi-Fi sin Internet, mala señal) tarda
  hasta el timeout de 15 s, y 30 s si además intenta renovar el token. Medido con la API colgada: el
  salón aparecía a los **15,3 s**. Además, un error inesperado dentro de `restore()` (por ejemplo,
  almacenamiento bloqueado) dejaba `initialized` en `false` **para siempre**.
- **Solución.** Si la identidad guardada coincide con el dueño del token local, la interfaz arranca de
  inmediato como `unverified` y `revalidate()` confirma la sesión en segundo plano (y de nuevo con el
  evento `online`). Si el servidor rechaza la sesión, se limpia y se vuelve al ingreso. El servidor sigue
  autorizando cada operación y la cola no envía sin un token válido del dueño. Sin identidad local
  utilizable se espera al servidor como antes. `initialized` termina siempre en `true` (`finally`). Una
  confirmación no toca la sesión si otro usuario ingresó mientras tanto. No se borra IndexedDB ni la copia
  local de consultas.
- **Pruebas.**
  - `session.test.ts`: arranque con `/auth/me` colgado, confirmación en segundo plano, rechazo, sin
    identidad local, error inesperado, cambio de usuario durante la confirmación. Con `main` fallan 4.
  - E2E «Arranque en frío»: la PWA se cierra y se reabre, sin una página abierta antes del corte. Sin red
    y con la API sin responder, el salón aparece en menos de 5 s, la operación pendiente sigue en la cola
    y, al volver la API, se sincroniza. Con `main` falla en el caso de la API sin responder (captura: la
    misma pantalla de carga).
  - `LocalOrders.test.tsx`: se sustituyó una espera fija de 50 ms por la condición real (cola leída para
    el usuario). Fallaba de forma intermitente bajo carga.

| Verificación | Resultado |
|---|---|
| Ruff, Alembic check, TypeScript, ESLint | sin errores |
| Pytest (PostgreSQL real) | 233 aprobadas |
| Vitest | 166 aprobadas (3 ejecuciones seguidas) |
| Playwright completo (incluye build PWA) | 30 aprobadas, 1 omitida (capturas opcionales) |
| Muestreo durante Playwright | `/health` ≤ 107 ms, sin timeouts reales; ninguna transacción ociosa ≥ 1 s; 0 conexiones al terminar |

Pendiente: validar en Android con la PWA instalada (arranque sin red, Wi-Fi sin Internet y red
intermitente). En este entorno no hay dispositivo físico.

# Auditoría técnica del 2026-10-27 (sobre `eee00b8`), rama `fix/auditoria-sesion-estados`

## P0: una respuesta tardía de `/auth/me` podía imponer la identidad de otra sesión

- **Causa.** `revalidate()` solo comparaba al usuario devuelto con el que inició la consulta, no con el que
  está activo ahora. Si Ana empezaba una confirmación lenta e ingresaba Luis, la respuesta de Ana
  reemplazaba a Luis. Un rechazo tardío (403, por ejemplo) borraba las credenciales de Luis, y una
  confirmación que llegaba después de cerrar sesión devolvía a Ana a la interfaz sin tokens. La
  restauración que espera al servidor tenía el mismo defecto.
- **Corrección.** `session.ts` lleva una *generación de sesión*, que avanza con cada ingreso, salida o
  expiración. Una confirmación o un rechazo solo se aplican si la generación, el usuario activo y el dueño
  del token guardado siguen siendo los mismos que al empezar. `apiRequest` vuelve a comprobar al dueño
  antes de borrar credenciales tras una renovación rechazada.
- **Pruebas.** Cinco en `session.test.ts`: confirmación tardía con otro usuario, rechazo tardío con otro
  usuario, confirmación tardía después de cerrar sesión, cambio del dueño del token y restauración pisada
  por un ingreso. Con `eee00b8` fallan las cinco.

## P1: falla de red mostrada como ausencia de datos (cocina, pedidos, panel)

- **Causa.** Con la consulta fallida o en pausa por falta de red, y sin copia local, `data` llega
  `undefined` y las pantallas lo trataban como una lista vacía: «No hay comandas pendientes», «No hay
  pedidos activos», importes en `S/ 0.00` y «No hay un turno abierto».
- **Corrección.** `lib/freshness.ts` distingue `loading`, `confirmed`, `stale` (hay copia, pero la consulta
  falló o está en pausa) y `unavailable` (no hay copia). Sin datos, las pantallas muestran
  «No se pudieron cargar…» y un botón Reintentar. Con una copia local, la muestran con un aviso y la hora
  de la última actualización. En el panel, cada cifra sin datos aparece como «—» y el turno como
  «Turno sin confirmar».
- **Pruebas.** `BoardPage.test.tsx`, `ActiveOrdersPage.test.tsx` y `DashboardPage.test.tsx`: falla sin
  copia, pausa sin red, copia con su hora y datos confirmados sin aviso. Con `eee00b8` fallan 8.

## P1: la pantalla de cobro ocultaba una cuenta válida

- **Causa.** `billing.isError || !data` ocultaba la cuenta aunque React Query conservara la última copia.
- **Corrección.** La cuenta guardada sigue visible, con aviso y hora. El botón «Cobrar» queda bloqueado
  («Cobro bloqueado sin conexión») hasta que el servidor responda. «Verificar pago pendiente» sigue
  activo, porque reenvía la misma operación idempotente y no crea un cobro nuevo.
- **Pruebas.** `BillingPage.test.tsx`: error con copia, pausa sin red, sin copia y reconexión. Con
  `eee00b8` fallan 2 (los otros dos ya se cumplían).

## P2: cierre de sesión lento sin conexión

- **Causa.** `logout()` esperaba hasta 2,5 s por las notificaciones push y después hasta 15 s por
  `/auth/logout` antes de limpiar la sesión local.
- **Corrección.** La salida local es inmediata, y sigue bloqueada si quedan operaciones sin enviar. La
  revocación en el servidor (`revokeSession`) continúa en segundo plano con las credenciales de quien
  sale, sin leer ni modificar las guardadas: si otro usuario ingresa mientras tanto, no lo afecta. Si el
  acceso venció, renueva solo para revocar y no guarda los tokens nuevos. La suscripción push del
  navegador se anula localmente; el `/auth/logout` del servidor ya borra las del dispositivo.
- **Pruebas.** `session.test.ts`: salida con el servidor colgado, revocación con las credenciales de quien
  salió aunque ya haya ingresado otro usuario, y renovación solo para revocar. Con `eee00b8` fallan las tres.

## Resultados de esta ronda

| Verificación | Resultado |
|---|---|
| TypeScript, ESLint, build PWA | sin errores |
| Pytest (PostgreSQL real) | 233 aprobadas (sin cambios de backend) |
| Vitest | 189 aprobadas (23 nuevas; 18 fallan con `eee00b8`) |
| Playwright completo (incluye build PWA) | 30 aprobadas, 1 omitida (capturas opcionales) |

Pendiente: prueba física en Android con la PWA instalada (cambio de usuario con red lenta, cierre de sesión
sin red, cocina y cobro sin conexión) y confirmar el despliegue en Render. En este entorno no hay
dispositivo físico.
