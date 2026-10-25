# Sincronización offline (V1)

Objetivo (§18–§23 del speac): el mesero puede preparar y enviar una comanda **sin conexión**;
al reconectar, la cola reintenta y el backend crea **exactamente un** recurso, nunca duplicados.

## 1. Qué se puede hacer sin red (§20)

| Operación | Endpoint | En cola offline |
|---|---|---|
| `OPEN_TABLE_WITH_COMMAND` | `POST /api/v1/orders/open-with-command` | ✅ (primera comanda: pedido + comanda atómicos; las siguientes comandas se encadenan a esta operación) |
| `CREATE_ORDER` | `POST /api/v1/orders` | ✅ (ya no lo usa el salón) |
| `ADD_ORDER_ITEM` | `POST /api/v1/orders/{id}/items` | ✅ |
| `CREATE_COMMAND` | `POST /api/v1/orders/{id}/commands` | ✅ |
| `CANCEL_ORDER_ITEM` | `POST /api/v1/orders/{id}/items/{id}/cancel` | ✅ |
| `UPDATE_ORDER_ITEM_STATUS` | `POST /api/v1/orders/{id}/items/{id}/status` | ✅ (entrega del plato; operaciones antiguas) |
| `UPDATE_PREPARATION_TASK` | `POST /api/v1/orders/{id}/items/{id}/tasks/{task}/status` | ✅ |
| `REGISTER_EXPENSE` | `POST /api/v1/expenses` | ✅ |
| Pagos | `POST .../payments` | ❌ requieren conexión |
| Login / refresco de token | `/api/v1/auth/*` | ❌ |

## 2. Estados de sincronización (§19)

| Estado | Emoji | Significado |
|---|---|---|
| `LOCAL_PENDING` | 🟠 | guardada en el dispositivo, aún no enviada |
| `SENDING` | 🔵 | en vuelo (protege contra doble envío por reentrancia) |
| `SYNCED` | 🟢 | el servidor la confirmó; se guarda `server_resource_id` |
| `SYNC_ERROR` | 🔴 | el servidor respondió 4xx; requiere intervención (descartar/reintentar) |

Los estados se muestran en el indicador de sincronización (`.conn` + `[data-testid="sync-indicator"]`)
del layout, y el detalle de cada operación en la cola.

## 3. Almacenamiento

- Base IndexedDB: `restaurante-offline`, store `queue` (`src/offline/queue-db.ts`).
- Índice por `created_at` para respetar el orden de envío y `by_status` para listar pendientes.
- Registro de operación (`QueuedOperation`):

```json
{
  "client_operation_id": "uuid",
  "owner_user_id": "uuid-del-usuario",
  "operation_type": "CREATE_COMMAND",
  "path": "/api/v1/orders/{orderRef}/commands",
  "method": "POST",
  "body": { "items": [ … ] },
  "parent_operation_id": "uuid-del-pedido",
  "created_at": 1730000000000,
  "attempt_count": 1,
  "last_attempt_at": 1730000001000,
  "status": "LOCAL_PENDING",
  "last_error": null,
  "server_resource_id": null
}
```

- `sendOrQueue` persiste la operación y el UUID antes de la petición inicial. Ante fallo de red
  o error 5xx de resultado incierto, conserva el mismo UUID para reintentar. Un 4xx directo
  se muestra como error. El sincronizador sólo envía operaciones del usuario que las creó.
- Los pedidos creados offline se guardan también en `stores/pendingOrders.ts` para poder
  mostrar la mesa y sus ítems hasta que el servidor devuelva el id real.

## 4. Resolución de dependencias

Una comanda sin pedido todavía sincronizado usa la plantilla de ruta `…/orders/{orderRef}/…`
y `parent_operation_id`. El sincronizador:

1. Ordena las operaciones por profundidad de dependencia (padre antes que hijo).
2. Si el padre aún está `LOCAL_PENDING`/`SENDING` → hijo diferido (`deferred`).
3. Si el padre termina en `SYNC_ERROR` → hijo marcado `SYNC_ERROR` con mensaje
   *"No se envió porque el pedido que lo originó falló"*.
4. Si el padre está `SYNCED` → se sustituye `{orderRef}` por `server_resource_id`.

Así, al reconectar, la cola envía primero el pedido, guarda su id y luego la comanda con ese id.

## 5. Reintentos (§21)

- `flushQueue()` procesa la cola en orden; cada operación se marca `SENDING` antes de salir.
- Fallo de red → vuelve a `LOCAL_PENDING`, `networkFailure = true` y **backoff exponencial**
  1 s → 2 s → … → 60 s (máximo). Con backoff activo no se reintenta.
- Los errores 5xx también se reintentan con la misma identidad. El backoff se conserva
  tras recarga y el temporizador se vuelve a programar según el estado actual.
- Respuesta 4xx → `SYNC_ERROR` con `code: mensaje` y se continúa con la siguiente operación.
- Éxito → `SYNCED` + `resetBackoff()`.
- El flush se relanza automáticamente: al recuperar la conexión (`online`), al detectar
  un cambio en la cola y con un temporizador de respaldo (`startQueueSync`).
- Reintento manual desde la UI: `retryOperation()` (limpia el backoff) o `discardOperation()`.
- El indicador de errores abre el detalle con acciones de reintentar o descartar con confirmación.
  El cierre de sesión se bloquea mientras el usuario tenga operaciones sin resolver.
  Las operaciones antiguas sin propietario se marcan para revisión y no se envían automáticamente.
- Un pago con respuesta perdida se conserva aparte con UUID y monto originales, requiere conexión
  y se verifica con el botón «Verificar pago pendiente». Nunca se convierte en pago offline nuevo.

## 6. Idempotencia (§22)

Cada operación lleva `Idempotency-Key` = `client_operation_id` y, en los endpoints que lo
admiten, el mismo valor en el body. El backend responde con la respuesta almacenada en la
primera ejecución, de modo que:

```text
1 operación cliente  =  1 operación servidor   (nunca duplicados)
```

Comprobado por el E2E §74 (`frontend/e2e/offline.spec.ts`): reenviar a mano la misma operación
devuelve 201 con el mismo cuerpo y el pedido sigue teniendo exactamente dos comandas.

## 7. Conflictos (§23)

V1 es simple y determinista:

- Si el servidor rechaza la operación (409/422) la operación queda en `SYNC_ERROR` y se
  muestra al usuario para que la descarte o la corrija; nunca se reescribe en silencio.
- Las operaciones se aplican en orden de creación; el estado del servidor es la fuente de verdad
  y la UI se refresca con los eventos WebSocket + invalidación de queries.

## 8. Recuperación tras reconexión (§17)

Además de la cola, el cliente:

- se reconecta al WebSocket con backoff (1 s → 30 s) y mantiene ping cada 25 s;
- al reabrir la conexión invalida **todas** las queries (`resync()`), lo que refresca mesas,
  pedidos, tableros y reportes sin recargar la página.

## 9. Recarga sin conexión y sesión

- **Sesión.** Al iniciar, `restore()` consulta `/auth/me`. Un fallo de red o un 5xx **no** borra
  tokens ni identidad: se conserva el usuario guardado solo si coincide con el `sub` del token local
  (`unverified: true`) y se revalida con el servidor al volver la conexión (evento `online`). Solo un
  rechazo real (401 tras intentar renovar, 403) limpia la sesión. Renovar el token sin red devuelve
  `NetworkError` y no cierra la sesión.
- **Sesión expirada en la cola.** Si al sincronizar el servidor rechaza las credenciales, la operación
  vuelve a `LOCAL_PENDING` con el mismo UUID (no pasa a `SYNC_ERROR`) y la interfaz vuelve al ingreso;
  al ingresar de nuevo el mismo usuario, la cola continúa.
- **Datos locales.** `src/offline/queryCache.ts` guarda en `localStorage` (clave
  `restaurante.queryCache.<usuario>`) solo mesas, carta, pedidos activos, turno, tableros y gastos, con
  vigencia de 24 h. Se restaura antes del primer render y se borra al cerrar sesión, al expirar la
  sesión o al cambiar de usuario. Nunca contiene credenciales. Sin red, una consulta fallida conserva
  la última copia y la pantalla la sigue mostrando.
- **Rutas.** El service worker sirve `index.html` para cualquier navegación, así que `/mesas/:id`
  se recupera al recargar.

## 10. Mesa con comanda local

Cada mesa distingue cuatro situaciones:

| Situación | Dónde vive | Interfaz |
|---|---|---|
| Borrador local (abierta, sin comanda) | `tableDrafts` (sessionStorage) | «Sin pedido» |
| Pendiente de sincronización | cola + `pendingOrders` | «Sin enviar»: la mesa se puede abrir y muestra las líneas en cola |
| Confirmado en el servidor | `orders/active` | «Ocupada» |
| Error o conflicto | operación `SYNC_ERROR` | «No enviada»: muestra el error y permite reintentar o descartar |

Entrar a una mesa con comanda local nunca vuelve a abrirla: las comandas siguientes se encadenan a la
misma operación padre. Las cancelaciones y entregas en cola se marcan «pendiente de envío» en el plato
y no se anuncian como hechas; si el servidor ya muestra el plato cancelado o entregado, manda el servidor.
Cuando la cola confirma operaciones, la aplicación invalida pedidos, mesas, tableros, gastos y reportes.

## 11. Turno de origen y lecturas por usuario

- Gasto, primera comanda y comandas encoladas llevan `shift_id` (turno abierto conocido al generarlas;
  una comanda encadenada hereda el de su operación padre, y una comanda sobre un pedido, el del pedido).
  Si al sincronizar ese turno ya terminó, el servidor responde 409 `SHIFT_MISMATCH`: la operación queda
  en `SYNC_ERROR` con su UUID para revisarla o descartarla. Nunca se crea en el turno siguiente.
  Sin turno abierto conocido, no se genera ni gasto ni primera comanda.
- Cada lectura de la cola (`stores/queue.ts`) registra usuario y generación de sesión al empezar. Si al
  terminar ya no coinciden, se descarta. La reconciliación de `pendingOrders` solo elimina un registro con
  una lectura completa del usuario actual (`ownerId`), iniciada después de crear el registro.
- `flushQueue` envía en nombre de un único usuario: se detiene si la sesión o el `sub` del token cambian
  durante el recorrido, y la operación interrumpida vuelve intacta a `LOCAL_PENDING`. La identidad viaja
  con toda petición autenticada: `apiRequest` toma por defecto el `sub` del token guardado al iniciarla
  (la cola lo indica explícitamente con `owner`), así que cubre también el envío inmediato de
  `sendOrQueue`. Este fija el dueño al crear la operación, vuelve a comprobarlo después de guardarla en
IndexedDB (si mientras tanto ingresó otro usuario, no envía nada) y liga la petición de `exec` a ese
dueño con `withRequestOwner`. Ante `OwnerChangedError` conserva la operación pendiente para su dueño con
el mismo UUID: antes de enviar, al recibir un 401 y antes del reintento
  se comprueba que el token guardado siga siendo del dueño. Si cambió, no se renueva con las credenciales
  del otro usuario, no se reintenta, no se invalida su sesión y la operación vuelve a su dueño
  (`OwnerChangedError`). Una renovación nunca reemplaza tokens que otra sesión guardó mientras tanto.
- **Cola de una versión anterior.** Un gasto, una apertura de pedido o una primera comanda sin `shift_id`
  (guardados por una versión anterior) no se envían automáticamente: quedan en `SYNC_ERROR` con
  `LEGACY_WITHOUT_SHIFT`, conservados con su UUID para conciliarlos (descartar o volver a registrar). Las
  comandas encadenadas a una de ellas quedan igual. Las operaciones sobre un pedido existente sí se envían,
  porque el servidor valida el turno de ese pedido.
- La copia local de consultas (`offline/queryCache.ts`) guarda la última respuesta válida de cada
  consulta, aunque su último intento haya fallado, y fusiona con lo ya guardado: ni un error ni que React
  Query descarte una consulta sin uso la borran. La vigencia (24 h) se cuenta por respuesta. Al reconectar,
  los datos restaurados están vencidos y se vuelven a pedir.

## 12. Restricción conocida (§86)

El offline V1 está pensado para el **salón** (mesas y comandas). Si la operación depende de un
recurso que no existe localmente (por ejemplo, cobrar sin conexión o una mesa creada en otro
dispositivo), el usuario debe esperar a recuperar red; la cola no intenta resolver conflictos
de datos en el cliente.
