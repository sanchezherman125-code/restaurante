# Preparación para producción — 20 de octubre de 2026

Estado del software: preparado para pruebas de aceptación y despliegue con las condiciones
de operación de V1. No se publicó ni se modificó infraestructura remota durante este trabajo.
El arranque de producción valida sus condiciones y falla si faltan secretos seguros,
migraciones, administrador válido o almacenamiento privado.

## Correcciones

- Migración 0004 para `menu_items.image_url`, timestamps e índices; modelos y Alembic coinciden.
- Migración 0005 para sesiones revocables y comprobantes privados, integridad monetaria,
  un único turno abierto y RLS que impide el acceso directo del Data API a las tablas backend.
- Fixtures backend basados en migraciones reales; CI levanta PostgreSQL y una base E2E separada.
- Retiro de credenciales demo del login y prohibición del seed en producción.
  Bootstrap de administrador privado y herramienta de rotación de PIN para instalaciones existentes.
- Rotación de refresh tokens; logout, cambio de PIN/rol y desactivación revocan sesiones.
  WebSocket revalida la sesión y el frontend renueva el token al reconectar.
- Eventos de pedidos publicados después del commit y descartados al hacer rollback.
- Idempotencia vinculada a usuario, operación y recurso; UUID estable en gastos y cancelaciones.
- Restricción de entregas al mesero responsable; respuestas de cocina/parrilla limitadas
  a su área y notificaciones de pedidos filtradas por propietario.
- Pagos con respuesta incierta conservan UUID/monto tras recarga y permiten verificación
  incluso cuando el servidor ya muestra saldo cero. Importes limitados a dos decimales.
- Pagos de divisiones no exceden su saldo y los importes ya pagados no se reservan dos veces.
- Cola offline aislada por usuario, recuperación de SENDING, backoff persistido y errores
  revisables desde la interfaz. Los 5xx inciertos preservan la identidad de la operación.
- Comprobantes descargados por API con control de propietario/ADMIN; bucket privado obligatorio.
- Configuración Render versionada con un worker/instancia, HTTPS, CORS, host permitido,
  endpoint de disponibilidad y despliegue condicionado a CI.
- Dependencias Python fijadas y verificación de instalación en un directorio aislado.

## Evidencia local

| Verificación | Resultado |
| --- | --- |
| Suite backend completa | 91 pruebas aprobadas; una regresión adicional de destinatarios WebSocket aprobada por separado (92 verificadas en total) |
| Backend desde una base vacía | Migraciones aplicadas antes de los tests; 85 pruebas aprobadas en esa pasada inicial |
| Regresión final de cobros y producción | 25 pruebas aprobadas |
| Suite frontend | 33 pruebas aprobadas |
| ESLint / TypeScript / build PWA | Aprobados |
| E2E contra build de producción | Flujo operativo y offline aprobados |
| Alembic check | Sin nuevas operaciones de migración |
| Backup y restauración PostgreSQL | Dump custom restaurado en otra base local; Alembic check aprobado |
| Blueprint Render | Validado con JSON Schema oficial descargado el 20/10/2026 |
| npm audit de dependencias de producción | 0 vulnerabilidades conocidas |
| pip-audit del conjunto Python fijado | Sin vulnerabilidades conocidas |

Los tests de almacenamiento remoto usan dobles HTTP: se verifica la política privada y el
rechazo de configuración pública, sin afirmar una conexión real con un bucket del usuario.
La suite emite una advertencia de deprecación de TestClient/httpx de una dependencia;
no afecta los resultados y no se utiliza como servidor de producción.

## Condiciones del despliegue real

Siga [deployment.md](./deployment.md). Deben configurarse las credenciales y URLs reales,
bucket privado, PIN inicial, backups diarios y monitoreo. Pruebe restauración y aceptación
con los datos y dispositivos reales antes de atender al público.

V1 se limita a una instancia y un worker. El hub WebSocket sigue en memoria; la configuración
versionada y el arranque fijan esa topología, y REST recupera el estado tras reconexiones.
El escalado permanente requiere un broker compartido.

La instalación PWA en Android/iPhone físicos, la latencia de la red del restaurante,
el comportamiento del hosting real y los backups remotos quedan para la aceptación del entorno.
Las auditorías anteriores en `docs/` se conservan como historial; este documento registra
la evidencia y los cambios de esta revisión.
