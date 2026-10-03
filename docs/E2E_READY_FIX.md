# E2E READY FIX

Fecha: 2026-10-03.

## Causa raíz

El fallo de `flow.spec.ts` no era una transición incompleta de `PENDING → PREPARING → READY`. Playwright reiniciaba `restaurante_e2e_test`, pero por `reuseExistingServer` conectaba Vite al Uvicorn ya activo en `localhost:8000`, que estaba configurado contra desarrollo. El mesero quedaba sin conexión WebSocket y su consulta REST no observaba los cambios realizados en el proceso/base de datos distinto.

## Punto de ruptura

- KITCHEN y GRILL aceptaban sus transiciones, pero lo hacían en el backend reutilizado.
- El WebSocket del mesero se cerraba (`EPIPE` en el proxy) y React no recibía `order.ready`.
- PostgreSQL E2E no contenía ese pedido: el reset y el backend no usaban la misma fuente de verdad.

## Corrección

- Los E2E usan por defecto los puertos exclusivos `5174`/`8010` y no reutilizan servidores existentes.
- `globalSetup` ejecuta Alembic, seed y reset sólo con `DATABASE_ENV=test` y `TEST_DATABASE_URL` cuyo nombre contiene `test` o `e2e`; el reset backend repite esa guarda.
- La migración `0003_direct_delivery_items` añade `requires_preparation` y permite `preparation_area = NULL` para entrega directa. Bebidas activas y productos cancelados no bloquean `READY`.
- `order.ready` se emite al cambiar el estado persistido del pedido a `READY`, incluyendo la ruta de cancelación. REST/PostgreSQL siguen siendo la fuente de verdad y el cliente invalida sus consultas al recibir el evento.

## Evidencia

- Antes: la captura E2E mostraba `Mesa 4 · OPEN`, items aún `PENDING` y el mesero `Sin conexión`.
- Después: `flow.spec.ts` pasó contra `restaurante_e2e_test`; el pedido final quedó `PAID` por S/ 36.00 y los items de cocina, parrilla y entrega directa terminaron `DELIVERED`.
- La regresión backend verifica una bebida directa pendiente y un item cancelado mientras el único item de cocina llega a `READY`; el pedido queda `READY`.

## Archivos principales

- `frontend/playwright.config.ts`, `frontend/e2e/global-setup.ts`
- `backend/app/config.py`, `backend/app/db.py`, `backend/scripts/reset_db.py`
- `backend/alembic/versions/0003_direct_delivery_items.py`
- `backend/app/services/orders.py`, `backend/app/api/preparation.py`, `backend/app/api/orders.py`
- `backend/app/models/catalog.py`, `backend/app/models/orders.py`
