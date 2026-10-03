# Despliegue y operación

## 1. Entornos (§80)

```text
development
production-pilot
```

No se mantiene un staging independiente en V1.

| | Desarrollo | Piloto |
|---|---|---|
| Backend | `uvicorn` local en `:8000` | Render (Web Service) |
| Base de datos | Docker `postgres:16` (`.env` local) | Supabase (PostgreSQL) |
| Storage de comprobantes | disco local (`backend/uploads/`) | Supabase Storage (`receipts`) |
| Frontend | `vite dev` en `:5173` | build estático (`dist`) en Render Static Site u otro hosting estático |

Durante el piloto se usa una URL temporal/subdominio; no se compra infraestructura adicional
hasta validar el sistema (§78).

## 2. Variables de entorno (§77)

Plantilla en [`.env.example`](../.env.example). **Nunca subir `.env`** (está en `.gitignore`).

| Variable | Descripción | Ejemplo |
|---|---|---|
| `ENVIRONMENT` | `development` / `production-pilot` / `test` | `development` |
| `LOG_LEVEL` | nivel de logging | `INFO` |
| `DATABASE_URL` | SQLAlchemy (`postgresql+psycopg://…`) | `…@localhost:5432/restaurante` |
| `DATABASE_URL_TEST` | base de tests (`:5433`) | `…@localhost:5433/restaurante_test` |
| `JWT_SECRET` | secreto HS256 (**obligatorio en producción**, ≥ 32 bytes) | — |
| `JWT_ACCESS_TOKEN_MINUTES` | vigencia del access token | `30` |
| `JWT_REFRESH_TOKEN_DAYS` | vigencia del refresh token | `14` |
| `CORS_ORIGINS` | orígenes permitidos, coma-separados | `https://mi-piloto.onrender.com` |
| `SUPABASE_URL` / `SUPABASE_SERVICE_KEY` / `SUPABASE_STORAGE_BUCKET` | storage de comprobantes | — |
| `FRONTEND_URL` | URL del front (enlaces/refresh) | `https://…` |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_LOCKOUT_MINUTES` | rate limit de login | `5` / `5` |
| `BUSINESS_TIMEZONE` | zona horaria de reportes | `America/Lima` |

Frontend (build de Vite):

| Variable | Descripción |
|---|---|
| `VITE_API_URL` | base del API; si se omite se usan rutas relativas (proxy en dev, mismo origen en piloto) |

## 3. Despliegue del piloto

### Backend (Render)

1. Crear *Web Service* desde el repositorio con root directory `backend`.
2. Configurar variables de entorno (§2) apuntando a Supabase.
3. Orden de arranque:

```bash
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --host 0.0.0.0 --port $PORT
```

4. Verificar `GET /health` y `GET /api/docs`.

### Base de datos (Supabase)

- Crear el proyecto, obtener la cadena de conexión y usar el sufijo
  `postgresql+psycopg://user:pass@host:5432/db`.
- Aplicar las migraciones con `alembic upgrade head` (desde el entorno que tenga acceso a la BD).
- Activar backup/pitr según §79.

### Frontend

```bash
cd frontend
npm ci
npm run build       # genera frontend/dist (HTML + service worker + manifest)
```

Publicar `dist` como sitio estático. Configurar `VITE_API_URL` en tiempo de build si el API
está en otro dominio (y habilitar ese origen en `CORS_ORIGINS`).

### Storage de comprobantes

Con `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` vacíos, los comprobantes se guardan en
`backend/uploads/` (sirve el *Mount* `/uploads`). En piloto se recomienda Supabase Storage
bucket `receipts`.

### WebSocket V1

El hub WebSocket V1 está deliberadamente limitado a **una instancia y un worker de Uvicorn**.
No configure `--workers` ni escale horizontalmente este servicio: hacerlo requiere un broker
compartido y queda fuera del alcance V1. El cliente siempre resincroniza por REST al reconectar.

## 4. Operación

- **Logs:** formato estándar de uvicorn/`logging` con `LOG_LEVEL`; nunca se registran PIN,
  hashes, tokens ni secretos (§66).
- **Errores:** todos los responses de error siguen `{error: {code, message, details}}` (§75).
- **Health:** `GET /health` → `{"status":"ok"}` para el check de Render.
- **WebSockets:** el hosting debe permitir conexiones WS largas (Render lo hace en el
  servicio web; verificar durante el piloto).

## 5. Backups (§79)

- Piloto: backup **semanal** (dump de Supabase o `pg_dump`) + documento de restauración.
- Antes de producción real: evaluar backup **diario** y probar la restauración.

Procedimiento mínimo documentado:

```bash
pg_dump "$DATABASE_URL" -Fc -f restaurante-$(date +%F).dump
# restauración
pg_restore --clean --if-exists -d "$DATABASE_URL" restaurante-2026-10-02.dump
```

## 6. Git (§81)

Commits pequeños con prefijo `feat:` / `fix:` / `test:` / `refactor:` / `docs:` / `chore:`.
No commitear `.env`, credenciales ni volúmenes de datos.
