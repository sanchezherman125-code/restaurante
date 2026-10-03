# Testing

Cuatro niveles: tests de backend (pytest), tests unitarios de frontend (Vitest),
estáticos (TypeScript + ESLint) y E2E (Playwright).

## 1. Comandos

```bash
# ── Backend ────────────────────────────────────────────────
cd backend
.venv/bin/python -m ruff check .        # lint
.venv/bin/python -m pytest              # 59 tests (usa :5433/restaurante_test)

# ── Frontend ──────────────────────────────────────────────
cd frontend
npx tsc --noEmit                        # tipos
npx eslint .                            # lint
npx vitest run                          # 15 tests unitarios
npm run build                           # tsc + vite build (incluye el service worker)

# ── E2E ───────────────────────────────────────────────────
cd frontend
npx playwright test                     # §73 + §74
npx playwright test e2e/flow.spec.ts    # solo flujo principal
npx playwright test e2e/offline.spec.ts # solo offline
```

Prerrequisitos para todo: `docker compose up -d db db-test` levantado y backend migrado
(`alembic upgrade head` + `python -m scripts.seed`).

## 2. Backend (§71)

| Archivo | Cubre |
|---|---|
| `tests/test_auth.py` | login, PIN, JWT/refresh, roles (RBAC), rate limit de login |
| `tests/test_menu_tables.py` | categorías, productos, disponibilidad, mesas, permisos |
| `tests/test_orders.py` | creación de pedido/comanda, transiciones de ítem, cancelaciones, idempotencia, eventos/estados |
| `tests/test_billing.py` | división por ítems/monto, pagos, saldos, comprobantes |
| `tests/test_shifts_reports.py` | turno abierto/cerrado, bloqueo con pedidos abiertos, snapshot, reportes |
| `tests/test_e2e.py` | escenario completo de negocio en backend (§73 a nivel API) |

Cómo funcionan: `conftest.py` apunta `DATABASE_URL` a `restaurante_test`, crea el esquema con
`Base.metadata.create_all`, trunca las tablas de operación entre tests y siembra usuarios,
mesas y carta propios de test.

Cobertura mínima exigida por el speac: estados, transiciones, permisos, idempotencia,
turnos, reportes y errores `{error:{code,message,details}}`.

## 3. Frontend unitario (§72)

| Archivo | Cubre |
|---|---|
| `src/pages/LoginPage.test.tsx` | login: usuario, teclado PIN, manejo de error |
| `src/offline/queue.test.ts` | cola: `LOCAL_PENDING`, sync + `server_resource_id`, backoff en fallo de red, `SYNC_ERROR` ante 4xx, dependencia pedido→comanda, notificación de cambios |
| `src/components/SyncIndicator.test.tsx` | estados visuales de la cola (🟠🔵🟢🔴) |
| `src/hooks/useElapsed.test.ts` | cronómetros y formato de dinero/tiempos |

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
- `webServer` arranca `vite` (:5173) y `uvicorn` (:8000) si no están corriendo.
- `globalSetup` ejecuta `python -m scripts.reset_db` para partir de datos limpios.

| Escenario | Archivo | Pasos clave |
|---|---|---|
| §73 flujo principal | `e2e/flow.spec.ts` | admin abre turno → mesero abre Mesa 4 (3 personas) → agrega producto de cocina, de parrilla y bebida → envía comanda → cocina y parrilla ven solo su parte → ambos `Empezar`/`Listo` → mesero recibe aviso → entrega → admin divide la cuenta → registra pago → cierra turno → el reporte contiene la venta (≥ 36) |
| §74 offline | `e2e/offline.spec.ts` | mesero se desconecta (`setOffline(true)`) → envía comanda → estado `LOCAL_PENDING` ("por enviar") → cocina no recibe nada → se reconecta → la cola sincroniza → cocina recibe **exactamente una** comanda → reenvío manual con la misma `Idempotency-Key` devuelve 201 idéntico y el pedido sigue con 2 comandas |

Helpers: `e2e/helpers.ts` (`login`, `ensureShiftOpen`, `clickAll`).

Salida esperada:

```text
2 passed
```
