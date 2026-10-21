# Despliegue de producción

La configuración reproducible está en [render.yaml](../render.yaml) y
[.env.production.example](../.env.production.example). La aplicación se despliega como
API Python en Render, frontend estático en Render, PostgreSQL y Storage privado en Supabase.
La validación local no equivale a una publicación ni a una verificación del entorno remoto.

## Primera publicación

1. En Supabase, prepare una base vacía o una copia revisada de los datos existentes.
   Use conexión directa o session pooler con `sslmode=require` (preferiblemente
   `verify-full` con CA). Evite el transaction pooler para las migraciones.
   El usuario de conexión debe ser dueño de las tablas, o un rol backend privado con BYPASSRLS.
   Ninguna clave de servicio ni cadena de conexión se configura en el frontend.
2. Cree el bucket `receipts` como **privado**. Si ya existía un bucket público,
   conviértalo a privado antes de publicar y revise las URLs históricas.
   Configure límite de 5 MiB y tipos JPEG, PNG, WebP y PDF.
3. Complete las variables solicitadas por el Blueprint:
   - API: `DATABASE_URL`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`,
     `CORS_ORIGINS`, `FRONTEND_URL`, `ALLOWED_HOSTS`, `ADMIN_USERNAME`, `ADMIN_PIN`.
     Para Web Push, configure además `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` y
     `VAPID_SUBJECT` como secretos/variables del API. Si no configura el par VAPID, el
     resto de la aplicación funciona pero los avisos de sistema quedan desactivados;
     consulte [Notificaciones](./notifications.md).
   - Frontend: `VITE_API_URL=https://URL-DEL-API`, sin barra final ni sufijo `/api`.
   - `CORS_ORIGINS` incluye el origen exacto HTTPS del frontend, sin barra final.
     `FRONTEND_URL` usa ese mismo origen.
   - `ALLOWED_HOSTS` contiene el hostname del API, sin esquema.
   - Render genera `JWT_SECRET`. No sustituya este secreto por ejemplos.
   - El PIN inicial debe tener entre 6 y 10 dígitos y ser privado.
4. Suba los cambios al repositorio y sincronice el Blueprint con Render. Los nombres
   `restaurante-api` y `restaurante-front` deben revisarse si ya existen servicios;
   el Blueprint podría asociarse con ellos. El API usa un plan de cómputo pagado.
5. El predeploy ejecuta `alembic upgrade head` y `scripts.bootstrap_admin`.
   En una instalación vacía crea sólo al administrador. Si ya existe, no altera cuentas.
   Configure mesas, carta y personal desde la aplicación. **El seed demo está bloqueado
   en producción.**
6. Quite `ADMIN_PIN` y `ADMIN_USERNAME` de las variables una vez creado el administrador.
   Los siguientes predeploy no los necesitan. Las cuentas demo activas con PIN `1234`
   deben cambiarse o desactivarse antes del arranque.
   Para una instalación existente que aún use esas claves, ejecute primero las migraciones
   y use `python -m scripts.rotate_pin` en una consola privada (solicita usuario y PIN sin
   mostrarlo). Revoca las sesiones anteriores y conserva todos los datos de negocio.
7. El arranque verifica migraciones, administrador, configuración segura y bucket privado.
   `GET /ready` devuelve 200 sólo con acceso a la base; `/health` comprueba el proceso.
   La documentación interactiva del API queda desactivada en producción.

Los valores `sync: false` se solicitan en la creación inicial; una sincronización posterior
no los actualiza automáticamente. El frontend necesita reconstruirse si cambia `VITE_API_URL`.

## Topología soportada

V1 funciona con **una instancia y un worker**. `render.yaml` declara `numInstances: 1`;
`python -m scripts.start` fija `workers=1` y rechaza `WEB_CONCURRENCY` distinto de 1.
No habilite autoscaling ni otro comando de arranque. Para servicios existentes, confirme que
autoscaling esté desactivado en el Dashboard: `numInstances` no lo reemplaza.

El hub de WebSocket está en memoria. Los eventos se publican después del commit y los clientes
resincronizan por REST al reconectar, con consulta periódica de pedidos cada 15 segundos.
Los reinicios o el breve solapamiento de un despliegue pueden retrasar una notificación;
la base conserva el pedido. Múltiples instancias permanentes requieren un broker compartido.

## Actualización de una instalación existente

1. Realice y verifique un backup antes de migrar.
2. Ejecute primero las pruebas en una copia aislada.
3. La migración 0004 agrega la imagen de carta y alinea nulabilidad e índices.
   La 0005 añade sesiones revocables, comprobantes privados, restricciones monetarias,
   un único turno abierto y protección de tablas frente al Data API.
4. Si existen totales negativos, sobrepagos, divisiones de monto cero o varios turnos abiertos,
   la migración aborta. Reconcilie esos registros con el responsable del negocio y vuelva
   a ejecutarla; la migración no reescribe importes históricos.
5. Las sesiones anteriores dejan de ser válidas: el personal debe iniciar sesión otra vez.
   Sincronice antes de actualizar cualquier dispositivo con operaciones locales pendientes.
   Las operaciones antiguas sin usuario identificado quedan para revisión explícita.
6. Las tablas habilitan RLS sin políticas públicas: la autorización se hace en FastAPI.
   No conceda acceso directo a `anon`/`authenticated` para estas tablas.
7. Los comprobantes nuevos se consultan por API con usuario propietario o administrador.
   Para comprobantes locales anteriores, la ruta `/uploads` exige autenticación.
   Si había archivos sólo en el disco de otro servidor, muévalos al Storage privado antes
   de reemplazar ese servidor; el Blueprint no transfiere archivos históricos.

## Backups y recuperación

En producción configure backup diario y retención en Supabase, y conserve una copia fuera del
servidor de aplicación. Habilite PITR cuando el objetivo de recuperación del negocio lo requiera.
Los backups de PostgreSQL no sustituyen el respaldo de los **objetos** de Storage:
respalde también el bucket privado de comprobantes.

Para un dump manual, use las variables PostgreSQL nativas (`PGHOST`, `PGPORT`,
`PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE=require`) en un entorno privado.
No pase la URL `postgresql+psycopg://` directamente a `pg_dump` ni imprima secretos.

```bash
pg_dump --format=custom --file=restaurante.dump
pg_restore --list restaurante.dump
```

Pruebe la restauración **en una base nueva y aislada**, nunca sobre la base activa:

```bash
# Configure PGDATABASE a la base nueva antes de este comando.
pg_restore --exit-on-error --no-owner --no-privileges --dbname="$PGDATABASE" restaurante.dump
```

Compruebe migraciones, conteos de pedidos/pagos y acceso autenticado a comprobantes restaurados.
Registre fecha, duración y responsable de la prueba. Proteja los dumps y elimínelos según la
retención acordada. No revierta migraciones financieras sobre la base en uso para hacer rollback:
restaure una copia validada o aplique una corrección hacia adelante.

## Aceptación en el entorno real

Antes de abrir al personal: verifique HTTPS, CORS, cuatro roles en dispositivos separados,
pedido cocina/parrilla, entrega, pago parcial/total, cierre de turno y reporte.
Pruebe pérdida de Wi-Fi y recuperación sin duplicados, instalación PWA en los móviles reales,
subida/lectura privada de comprobantes y reinicio del API con reconexión.
Configure monitoreo de `/ready`, alertas de errores/almacenamiento y responsable de recuperación.

Las comprobaciones automáticas se ejecutan en [CI](../.github/workflows/ci.yml).
El despliegue automático espera checks aprobados. La prueba local de backup/restauración
verifica el procedimiento técnico; los backups remotos deben quedar configurados y comprobados
con las credenciales reales.

Referencias vigentes consultadas: [Blueprints de Render](https://render.com/docs/blueprint-spec),
[variables de Render](https://render.com/docs/configure-environment-variables),
[Storage privado](https://supabase.com/docs/guides/storage/serving/downloads)
y [seguridad del Data API](https://supabase.com/docs/guides/api/securing-your-api).
