# Testing

Cuatro niveles: tests de backend (pytest), tests unitarios de frontend (Vitest),
estáticos (TypeScript + ESLint) y E2E (Playwright).

## 1. Comandos

```bash
# ── Backend ────────────────────────────────────────────────
cd backend
.venv/bin/python -m ruff check .        # lint
.venv/bin/python -m pytest -ra          # esquema creado por Alembic en :5433/restaurante_test

# ── Frontend ──────────────────────────────────────────────
cd frontend
npx tsc --noEmit                        # tipos
npx eslint .                            # lint
npx vitest run                          # incluye pagos perdidos y aislamiento de cola por usuario
npm run build                           # tsc + vite build (incluye el service worker)

# ── E2E ───────────────────────────────────────────────────
cd frontend
npx playwright test                     # §73 + §74
npx playwright test e2e/flow.spec.ts    # solo flujo principal
npx playwright test e2e/offline.spec.ts # solo offline
```

Prerrequisitos: `docker compose up -d db db-test`, dependencias instaladas y Chromium
(`cd frontend && npx playwright install chromium`). Los fixtures aplican migraciones y siembran
los datos automáticamente. Para E2E cree también `restaurante_e2e_test` en el contenedor de test:

```bash
docker compose exec -T db-test createdb -U restaurante restaurante_e2e_test
```

Este comando sólo se necesita si la base E2E aún no existe. Backend y E2E usan bases distintas.

## 2. Backend (§71)

| Archivo | Cubre |
|---|---|
| `tests/test_auth.py` | login, PIN, JWT/refresh, roles (RBAC), rate limit de login |
| `tests/test_menu_tables.py` | categorías, productos, disponibilidad, mesas, permisos |
| `tests/test_orders.py` | creación de pedido/comanda, transiciones de ítem, cancelaciones, idempotencia, eventos/estados |
| `tests/test_billing.py` | división por ítems/monto, pagos, saldos, comprobantes |
| `tests/test_shifts_reports.py` | turno abierto/cerrado, bloqueo con pedidos abiertos, snapshot, reportes |
| `tests/test_e2e.py` | escenario completo de negocio en backend (§73 a nivel API) |
| `tests/test_production.py` | concordancia de migraciones, RLS, sesiones revocadas, aislamiento idempotente, comprobantes privados, importes y configuración segura |
| `tests/test_concurrency.py` | concurrencia PostgreSQL real: comandas, pagos, mesas y turnos |

Cómo funcionan: `conftest.py` fuerza `DATABASE_ENV=test`, valida `TEST_DATABASE_URL` y ejecuta
`alembic upgrade head`, trunca sólo la base dedicada y siembra usuarios, mesas y carta de test.
No usa `create_all`. `alembic check` y la prueba de metadata impiden omitir una migración.
Los uploads de pruebas se aíslan en directorios temporales. La suite conserva el esquema al terminar.

Cobertura mínima exigida por el speac: estados, transiciones, permisos, idempotencia,
turnos, reportes y errores `{error:{code,message,details}}`.

## 3. Frontend unitario (§72)

| Archivo | Cubre |
|---|---|
| `src/pages/LoginPage.test.tsx` | login: usuario, teclado PIN, manejo de error |
| `src/offline/queue.test.ts` | cola: `LOCAL_PENDING`, sync + `server_resource_id`, backoff en fallo de red, `SYNC_ERROR` ante 4xx, dependencia pedido→comanda, notificación de cambios |
| `src/components/SyncIndicator.test.tsx` | estados visuales de la cola (🟠🔵🟢🔴) |
| `src/hooks/useElapsed.test.ts` | cronómetros y formato de dinero/tiempos |
| `src/pages/BillingPage.test.tsx` | respuesta de pago perdida, recarga y verificación del mismo UUID con saldo cero |
| `src/api/client.test.ts` | límite de reintento de renovación del token |

Entorno `jsdom` con `fake-indexeddb` (`src/test/setup.ts`).

## 4. Estáticos

```bash
npx tsc --noEmit   # sin errores de tipo
npx eslint .       # sin warnings ni errores
cd backend && .venv/bin/python -m ruff check .
```

## 5. E2E (§73 / §74)

Configuración: `frontend/playwright.config.ts`

- `testDir: e2e`, un worker, sin reintentos, viewport móvil 390×844.
- `webServer` construye la PWA y arranca `vite preview` (:5174) y `uvicorn` (:8010).
  No reutiliza servidores existentes. Los puertos se pueden cambiar con `E2E_APP_PORT` / `E2E_API_PORT`.
- `globalSetup` aplica migraciones, exige `alembic check`, siembra datos y resetea exclusivamente
  `restaurante_e2e_test` (o `TEST_DATABASE_URL` explícita con nombre test/e2e).
- El flujo principal usa viewport móvil de 390×844. El offline simula pérdida real de red del navegador.

| Escenario | Archivo | Pasos clave |
|---|---|---|
| §73 flujo principal | `e2e/flow.spec.ts` | admin abre turno → mesero abre Mesa 4 (3 personas) → agrega producto de cocina, de parrilla y bebida → envía comanda → cocina y parrilla ven solo su parte → ambos `Empezar`/`Listo` → mesero recibe aviso → entrega → admin divide la cuenta → registra pago → cierra turno → el reporte contiene la venta (≥ 36) |
| §74 offline | `e2e/offline.spec.ts` | mesero se desconecta (`setOffline(true)`) → envía comanda → estado `LOCAL_PENDING` ("por enviar") → cocina no recibe nada → se reconecta → la cola sincroniza → cocina recibe **exactamente una** comanda → reenvío manual con la misma `Idempotency-Key` devuelve 201 idéntico y el pedido sigue con 2 comandas |

Helpers: `e2e/helpers.ts` (`login`, `ensureShiftOpen`, `clickAll`).

Salida esperada:

```text
2 passed
```
