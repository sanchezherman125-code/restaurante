# Restaurante — Gestión de Pedidos (V1)

Sistema de pedidos para restaurante con cuatro roles (**mesero**, **cocina**, **parrilla**, **dueño/admin**),
tiempo real por WebSocket y modo offline V1 (cola de sincronización con idempotencia).

- **Frontend:** React 19 + TypeScript + Vite + PWA (service worker, manifest, IndexedDB).
- **Backend:** FastAPI + SQLAlchemy + Alembic + PostgreSQL.
- **Tests:** pytest (backend), Vitest (frontend), Playwright (E2E).

Especificación completa: [`speac`](./speac). Documentación técnica: [`docs/`](./docs).

---

## 1. Requisitos

| Requisito | Versión mínima |
|---|---|
| Python | 3.12 |
| Node.js | 20 |
| Docker + Docker Compose | cualquiera con `compose v2` |
| Git | cualquiera |

## 2. Levantar desde cero

### 2.1. PostgreSQL (Docker)

```bash
docker compose up -d db db-test
```

- `db` → `localhost:5432` (base `restaurante`, datos de desarrollo).
- `db-test` → `localhost:5433` (base `restaurante_test`, usada por los tests).

### 2.2. Variables de entorno

```bash
cp .env.example backend/.env
```

En desarrollo los valores por defecto ya apuntan a Docker; revise `backend/.env`
(defina siempre un `JWT_SECRET` distinto en producción).

### 2.3. Backend

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -r requirements-dev.txt

# migraciones
.venv/bin/alembic upgrade head

# datos iniciales: usuarios, mesas, categorías y carta
.venv/bin/python -m scripts.seed

# servidor
.venv/bin/uvicorn app.main:app --port 8000
```

Verificar: `curl http://localhost:8000/health` → `{"status":"ok",...}`.

### 2.4. Frontend

```bash
cd frontend
npm install
npm run dev          # http://localhost:5173 (proxy /api y ws → :8000)
```

Para producción:

```bash
npm run build        # tsc + vite build → frontend/dist
npm run preview      # sirve el build en :4173
```

### 2.5. Cuentas iniciales (seed)

| Usuario | PIN | Rol |
|---|---|---|
| `admin` | `1234` | ADMIN (dueño) |
| `mesero1` | `1234` | WAITER |
| `mesero2` | `1234` | WAITER |
| `cocina1` | `1234` | KITCHEN |
| `parrilla1` | `1234` | GRILL |

### 2.6. Reinicio rápido de datos de operación

Borra pedidos/turnos/gastos/pagos y repone la disponibilidad de la carta
(conserva usuarios, mesas y carta):

```bash
cd backend && .venv/bin/python -m scripts.reset_db
```

## 3. Tests

```bash
# backend (usa la base db-test en :5433)
cd backend
.venv/bin/python -m ruff check .
.venv/bin/python -m pytest

# frontend unit (Vitest)
cd frontend && npx vitest run

# frontend estáticos
cd frontend && npx tsc --noEmit && npx eslint .

# E2E (Playwright: levanta vite + uvicorn y resetea la BD al iniciar)
cd frontend && npx playwright test
```

Detalle y alcance en [`docs/testing.md`](./docs/testing.md).

## 4. Estructura

```text
restaurante/
├── speac                    # especificación técnica V1
├── docker-compose.yml       # Postgres dev + test
├── .env.example
├── backend/
│   ├── app/
│   │   ├── api/             # routers REST + WS
│   │   ├── core/            # seguridad (JWT, Argon2id, rate limit)
│   │   ├── models/          # modelos SQLAlchemy
│   │   ├── schemas/         # schemas Pydantic
│   │   ├── services/        # lógica de negocio
│   │   └── ws/              # hub de WebSockets
│   ├── alembic/             # migraciones
│   ├── scripts/             # seed.py, reset_db.py
│   └── tests/               # pytest
├── frontend/
│   ├── src/
│   │   ├── api/             # cliente HTTP + endpoints
│   │   ├── pages/           # pantallas por rol
│   │   ├── offline/         # cola IndexedDB + flush
│   │   ├── stores/          # zustand (sesión, UI, cola, pedidos pendientes)
│   │   └── websocket/       # cliente realtime
│   ├── e2e/                 # Playwright (§73 y §74)
│   └── public/              # iconos PWA
└── docs/                    # documentación técnica
```

## 5. Documentación

| Archivo | Contenido |
|---|---|
| [`docs/architecture.md`](./docs/architecture.md) | capas, roles, flujo de un pedido, tiempo real |
| [`docs/api.md`](./docs/api.md) | endpoints, auth, idempotencia, eventos WebSocket |
| [`docs/offline-sync.md`](./docs/offline-sync.md) | cola offline, estados, reintentos, conflictos |
| [`docs/database.md`](./docs/database.md) | modelo de datos y reglas de integridad |
| [`docs/deployment.md`](./docs/deployment.md) | entornos, variables, piloto, backups |
| [`docs/testing.md`](./docs/testing.md) | cómo ejecutar y qué cubre cada suite |
