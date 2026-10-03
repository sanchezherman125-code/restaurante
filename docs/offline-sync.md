# Sincronización offline (V1)

Objetivo (§18–§23 del speac): el mesero puede preparar y enviar una comanda **sin conexión**;
al reconectar, la cola reintenta y el backend crea **exactamente un** recurso, nunca duplicados.

## 1. Qué se puede hacer sin red (§20)

| Operación | Endpoint | En cola offline |
|---|---|---|
| `CREATE_ORDER` | `POST /api/v1/orders` | ✅ |
| `ADD_ORDER_ITEM` | `POST /api/v1/orders/{id}/items` | ✅ |
| `CREATE_COMMAND` | `POST /api/v1/orders/{id}/commands` | ✅ |
| `CANCEL_ORDER_ITEM` | `POST /api/v1/orders/{id}/items/{id}/cancel` | ✅ |
| `UPDATE_ORDER_ITEM_STATUS` | `POST /api/v1/orders/{id}/items/{id}/status` | ✅ |
| `REGISTER_EXPENSE` | `POST /api/v1/expenses` | ✅ |
| Pagos y divisiones de cuenta | `POST .../payments`, `.../splits` | ❌ requieren conexión |
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

- Base IndexedDB: `restaurante-offline`, store `operations` (`src/offline/queue-db.ts`).
- Índice por `created_at` para respetar el orden de envío y `by_status` para listar pendientes.
- Registro de operación (`QueuedOperation`):

```json
{
  "client_operation_id": "uuid",
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

- La función `sendOrQueue` (`src/lib/send.ts`) intenta la petición normal y, **solo si falla la
  red** (`NetworkError`), encola la operación. Un 4xx nunca se encola: se muestra el error.
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
- Respuesta 4xx → `SYNC_ERROR` con `code: mensaje` y se continúa con la siguiente operación.
- Éxito → `SYNCED` + `resetBackoff()`.
- El flush se relanza automáticamente: al recuperar la conexión (`online`), al detectar
  un cambio en la cola y con un temporizador de respaldo (`startQueueSync`).
- Reintento manual desde la UI: `retryOperation()` (limpia el backoff) o `discardOperation()`.

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

## 9. Restricción conocida (§86)

El offline V1 está pensado para el **salón** (mesas y comandas). Si la operación depende de un
recurso que no existe localmente (por ejemplo, cobrar sin conexión o una mesa creada en otro
dispositivo), el usuario debe esperar a recuperar red; la cola no intenta resolver conflictos
de datos en el cliente.
