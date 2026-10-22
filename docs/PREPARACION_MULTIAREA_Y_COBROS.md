# Cobros simplificados y platos con preparación en varias áreas

Rama: `feature/cobros-simple-y-preparacion-multiarea` (parte de `main`, que ya incluye
`feature/notificaciones-push`). Migración nueva: `0007_preparation_tasks` (cabeza anterior: `0006_push_device`).

## 1. Diagnóstico de la arquitectura previa

| Hallazgo | Consecuencia |
|---|---|
| `order_items.preparation_area` guardaba **una** área por plato | Un plato no podía requerir cocina y parrilla a la vez. Tableros, autorización, Push, WebSocket y reportes dependían de esa columna. |
| Los tableros filtraban por `Order.status ∈ {OPEN, IN_PREPARATION, READY, DELIVERED}` y un cobro total pone `PAID` | **Riesgo real**: un pedido pagado por adelantado desaparecía de cocina/parrilla (y de «pedidos activos» del mesero) con platos sin preparar, y no podía completarse. |
| Además `PAID` libera la mesa y el cierre de turno solo miraba `OPEN…DELIVERED` | Un turno podía cerrarse con platos cobrados aún sin preparar; después `ensure_shift_open` impedía terminarlos. |
| El cambio de estado de ítem no bloqueaba filas (solo el turno) | Con dos áreas actualizando a la vez no había una transición única y auditable a «listo». |
| División de cuentas: `bill_splits`, `bill_split_items`, `payments.split_id`, `POST /splits` | Ya no se desea. Los pagos (incluidos los parciales históricos) deben conservarse. |

## 2. Cobros: división de cuentas retirada

- `POST /orders/{id}/splits` responde **410 `SPLITS_DISABLED`** (exige sesión; no escribe nada).
- `POST /orders/{id}/payments` con `split_id` responde **422 `SPLIT_PAYMENTS_DISABLED`**; ya no se asigna `payments.split_id`.
- Se **conservan** sin cambios: protección de saldo (`PAYMENT_EXCEEDS_PENDING`), idempotencia por
  `client_operation_id`, cálculo con `Decimal`, permisos (ADMIN / mesero dueño), bloqueo turno → pedido,
  auditoría `PAYMENT_REGISTERED`, paso a `PAID`, informes de ventas y métodos de pago.
- `GET /billing` ya no devuelve `splits` ni `split_quantity`; añade `legacy_splits` (solo lectura) y los
  pagos históricos siguen mostrando su `split_id`.
- **Tablas históricas**: `bill_splits` y `bill_split_items` **no se tocan** (quedan como registro contable, la
  aplicación ya no escribe en ellas). Estrategia de retirada: (1) esta versión las deja de escribir; (2) tras un
  periodo de observación con `SELECT count(*) FROM bill_splits` estable, una migración futura puede
  archivarlas y retirar `payments.split_id` **solo si** el contador confirma que no hay datos que conservar
  o se exportaron. No se hace ahora para no perder trazabilidad contable.
- Pantalla de cobro (`BillingPage`): consumo con cantidades, total / pagado / pendiente, método (efectivo,
  Yape, Plin, tarjeta, otro), botón «Cobrar S/ pendiente» (siempre el saldo completo), historial «Pagos realizados». No hay campo
  de monto ni «pago parcial» en la interfaz; el backend sigue validando saldo y aceptando montos menores
  (API/historial), así que los pagos parciales históricos y la integridad financiera no cambian. Se conserva la
  verificación de pagos con respuesta perdida (misma clave y monto tras recargar).

## 3. Diseño de la preparación compartida

Separación estricta: **producto comercial** (`order_items`: lo que se paga) vs **tareas** (trabajo interno).

```
menu_items 1 ──< menu_preparation_steps      receta vigente (nombre, área, minutos, orden, activa)
order_items 1 ──< order_item_preparation_tasks   copia congelada al crear la comanda
```

- Al registrar una comanda, `create_command` copia los pasos **activos** vigentes a tareas del plato
  (`menu_step_id` es solo un vínculo informativo, `ON DELETE SET NULL`). Los pedidos **nunca** reconstruyen
  tareas desde el catálogo; cambiar o borrar una receta no altera comandas ya registradas (probado).
- Producto sin pasos pero con área (datos antiguos o creados por scripts) ⇒ **una tarea equivalente**
  (`steps_for_menu_item`). Producto sin preparación ⇒ sin tareas, entrega directa como antes.
- Cantidad: un plato × N unidades es **una línea con N unidades y una tarea por paso** (no N×pasos tareas).
  Importes, cobro y reportes salen solo de `order_items`; las tareas no tienen precio.
- Resumen compatible: `order_items.preparation_area` = área de la primera tarea y
  `expected_prep_minutes_snapshot` = tiempo de la más larga (las tareas son paralelas).
- **Extensibilidad**: dependencias secuenciales se añadirían con una tabla
  `order_item_task_dependencies(task_id, depends_on_task_id)` y marcando como «disponible» solo la tarea sin
  dependencias pendientes; no requiere cambiar `order_items` ni las tablas actuales. Tareas opcionales:
  columna `is_required` (hoy todas son obligatorias). Más áreas: ampliar el `CHECK` de `area`.

### Estados y sincronización

- Tarea: `PENDING → PREPARING → READY` (+ `CANCELLED` solo por cancelación del plato).
  Solo avanza: repetir o retrasar un estado es una operación nula (200, sin eventos ni auditoría); saltarse
  un paso es 409.
- Plato (derivado en `refresh_item_from_tasks`): `PREPARING` al iniciar la primera tarea; `READY` solo cuando
  **todas** las tareas están `READY`; `DELIVERED` lo marca el mesero (no antes de `READY`).
- **Única transición a `READY`**: ocurre dentro de la transacción que bloquea turno → pedido → plato → tareas
  (`SELECT … FOR UPDATE`) y solo desde `PENDING/PREPARING`. Dos áreas terminando casi a la vez se serializan:
  exactamente una ve «todas listas» y emite `order_item.ready` (probado con hilos reales, 3 rondas).
- Cancelación: `cancel_item` cancela el plato y **todas** sus tareas (también las de otras áreas) en una sola
  operación; descuenta el importe una vez; se rechaza en `PAID`/`CLOSED`, si ya está `READY/DELIVERED`, o si el
  total quedaría bajo lo pagado. No existe cancelación parcial de una tarea.
- Pago anticipado: el estado financiero (`PAID`) ya no oculta el trabajo. Tableros, «pedidos activos» del mesero
  y el cierre de turno miran el **progreso de preparación** (platos con preparación en
  `PENDING/PREPARING/READY`), no el estado del pedido; solo `CLOSED` se excluye.

## 4. API (resumen; detalle en `docs/api.md`)

- `POST /orders/{o}/items/{i}/tasks/{t}/status` — `PREPARING|READY`; solo el área de la tarea (o ADMIN).
- `POST /orders/{o}/items/{i}/status` — se conserva para operaciones offline antiguas: `PREPARING/READY` actúan sobre
  las tareas del área del usuario; `DELIVERED` es del plato.
- `GET /preparation/kitchen|grill` — `tasks[]` solo del área, con `other_tasks[]` y `other_areas`.
- `POST/PATCH /menu/items` — `preparation_steps` (1–12, áreas KITCHEN/GRILL, 0–600 min, orden = lista);
  `PATCH` conserva el `id` de pasos editados y audita `MENU_PREPARATION_CHANGED`.

## 5. Tiempo real, Push y offline

- `command.created`: solo a áreas con tareas (+ admin/mesero); `areas` sale de las tareas.
- `preparation_task.updated` (nuevo, solo WebSocket): progreso entre áreas; la otra área ve «Cocina terminó — …»
  sin que se anuncie el plato completo.
- `order_item.ready` (+ Push): **una vez por plato**, solo mesero dueño y admin. Antes se enviaba también a la otra
  área; ahora esa información viaja en `preparation_task.updated`. El payload Push sigue siendo genérico.
- **Un solo aviso visible por finalización.** Si la finalización de un plato completa además el pedido
  (p. ej. pedido de un solo plato), se emiten ambos eventos —para actualizar pantallas— pero `order_item.ready`
  lleva `silent: true`: el hub no programa Push para él y el cliente no muestra toast/sonido; el aviso es
  `order.ready` («Listo para entregar»). Si el pedido aún no está completo, avisa `order_item.ready`; en un pedido
  ya `PAID` (pago anticipado) el pedido nunca pasa a `READY` y avisa `order_item.ready`.
- Reconexión: `connection.ready` reconsulta todo por REST; el estado correcto no depende de haber recibido eventos.
- Cola offline: nueva operación `UPDATE_PREPARATION_TASK`. Las operaciones se reenvían en orden (marca de tiempo
  estrictamente creciente, sin empates), cada una con su UUID (`Idempotency-Key` + `client_operation_id`). Un mensaje
  repetido o atrasado es una operación nula en el servidor, no un error; un rechazo real (p. ej. plato cancelado)
  queda `SYNC_ERROR` sin bloquear las demás. Pagos siguen requiriendo conexión.

## 6. Migración `0007_preparation_tasks`

- Crea las dos tablas (con `CHECK`, índices y **RLS** como el resto) solo si no existen y rellena:
  una tarea por plato con preparación (`PREPARING→PREPARING`, `READY→READY`, `DELIVERED→READY`,
  `CANCELLED→CANCELLED`, copiando tiempos) y un paso por producto con preparación. Ambos `INSERT … WHERE NOT EXISTS`:
  re-ejecutable.
- No modifica ni borra columnas, importes, pagos ni estados (probado comparando antes/después con
  `downgrade 0006 → upgrade head`). `downgrade` solo elimina las tablas derivadas.
- Al arrancar, la API vuelve a ejecutar el relleno de tareas (idempotente, con `pg_advisory_xact_lock`) para
  cubrir platos creados por la instancia anterior mientras se desplegaba; además un plato sin tareas se repara
  perezosamente al cambiar de estado.

## 7. Despliegue seguro

1. Backup verificado de Supabase (`docs/deployment.md`). **No se ha tocado producción en este trabajo.**
2. Ensayar `alembic upgrade head` en una copia restaurada del backup.
3. **Despliegue coordinado** (backend + frontend en la misma ventana, fuera de hora pico): Render despliega ambos
   servicios con `autoDeployTrigger: checksPass`; el backend ejecuta `alembic upgrade head` en `preDeployCommand`.
   Compatibilidad durante el solape: los tableros y estados de ítem del frontend anterior siguen funcionando (se
   conservan `/items/{id}/status` e `items[]`; cada área mueve su propia parte). **No** es compatible la pantalla de
   cobro anterior: el contrato retiró `splits`, por lo que esa pantalla fallaría hasta que cargue el frontend nuevo
   (los cobros pueden registrarse mientras tanto desde la pantalla nueva o por la API). Pedir a los dispositivos
   recargar/actualizar la PWA al terminar (el service worker se actualiza con `no-cache`).
4. Antes de actualizar, que meseros/áreas sincronicen operaciones locales pendientes.
5. Verificar tras el despliegue: `SELECT count(*) FROM order_item_preparation_tasks` ≈ platos con preparación; un
   pedido de prueba con «Alitas con papas»; `alembic current` = `0007_preparation_tasks`.
6. Rollback: preferir corrección hacia adelante; si fuera imprescindible, `alembic downgrade 0006_push_device`
   elimina solo las tablas derivadas (se pierde el avance por tarea de platos aún en curso).

## 8. Riesgos y limitaciones conocidas

- Dos instancias permanentes necesitarían un broker compartido para WebSocket/Push (limitación previa; Render usa 1).
- El backend sigue aceptando pagos menores al saldo (no hay forma de hacerlo desde la interfaz); un pago mixto
  requeriría reintroducir esa opción en `BillingPage`.
- Una receta con tareas en la misma área aparece como varias tarjetas/líneas en ese tablero (por diseño).
- `bill_splits`/`bill_split_items`/`payments.split_id` permanecen hasta una decisión contable posterior (ver §2).
- Se corrigió de paso `Modal`: su efecto se re-ejecutaba en cada render y quitaba el foco al campo que se escribía
  (afectaba al formulario de producto); ahora configura el foco y el listener una sola vez.

## 9. Pruebas

Backend (PostgreSQL real, `restaurante_test`): `pytest` — 167 pruebas, incluidas `test_preparation_tasks.py`
(recetas, tableros por área, cocina/parrilla primero o simultáneo, listo una sola vez, 3 unidades, cancelaciones,
pago anticipado, receta versionada, histórico/compatibilidad, reportes, WebSocket con reconexión, Push privado,
concurrencia pago↔cancelación y tarea↔cancelación) y `test_preparation_migration.py`.
Frontend: `vitest` (tableros, cobro, editor de recetas, cola offline, notificaciones), `eslint`, `tsc`, `vite build`.
E2E Playwright (viewport móvil): flujo principal, offline, plato compartido y pago anticipado.

## 10. Guía de usuario

**Cobrar (mesero/administrador).** Abra el pedido → «💳 Cobro». Vea el consumo, el total y lo pendiente. Elija el
método (Efectivo, Yape, Plin, Tarjeta, Otro) y pulse «Cobrar S/ …». Al cubrir el total el pedido queda «Pagado».
El cobro es siempre por el saldo pendiente completo. Todos los cobros (incluidos pagos parciales anteriores) aparecen
en «Pagos realizados». Ya no hay división de cuentas.

**Crear un plato con varias áreas (administrador).** Más → Carta → «+ Producto» (o «Editar»). Ponga nombre y precio
único. En «Preparación del producto» agregue una tarea por cada trabajo: nombre (p. ej. «Preparar alitas»), área
(Cocina/Parrilla) y minutos. Use ↑ ↓ para ordenar, «Activa/Inactiva» para pausar una tarea y ✕ para quitarla.
«Entrega directa» es para bebidas u otros productos sin preparación. Los cambios valen para comandas nuevas; las
ya enviadas no cambian.

**Cocina y parrilla.** Cada área ve solo sus tareas («Preparar papas», «Preparar alitas»), con tiempo transcurrido,
tiempo estimado y el estado de la otra área. «Empezar» → «Listo». Una tarea lista muestra «Esperando a …» hasta
que el resto termina. «Cancelar plato» cancela el plato completo en todas las áreas.

**Mesero.** Recibe un único aviso cuando todas las áreas terminaron: «Plato listo — …» o, si con ese plato queda
completo el pedido, «Listo para entregar». Entonces aparece «Entregado ✓».
Mientras tanto, en el pedido ve el avance por área.

## 11. Correcciones de la auditoría independiente (migración `0008_occupancy_and_compat`)

`0007` no se modificó (ya publicada); `0008` la corrige hacia adelante. Causa raíz común: la consistencia dependía de
que el backend nuevo fuera el único escritor y de predicados distintos en cada consulta.

| Hallazgo | Causa raíz | Solución |
|---|---|---|
| I-1 relleno concurrente | `ensure_item_tasks` y el relleno no compartían exclusión y no había identidad única de la tarea derivada | `legacy_mirror` + índice único parcial `uq_prep_tasks_legacy_mirror (order_item_id) WHERE legacy_mirror`; relleno, reparación y trigger insertan con `ON CONFLICT DO NOTHING`. Las tareas reales multiárea no son espejo y no se limitan |
| I-2 escrituras antiguas | El relleno solo corría al arrancar; el tablero exige tarea | `order_items.tasks_managed` (false para escritores antiguos) + triggers: tarea espejo en `INSERT`, sincronía monótona en cambios de estado/cancelación. El backend nuevo inserta con `tasks_managed = true`. `0008` toma `LOCK … SHARE ROW EXCLUSIVE`, instala triggers y repite el relleno antes de confirmar, sin hueco |
| I-3 entrega directa pagada | El predicado de «trabajo pendiente» exigía `requires_preparation` | `pending_work_exists()`: cualquier ítem `PENDING/PREPARING/READY`; lo usan pedidos activos y cierre de turno (los tableros siguen filtrando por tareas) |
| I-4 mesa liberada | Ocupación y unicidad dependían solo del estado (`PAID` ⇒ libre) | `orders.occupies_table` derivado por trigger (estado + ítems sin entregar) para cualquier escritor; `/tables`, alta de pedido y el índice único `uq_orders_occupied_dine_in_table` usan la misma columna. Un segundo pedido es rechazado por la BD (409 `TABLE_ALREADY_OPEN`) |
| I-5 pedido todo cancelado | `compute_status` devolvía `OPEN` sin ítems activos | Nuevo estado terminal `CANCELLED` (con ítems, todos cancelados, sin pagos): fija `closed_at`, audita `ORDER_CANCELLED`, libera mesa, no bloquea el turno, rechaza pagos/comandas (409 `ORDER_ALREADY_CANCELLED`) y no cuenta como atendido en reportes. Un pedido vacío sigue `OPEN`; `TOTAL_BELOW_PAID` impide que un pedido con pagos se cancele |
| M-1 edición de cantidad/notas | `PATCH …/items/{id}` no publicaba eventos | Emite `order_item.updated` (áreas del plato + mesero + admin) y `order.updated` |

Notas: `0008` no reescribe importes, pagos ni estados; si hubiera varios pedidos ocupando una misma mesa (datos previos),
conserva como ocupante al más reciente en lugar de abortar el despliegue.

### Procedimiento de despliegue coordinado

1. Backup verificado y ensayo de `alembic upgrade head` sobre una copia restaurada (nunca sobre producción).
2. Render ejecuta `alembic upgrade head` (0007 y 0008 en la misma transacción). Durante el solape, la instancia
   anterior sigue escribiendo: los triggers le dan tarea espejo, ocupación de mesa y sincronía de estado, de modo que sus
   comandas son visibles en los tableros nuevos. Aun así, **recomendado**: pausar el servicio anterior (o ventana sin
   tráfico) y confirmar tras el arranque del nuevo: `SELECT count(*) FROM order_items oi WHERE requires_preparation AND
   status IN ('PENDING','PREPARING','READY') AND NOT EXISTS (SELECT 1 FROM order_item_preparation_tasks t WHERE
   t.order_item_id = oi.id)` = 0.
3. Desplegar el frontend en la misma ventana; recargar la PWA.
4. Riesgo residual: un bloqueo cruzado breve entre una transacción antigua y una nueva puede abortar una operación
   (PostgreSQL detecta el deadlock; el cliente reintenta).

