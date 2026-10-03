# AUDITORÍA CODEX V1 — Sistema Restaurante

Fecha de auditoría: 2026-10-02. Alcance: revisión independiente de backend, frontend, PWA, cola offline, WebSocket, PostgreSQL, migraciones y pruebas. No se realizaron cambios funcionales al producto.

## 1. Resumen ejecutivo

**Veredicto: NO APTO PARA PILOTO.**

La base funcional está bien encaminada: existe separación `Order`/`Command`, snapshots de precio/nombre, RBAC básico, Argon2id, `Decimal`/`NUMERIC`, manifest PWA y migración Alembic reversible. Sin embargo, el caso que debe ser más sólido en un restaurante —una respuesta HTTP perdida— duplica comandas al pasar de envío online a cola offline. Además, pagos concurrentes pueden aceptar más dinero que el total y dos solicitudes simultáneas pueden abrir dos atenciones para la misma mesa.

Los tests verdes no detectan esos escenarios porque son esencialmente secuenciales y no simulan la respuesta perdida después de que el servidor confirmó la escritura.

| Severidad | Hallazgos |
|---|---:|
| CRITICAL | 3 |
| HIGH | 7 |
| MEDIUM | 8 |
| LOW | 4 |

## 2. Qué se ejecutó

- Inspección de la estructura, documentación, modelos, migración, rutas REST, WebSocket, PWA, IndexedDB y pruebas.
- `backend/.venv/bin/ruff check .` → correcto.
- `backend/.venv/bin/pytest --disable-warnings -q` → **59 passed**, salida 0, contra PostgreSQL local real.
- `frontend`: `npm run lint`, `npm run typecheck`, `npm run test`, `npm run build` → correctos; Vitest: **15 passed**.
- Playwright: flujo principal y offline básico → **2 passed**.
- Base temporal aislada `restaurante_audit_v1`: `alembic upgrade head`, `current`, `downgrade base`, `current` → correctos.

Durante Playwright aparecieron repetidamente errores de proxy WebSocket `write EPIPE`; la suite los ignora y por eso no cambian el resultado verde.

## 3. Tests actuales y sus límites

Las 59 pruebas backend cubren RBAC básico, carta, secuencias, transiciones, cancelación e idempotencia **secuencial**. Las 15 de frontend cubren componentes y cola con mocks. Las 2 E2E verifican el feliz principal y desconexión antes del envío.

No hay pruebas para respuesta perdida, dos requests concurrentes de pago/apertura/comanda/cierre, reinicio mientras una operación está `SENDING`, acceso cruzado a recursos por UUID, subida de contenido con MIME falsificado, reconexión WS con evento perdido, ni contra un esquema creado exclusivamente mediante Alembic. `backend/tests/conftest.py:64` usa `Base.metadata.create_all`, por lo que la suite no valida la migración de producción.

## 4. Hallazgos CRITICAL

### C-01 — Respuesta perdida duplica comandas (y operaciones online reintentadas)

- **Archivos/ubicación:** `frontend/src/lib/send.ts:14-27`, `frontend/src/offline/queue.ts:29-61,147-152`, `frontend/src/api/endpoints.ts:65-76`.
- **Explicación:** la primera petición online se ejecuta sin `client_operation_id` ni `Idempotency-Key`. Si el backend confirma `201` pero la respuesta se pierde, `sendOrQueue` la interpreta como `NetworkError` y encola una operación nueva con otro UUID. El reintento sí lleva ese UUID nuevo, por lo que PostgreSQL no puede reconocer que es la misma intención.
- **Reproducción:** interceptar/desconectar la respuesta de `POST /orders/{id}/commands` después de que FastAPI haya hecho commit; recuperar red y dejar que `flushQueue()` ejecute la cola. Se crean dos comandas. En `CREATE_ORDER` de tipo `TAKEAWAY`/`DELIVERY` tampoco existe el conflicto de mesa que podría ocultarlo.
- **Impacto:** duplicación de platos, preparación y cobro; incumple el requisito de “exactamente una comanda” ante respuesta perdida.
- **Propuesta:** crear y persistir una única operación antes del primer `fetch`; usar siempre su UUID tanto en body como en header, y enviar/reintentar esa misma operación. No generar el UUID únicamente al detectar fallo de red.

### C-02 — Pagos simultáneos permiten sobrecobro e inconsistencia entre pagos y saldo

- **Archivos/ubicación:** `backend/app/api/billing.py:173-220`; modelos `backend/app/models/billing.py:42-55`.
- **Explicación:** cada transacción lee `order.paid_amount`, compara el saldo y escribe un nuevo valor calculado en memoria. No bloquea la fila del pedido (`SELECT ... FOR UPDATE`), no realiza actualización condicional atómica y PostgreSQL no tiene una restricción que asegure que la suma de `payments` no supere `orders.total`.
- **Reproducción:** con total S/ 25, enviar en paralelo dos `POST /orders/{id}/payments` de S/ 20 con UUIDs distintos. Ambas sesiones pueden leer saldo S/ 25, ambas aceptarse; quedarán pagos por S/ 40 y `paid_amount` puede terminar en S/ 20 por actualización perdida.
- **Impacto:** corrupción financiera, reportes inflados y un pedido que puede mostrar saldo distinto de los pagos registrados.
- **Propuesta:** bloquear el pedido antes de validar/registrar (`with_for_update`), recalcular desde pagos o actualizar el saldo con condición atómica, validar `split_id` contra el pedido y añadir pruebas de concurrencia con sesiones separadas.

### C-03 — Dos solicitudes simultáneas abren dos pedidos activos en una misma mesa

- **Archivos/ubicación:** `backend/app/services/orders.py:129-182`; `backend/app/models/orders.py:22-47`; migración `backend/alembic/versions/0001_initial.py:93-126`.
- **Explicación:** `ensure_table_free()` consulta y luego inserta, sin bloquear la mesa ni tener un índice único parcial que permita sólo un `orders` activo por `table_id`. Dos transacciones concurrentes ven la mesa libre y ambas insertan.
- **Reproducción:** disparar dos `POST /orders` para la misma mesa desde dos sesiones, sincronizadas antes de commit. Ambas pueden responder 201.
- **Impacto:** dos atenciones y comandas paralelas para una mesa; el endpoint de mesas reduce arbitrariamente ambos pedidos a un diccionario por `table_id` (`backend/app/api/tables.py:25-35`).
- **Propuesta:** bloquear la fila de `restaurant_tables` o usar un índice único parcial PostgreSQL para estados activos; manejar `IntegrityError` como 409.

## 5. Hallazgos HIGH

### H-01 — Operaciones `SENDING` quedan bloqueadas definitivamente tras recarga/cierre

- **Ubicación:** `frontend/src/offline/queue.ts:102-104,137-172`; `frontend/src/components/SyncIndicator.tsx:9-26`.
- **Reproducción:** cerrar o recargar la PWA después de persistir `SENDING` (línea 144) y antes de recibir la respuesta. Al reiniciar, `flushQueue` procesa sólo `LOCAL_PENDING`; el indicador invoca el mismo `flush`, así que el registro nunca se reintenta. Tampoco hay UI que llame a `retryOperation`.
- **Impacto:** pedido/comanda puede quedar indefinidamente “por enviar”, sin recuperación automática; incumple recuperación tras cerrar/reabrir PWA.
- **Propuesta:** al arrancar, convertir de forma segura `SENDING` heredados a `LOCAL_PENDING` (manteniendo UUID), y exponer reintento/resolución explícita para `SYNC_ERROR`.

### H-02 — Cancelación sin autorización por área, propiedad o pedido

- **Ubicación:** `backend/app/api/orders.py:212-243`; `backend/app/services/orders.py:343-369`.
- **Reproducción:** autenticarse como `KITCHEN`, obtener UUID de un item de parrilla o de otra atención y llamar a `POST /orders/{order}/items/{item}/cancel`. Basta con que esté `PENDING` o `PREPARING`; devuelve 200.
- **Impacto:** cocina, parrilla o cualquier mesero pueden cancelar productos ajenos y alterar totales. El endpoint de cambio de estado sí comprueba el área, pero cancelación no.
- **Propuesta:** política explícita: mesero creador/admin para cancelación comercial; cocina/parrilla sólo en su propia área, y con auditoría de motivo/rol.

### H-03 — IDOR y exceso de datos operativos para roles de preparación

- **Ubicación:** `backend/app/api/orders.py:39-49,89-92`; `backend/app/api/billing.py:42-78,227-230`; `backend/app/api/expenses.py:75-80`.
- **Reproducción:** como cocina/parrilla usar `GET /orders/{id}`, `GET /orders/{id}/billing` o `GET /orders/{id}/payments` con un UUID conocido. Como mesero, usar `GET /orders/active?area=KITCHEN`: el filtro de propietario sólo se aplica cuando `area is None`.
- **Impacto:** cualquier `StaffUser` ve pedidos ajenos, precios, pagos y gastos concretos sin una necesidad de rol documentada. El historial de turnos y reportes sí están correctamente limitados a ADMIN.
- **Propuesta:** aplicar autorización por recurso en backend; limitar preparación a sus vistas por área, meseros a sus pedidos salvo delegación y cobros a WAITER/ADMIN.

### H-04 — Cierre de turno no serializa con operaciones entrantes

- **Ubicación:** `backend/app/api/shifts.py:48-85`; `backend/app/core/deps.py:91-95`; `backend/app/services/orders.py:122-182`.
- **Explicación/reproducción:** el cierre cuenta pedidos abiertos y crea el snapshot sin bloquear turno/pedidos. Otra sesión que ya resolvió `OpenShift` puede crear pedido, comanda, pago o gasto al mismo tiempo. `ensure_order_in_open_shift` existe pero no se llama desde esas operaciones.
- **Impacto:** operaciones posteriores pueden quedar fuera del snapshot o asociadas a un turno cerrado.
- **Propuesta:** bloquear el turno durante las operaciones críticas y comprobar su estado dentro de la misma transacción; imponer una estrategia de cierre consistente.

### H-05 — WebSocket expone el JWT en URL y no tiene control de origen ni escala entre procesos

- **Ubicación:** `frontend/src/websocket/useSocket.ts:103-112`; `backend/app/api/ws.py:14-38`; `backend/app/ws/hub.py:27-64`.
- **Explicación:** access token via query string puede acabar en logs/proxies; el WebSocket no valida `Origin`; el hub es sólo memoria de un proceso, por lo que con más de un worker/instancia los broadcasts se pierden entre procesos.
- **Impacto:** exposición de token, conexiones desde orígenes no deseados y pérdida de tiempo real al escalar. REST resync del cliente reduce, pero no sustituye un bus compartido.
- **Propuesta:** evitar query token (subprotocol/cookie seguro según diseño), validar Origin, no registrar query strings sensibles y usar un broker compartido si se despliega más de un proceso.

### H-06 — Comprobantes aceptan contenido arbitrario y se publican sin control

- **Ubicación:** `backend/app/api/receipts.py:18-73`; `backend/app/main.py:143-147`; `backend/app/schemas/ops.py:10-15`.
- **Reproducción:** subir bytes no-PNG con nombre `.png` y header `image/png`; sólo se confían extensión y MIME proporcionados por cliente. También se puede registrar cualquier `receipt_url` sin enlazarlo a una subida válida.
- **Impacto:** contenido no validado queda público en `/uploads`; en piloto, si faltan credenciales Supabase se usa disco local en lugar del storage exigido.
- **Propuesta:** verificar magic bytes/parsear imagen/PDF, restringir referencias a objetos propios, almacenar privado y servir URLs firmadas; fallar explícitamente en piloto si Supabase no está configurado.

### H-07 — Secret JWT por defecto inseguro y rate limit sólo por proceso

- **Ubicación:** `backend/app/config.py:12-39`; `backend/app/core/security.py:77-118`.
- **Explicación:** la aplicación arranca con `jwt_secret = "dev-secret-cambiar"` si el entorno no lo sobrescribe. El bloqueo de login está en memoria, se evade con varios workers/reinicios/instancias y no comparte estado.
- **Impacto:** en una configuración de piloto incompleta se pueden falsificar tokens; protección de PIN insuficiente al escalar.
- **Propuesta:** rechazar arranque productivo sin secreto fuerte aleatorio y usar rate limit compartido (Redis/gateway), incorporando IP fiable tras proxy.

## 6. Hallazgos MEDIUM

### M-01 — Divisiones de cuenta tienen carreras y `split_id` no se valida contra el pedido

- **Ubicación:** `backend/app/api/billing.py:83-162,173-220`.
- **Reproducción:** dos solicitudes simultáneas asignan la última unidad de un item o el último monto disponible; ambas pueden superar el límite. En un pago, enviar el UUID de una división de otro pedido: no se comprueba pertenencia ni monto.
- **Impacto/solución:** divisiones incoherentes y trazabilidad incorrecta. Bloquear pedido/divisiones y validar relación `split.order_id == order.id`.

### M-02 — Integridad de negocio depende de Python, no de PostgreSQL

- **Ubicación:** modelos `backend/app/models/*.py`, migración `0001_initial.py`.
- **Explicación:** no hay `CHECK` para montos/precios/cantidades positivos, áreas/roles/estados válidos, ni restricciones parciales de turno/mesa activa. Los FK sí existen y hay algunos `UNIQUE`, pero una escritura directa o carrera puede dejar valores inválidos.
- **Impacto/solución:** corrupción que el ORM no podrá prevenir. Añadir checks, índices parciales y transacciones/bloqueos donde aplique.

### M-03 — Eventos WebSocket se emiten antes del commit

- **Ubicación:** `backend/app/services/orders.py:181,253-266,319-338,367-368`; documentación `docs/database.md:80-83` afirma lo contrario.
- **Reproducción:** forzar un error de commit después de `hub.broadcast`; un cliente recibe un evento para datos que luego se revierten.
- **Impacto/solución:** UI temporalmente falsa y documentación incorrecta. Publicar sólo tras commit (outbox/post-commit), manteniendo REST como verdad.

### M-04 — Auditoría incompleta o sin actor correcto

- **Ubicación:** `backend/app/api/menu.py:96-105`, `backend/app/api/orders.py:181-209`, `backend/app/api/expenses.py:94-120`.
- **Explicación:** cambio de precio usa `user_id=None`; modificar cantidad/notas de item, altas/cambios de carta, usuarios y lista de compras no deja evento. Los eventos exigidos principales existen, pero no todos se pueden atribuir correctamente.
- **Impacto/solución:** no se puede reconstruir quién alteró operación o carta. Pasar `AdminUser` al cambio de precio y auditar mutaciones materiales.

### M-05 — Tests no representan el despliegue ni las condiciones adversas

- **Ubicación:** `backend/tests/conftest.py:64`, `backend/tests/test_auth.py:78-80`, `frontend/e2e/*.spec.ts`.
- **Explicación:** pruebas crean esquema con ORM; la aserción de hash de PIN es vacua (`... if ... else True`); no hay pruebas de producción PWA/WS ni de fallos críticos arriba indicados.
- **Impacto/solución:** falsa confianza por tests verdes. Ejecutar tests contra `alembic upgrade head`, eliminar aserciones vacías y añadir matriz de fallos/red/concurrencia.

### M-06 — `command.sequence_number` puede responder 500 ante creación concurrente

- **Ubicación:** `backend/app/services/orders.py:185-228`; `backend/app/core/idempotency.py:89-98`.
- **Explicación/reproducción:** dos comandas distintas leen la misma siguiente secuencia; la segunda choca con `uq_command_seq`. El `IntegrityError` se revierte y no se traduce en retry/conflicto controlado.
- **Impacto/solución:** operación válida falla bajo concurrencia. Bloquear pedido o asignar secuencia atómicamente y reintentar de forma segura.

### M-07 — UX offline comunica “enviada” para una comanda sólo local

- **Ubicación:** `frontend/src/pages/waiter/TableOrderPage.tsx:129-156`.
- **Reproducción:** con pedido padre aún offline, agregar productos. La pantalla primero avisa “Comanda guardada” y a continuación muestra “Comanda enviada”.
- **Impacto/solución:** mesero puede creer que cocina la recibió. No mostrar éxito de envío hasta `SYNCED`; distinguir persistentemente guardado local, en proceso y confirmado por servidor.

### M-08 — Repositorio Git no está inicializado en el directorio del proyecto

- **Evidencia:** `git rev-parse --show-toplevel` devuelve `/home/herman`; la rama `master` no tiene commits y `git status` enumera el home completo como no trackeado.
- **Impacto/solución:** no existe historial/auditoría de cambios del producto y aumenta el riesgo de añadir archivos personales o secretos. Inicializar/ubicar el repositorio correcto en `restaurante` antes de desplegar.

## 7. Hallazgos LOW

### L-01 — Reintento/backoff fijo en memoria

- **Ubicación:** `frontend/src/offline/queue.ts:15-18`, `frontend/src/stores/queue.ts:87-93`.
- **Impacto/solución:** el intervalo se calcula una vez y no se actualiza al cambiar backoff; tras recarga se pierde. Reprogramar temporizador y persistir metadatos mínimos.

### L-02 — `refresh` y `logout` no revocan tokens

- **Ubicación:** `backend/app/api/auth.py:53-65`.
- **Impacto/solución:** logout es sólo cliente; token robado sigue vigente hasta expirar. Documentar limitación V1 o incorporar lista de revocación/rotación.

### L-03 — Archivos operativos no están ignorados explícitamente

- **Ubicación:** `.gitignore`.
- **Impacto/solución:** `backend/uploads/` y resultados de pruebas no tienen una regla específica. Ignorarlos para evitar publicar comprobantes/artefactos.

### L-04 — PWA configurada, no validada en móvil real

- **Ubicación:** `frontend/vite.config.ts:8-31`.
- **Resultado:** manifest, iconos, `display: standalone`, `start_url` y `navigateFallback` se generan correctamente en build. No fue posible certificar instalación Android/Chromium ni restauración desde icono en este entorno.
- **Propuesta:** prueba manual registrada en dispositivo y E2E contra `vite preview`/hosting final.

## 8. Requisitos faltantes o no demostrados

- Idempotencia de extremo a extremo para petición aceptada con respuesta perdida.
- Recuperación automática de cola tras cierre/reapertura mientras estaba `SENDING`.
- Concurrencia segura para pagos, divisiones, comandas, mesas y cierre de turno.
- Autorización por recurso y por área en cancelación/lectura de datos financieros.
- Verificación de binario y almacenamiento seguro de comprobantes.
- Validación de instalación PWA móvil y de reconexión WS con pérdida de eventos.
- Protección de integridad en PostgreSQL para invariantes críticas.

## 9. Arquitectura, seguridad, offline, PWA y base de datos

La arquitectura por capas es comprensible y el frontend no contiene carta/mesas/precios operativos hardcodeados: los valores de negocio encontrados están en seeds, fixtures y pruebas. `Order` y `Command` están correctamente separados, y los snapshots se almacenan. El problema central es que los invariantes se apoyan en lecturas previas en Python y un hub de memoria, no en locks/constraints/outbox.

Seguridad: Argon2id, expiración JWT, CORS explícito y RBAC de pantallas/rutas son positivos; los hallazgos H-02, H-03, H-05, H-06 y H-07 impiden considerar la superficie segura para piloto. No se hallaron secretos de Supabase publicados ni SQL construido desde entrada de usuario.

Offline/PWA: IndexedDB y las dependencias pedido→comanda están presentes, y la cola conserva `LOCAL_PENDING`, `SENDING`, `SYNCED`, `SYNC_ERROR`. C-01 y H-01 rompen las dos garantías más importantes. El build PWA genera `manifest.webmanifest`, `sw.js`, iconos y fallback de navegación, pero no hace que la cola sea segura por sí sola.

PostgreSQL/Alembic: UUID, FK, `NUMERIC(12,2)` y algunas unicidades están bien. La migración inicial se aplica y revierte desde una base limpia. Faltan restricciones de negocio y las pruebas no usan Alembic.

## 10. Plan de corrección priorizado

1. **Bloquear despliegue.** Corregir C-01 y añadir prueba que corte la respuesta después del commit; verificar exactamente una comanda y un pedido.
2. **Blindar dinero y mesas.** Locks/actualizaciones atómicas para C-02/C-03/M-01/M-06, más pruebas concurrentes con conexiones PostgreSQL independientes.
3. **Cerrar carreras de turno.** Serializar cierre y operaciones contra el turno, y hacer cumplir el estado en la misma transacción.
4. **Reparar cola/UX.** Recuperar `SENDING`, UI de retry/error real y textos que distingan local vs servidor.
5. **Endurecer permisos y uploads.** Políticas por recurso/área, comprobante seguro, JWT/configuración y WS.
6. **Fortalecer operación.** Outbox/broker para WebSocket, constraints PostgreSQL, auditoría completa y pruebas contra Alembic/PWA de producción.

No se recomienda iniciar correcciones masivas sin decidir primero la estrategia transaccional e idempotente común para todas las mutaciones.
