# Notificaciones de Restaurante V2

## Diagnóstico

Antes de este cambio la campana solo alternaba un sonido global, había un pitido Web Audio
sin control de volumen ni desbloqueo explícito, y el backend guardaba suscripciones sin
enviar Web Push ni asociarlas a un dispositivo. Las notificaciones en tiempo real dependían
del WebSocket y el filtrado de `command.created` en el cliente no distinguía cocina de
parrilla.

## Arquitectura y privacidad

- Los cambios de dominio siguen publicándose después del `COMMIT`. WebSocket conserva su
  contrato (`event` y `data`) y suma un identificador `id` para deduplicación entre pestañas.
- Un conjunto explícito de eventos puede programar Web Push en una tarea de fondo, fuera de
  la transacción y con timeout al proveedor. Los errores se registran sin alterar la petición
  de pedidos/cobros. No hay reintentos garantizados ni una cola durable.
- Los destinatarios se calculan en el servidor desde usuarios activos, suscripción vigente,
  rol y área del evento. Para pedidos del mesero se respeta `created_by_waiter_id`; al salir,
  se elimina la suscripción asociada a ese dispositivo.
- Los payloads push solo contienen identificador del evento, texto genérico y una ruta fija.
  Nunca se envían nombres, platos, mesa, importes, notas ni identificadores de pedido.
  Los endpoints se limitan a proveedores Web Push HTTPS conocidos para evitar que una
  suscripción manipulada se convierta en una petición del servidor a destinos arbitrarios.
- El service worker muestra la notificación visible requerida por Web Push y abre una ruta
  permitida al tocarla. Si el usuario habilita Push, WebSocket invalida/actualiza datos pero
  no crea un segundo aviso local. Sin Push, los avisos WebSocket respetan rol/área y no
  reproducen sonido ni vibración en pestañas ocultas.
- Sonido, volumen, vibración y Push se guardan por usuario y dispositivo. El audio solo se
  inicializa desde una interacción directa; errores, autoplay bloqueado, ausencia de Web
  Audio o Vibración API no interrumpen la operación. Solo suena un patrón a la vez.

La suscripción expone un endpoint que actúa como capacidad para enviar mensajes y se trata
como dato sensible. El endpoint de consulta de clave VAPID pública no entrega la clave
privada.

## Configuración de producción

En Render, definir como secretos/variables de entorno del backend:

| Variable | Uso |
| --- | --- |
| `VAPID_PUBLIC_KEY` | Clave pública base64url; se entrega al navegador. |
| `VAPID_PRIVATE_KEY` | Clave privada VAPID; secreto exclusivo del backend. |
| `VAPID_SUBJECT` | Contacto VAPID `mailto:` o URL de operación. |

Generar un par VAPID propio para el entorno y guardarlo en el gestor de secretos de Render;
no reutilizar claves de ejemplo ni incluir la clave privada en Git, frontend o logs. Ambas
claves se configuran juntas. Sin ellas la aplicación sigue operativa, la consulta pública
devuelve `null` y el alta de Push responde `503 PUSH_UNAVAILABLE`.

El generador del proyecto `py-vapid` documenta `vapid --gen` para crear los PEM y
`vapid --applicationServerKey` para obtener la clave pública que consume el navegador. Guarde
la clave pública generada en `VAPID_PUBLIC_KEY` y el contenido PEM privado en
`VAPID_PRIVATE_KEY`; `VAPID_SUBJECT` debe ser un contacto real. Genere/guarde el par en un
entorno confiable y no en una terminal compartida.

Aplicar la migración `0006_push_device` con el procedimiento usual de despliegue (`alembic
upgrade head`). No se requiere una tabla nueva: añade el identificador de dispositivo a
`push_subscriptions`. Las pruebas deben apuntar solo a `restaurante_test`/`*_e2e_test`; esta
implementación no accede a Supabase directamente.

## Compatibilidad que se debe verificar

Web Push es opt-in, depende de HTTPS, permisos del navegador, service worker, el proveedor
push y los ajustes del sistema. No se declara compatibilidad universal. En iOS/iPadOS, Web
Push requiere una web app añadida a la pantalla de inicio y permiso solicitado desde una
acción directa del usuario; una pestaña Safari normal no basta. El API de vibración tiene
disponibilidad limitada y se detecta en tiempo de ejecución. Navegadores de escritorio y
Android también pueden ocultar o retrasar avisos según permisos, ahorro de batería o foco.

Referencias oficiales consultadas: [Apple Web Push](https://developer.apple.com/documentation/usernotifications/sending-web-push-notifications-in-web-apps-and-browsers),
[WebKit para iOS/iPadOS](https://webkit.org/blog/13878/), [MDN Push API](https://developer.mozilla.org/en-US/docs/Web/API/Push_API),
[MDN Notifications](https://developer.mozilla.org/en-US/docs/Web/API/Notifications_API/Using_the_Notifications_API),
[MDN Vibration API](https://developer.mozilla.org/en-US/docs/Web/API/Vibration_API),
[Chrome Web Push](https://developer.chrome.com/blog/push-notifications-on-the-open-web),
[Microsoft Edge PWA Push](https://learn.microsoft.com/en-us/microsoft-edge/progressive-web-apps/how-to/push),
[py-vapid key generation](https://pypi.org/project/py-vapid/).

### Matriz manual con dispositivos físicos

Completar y anotar versiones exactas de SO/navegador antes de habilitar Push a todo el personal.

| Dispositivo/instalación | Preparación | Comprobar |
| --- | --- | --- |
| Android, Chrome | HTTPS; instalar PWA opcional; aceptar permiso desde Ajustes | alta, app visible/segundo plano, pantalla bloqueada, toque y ruta, baja y logout |
| iPhone/iPad, Safari | Añadir a pantalla de inicio; abrir desde el icono; activar desde botón | prompt por gesto, visible/segundo plano, bloqueo, toque, permiso denegado y revocado |
| Windows, Edge y Chrome | HTTPS; permiso habilitado en navegador y sistema | aviso enfocado y en segundo plano, clic, cierre de sesión, proveedor vencido |
| macOS, Safari y Chrome | Safari con versión compatible; revisar ajustes de notificaciones de macOS | permiso, app/tab, modo foco, clic y desactivación |
| Firefox de escritorio/Android | Revisar soporte y permiso del build concreto | ciclo completo de suscripción y entrega, foco y ahorro de batería |
| Web sin Push/permiso denegado | navegador sin API o permiso denegado | la app sigue usable; WebSocket/toast funciona; no hay excepción ni prompt repetido |

En cada plataforma repetir: sonido apagado/volumen 0, audio bloqueado antes de “Probar sonido”,
vibración no soportada, dos eventos rápidos, cocina/parrilla con área cruzada, waiter distinto
al creador, evento con Push + WebSocket, interrupción de red y reconexión, permiso revocado,
logout y segundo usuario en el mismo dispositivo. Confirmar que la notificación de sistema
no incluye contenido privado.

## Pruebas y límites de esta revisión

Las pruebas frontend cubren preferencias aisladas por usuario, audio bloqueado, vibración no
soportada, permiso denegado, alta simulada, deduplicación y filtrado por área. También se
añadieron pruebas backend para propiedad por usuario/dispositivo, selección por rol/área,
payload genérico y borrado de suscripciones `404/410`.

No se pudieron ejecutar las pruebas backend PostgreSQL en esta sesión: el contenedor aislado
`db-test` no estaba activo y el entorno no permitió acceder al daemon Docker de pruebas. La
instalación local de `pywebpush` tampoco pudo completarse por falta de conexión al índice de
paquetes. No se usó ni modificó Supabase. Antes de declarar el release listo, ejecutar el
conjunto backend contra PostgreSQL aislado después de permitir `docker compose up -d db-test`
y reinstalar `backend/requirements.txt`; completar además la matriz física anterior. Web
Push está implementado, pero la entrega real requiere secretos VAPID y validación de proveedor
en el entorno de producción.
