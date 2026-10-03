# Base de datos

PostgreSQL 16, SQLAlchemy 2 y Alembic.

- Desarrollo: `docker compose up -d db` → `localhost:5432/restaurante`.
- Tests: `db-test` → `localhost:5433/restaurante_test` (las suites crean y limpian los datos
  de operación en cada ejecución).

Migración única: `backend/alembic/versions/0001_initial.py`.

```bash
cd backend
.venv/bin/alembic upgrade head          # aplicar
.venv/bin/alembic current               # versión actual
.venv/bin/alembic revision --autogenerate -m "cambio"   # nueva migración
```

## 1. Tablas

### Identidad y acceso

| Tabla | Columnas clave | Notas |
|---|---|---|
| `users` | `username`, `pin_hash` (Argon2id), `display_name`, `role`, `is_active` | roles `WAITER/KITCHEN/GRILL/ADMIN` |

### Catálogo

| Tabla | Columnas clave | Notas |
|---|---|---|
| `menu_categories` | `name`, `sort_order`, `is_active` | orden de la carta |
| `menu_items` | `category_id`, `name`, `price` (numeric 12,2), `preparation_area`, `expected_prep_minutes`, `is_available`, `is_active` | `preparation_area`: `KITCHEN/GRILL/WAITER` |
| `restaurant_tables` | `name`, `number`, `is_active` | `name` = "Mesa 4" |

### Operación

| Tabla | Columnas clave | Notas |
|---|---|---|
| `shifts` | `opened_at/by`, `closed_at/by`, `status`, `snapshot` | `snapshot` congela el resumen al cerrar (§35) |
| `orders` | `shift_id`, `table_id`, `order_type`, `persons_count`, `created_by_waiter_id`, `status`, `subtotal`, `total`, `paid_amount`, `opened_at/paid_at/closed_at` | estados §10 |
| `commands` | `order_id`, `sequence_number` (único por pedido), `created_by_user_id`, `client_operation_id` | comanda enviada a preparación |
| `order_items` | `command_id`, `order_id`, `menu_item_id`, `menu_item_name_snapshot`, `unit_price_snapshot`, `quantity`, `preparation_area`, `status`, `expected_prep_minutes_snapshot`, `preparation_started_at`, `ready_at`, `delivered_at`, `cancelled_*` | snapshots congelan precio/nombre/tiempo |

Relaciones `lazy="selectin"` en `orders` (`items`, `commands`, `payments`) para cargar el
pedido completo en una sola consulta.

### Cobro

| Tabla | Columnas clave | Notas |
|---|---|---|
| `bill_splits` | `order_id`, `split_type` (`BY_ITEMS`/`BY_AMOUNT`), `label`, `amount`, `created_by_user_id` | división de cuenta (§30) |
| `bill_split_items` | `split_id`, `order_item_id`, `quantity`, `amount` | reparto por ítems |
| `payments` | `order_id`, `split_id?`, `method`, `amount`, `paid_by_user_id`, `paid_at` | pago parcial o total (§31) |

### Gastos, compras y soporte

| Tabla | Columnas clave |
|---|---|
| `expenses` | `shift_id`, `created_by_user_id`, `amount`, `description`, `receipt_url` |
| `purchase_list_items` | `shift_id`, `area`, `description`, `quantity_text` |
| `push_subscriptions` | `user_id`, `endpoint`, `keys` |
| `idempotency_keys` | `key`, `user_id`, `operation_type`, `response_status`, `response_body` (única por combinación) |
| `audit_logs` | `user_id`, `action`, `entity_type`, `entity_id`, `before_data`, `after_data`, `device_id` |

## 2. Reglas de integridad y negocio

- **Dinero:** `Numeric(12, 2)` y `Decimal` en Python; nunca `float` (§69).
- **Snapshots en `order_items`:** precio, nombre y tiempo de preparación se copian al crear el
  ítem; cambiar la carta no altera pedidos en curso.
- **Estados:** validados en la capa de servicio (`ALLOWED_TRANSITIONS`), no con triggers, para
  que los errores devuelvan `{error: {code, message}}` coherente con la API.
- **Pedido "listo":** todos los ítems de área `KITCHEN`/`GRILL` no cancelados en `READY`/`DELIVERED`.
- **Cierre de turno:** bloqueado si quedan pedidos no cerrados (`SHIFT_HAS_OPEN_ORDERS`).
- **Auditoría:** acciones críticas insertadas en `audit_logs` dentro de la misma transacción
  que el cambio.
- **Idempotencia:** `execute_idempotent` guarda la respuesta dentro de la misma transacción que
  la operación; si la clave ya existe, devuelve la respuesta guardada.

## 3. Transacciones (§68)

- Cada endpoint = una transacción: éxito → `commit`; error → rollback y respuesta de error.
- Las escrituras relacionadas (pedido + comandas + ítems + auditoría) se hacen en la misma
  sesión; los cambios de estado de ítems hacen `flush()` antes de emitir los eventos WebSocket
  para que los receptores siempre vean el estado ya confirmado por la transacción.

## 4. Datos iniciales

`python -m scripts.seed` crea:

- usuarios: `admin`, `mesero1`, `mesero2`, `cocina1`, `parrilla1` (PIN `1234`);
- 10 mesas;
- categorías `Entradas`, `Fondos`, `Bebidas`, `Postres` y 12 productos de ejemplo con sus áreas.

`python -m scripts.reset_db` elimina datos de operación (pedidos, comandas, ítems, pagos,
turnos, gastos, compras, auditoría, idempotencia) y repone la disponibilidad de la carta,
conservando usuarios, mesas y carta.

## 5. Copias (§79)

En piloto: backup semanal de la instancia (Supabase → point-in-time recovery o dump `pg_dump`),
documentando el procedimiento de restauración; antes de producción real, backup diario.
