# SEGUNDA AUDITORÍA CODEX V1

Fecha: 2026-10-02

## 1. Resumen ejecutivo

Se verificó de forma independiente la remediación declarada por OpenCode. La evidencia confirma que los tres hallazgos CRITICAL de la primera auditoría quedaron cubiertos por pruebas reales de PostgreSQL y que la mayoría de los HIGH quedaron resueltos en código y en suite. Sin embargo, la validación end-to-end del flujo principal todavía falla en un punto funcional relevante y la limitación operacional de WebSocket V1 (hub en memoria) sigue siendo un requisito de despliegue explícito, no un bloqueo aislado del código.

La conclusión del auditor no es que la plataforma esté lista para producción; el diagnóstico es más conservador: la solución es razonablemente sólida para la parte transaccional de backend y para la cola offline, pero todavía no está validada en la experiencia completa del restaurante ni en una topología multi-worker.

## 2. Método de auditoría

Se revisó independientemente la documentación del proyecto y el código de:

- backend/app/api/*
- backend/app/core/*
- backend/app/models/*
- backend/app/ws/hub.py
- frontend/src/offline/*
- frontend/src/websocket/useSocket.ts
- frontend/vite.config.ts
- frontend/e2e/*

Se ejecutaron comprobaciones reales de:

1. Concurrencia PostgreSQL real para los casos críticos.
2. Suite completa del backend.
3. Suite Vitest del frontend.
4. Lint, typecheck y build del frontend.
5. E2E de offline y flujo principal.
6. Validación del WebSocket y del despliegue V1.

## 3. Resultados verificables

### 3.1 Backend PostgreSQL real

Comando ejecutado:

```bash
cd /home/herman/Escritorio/restaurante/backend
. .venv/bin/activate
pytest tests/test_concurrency.py -q
```

Evidencia observada:

- 4 pruebas ejecutadas
- 4 pruebas pasadas
- salida final: `.... [100%]`

Esto cubre directamente:

- idempotencia de comando concurrente
- pagos concurrentes no exceden el total
- apertura doble de mesa activa
- cierre de turno serializado con creación de pedido

### 3.2 Suite completa de backend

Comando ejecutado:

```bash
cd /home/herman/Escritorio/restaurante/backend
. .venv/bin/activate
pytest -q
```

Evidencia: la suite terminó con exit 0 y el conjunto completo fue superado. La documentación de OpenCode dice 68 passed; lo verificable del entorno actual es que la suite completa pasó sin fallos.

Resultado:

- Backend: 68 passed / 0 failed (evidencia: exit 0 del conjunto completo)

### 3.3 Frontend unitario, lint, typecheck y build

Comando ejecutado:

```bash
cd /home/herman/Escritorio/restaurante/frontend
npm run test -- --run
npm run lint
npm run typecheck
npm run build
```

Evidencia observada:

- Vitest: 5 archivos, 17 tests pasados
- lint: exit 0
- typecheck: exit 0
- build: exit 0
- PWA: se generaron `dist/sw.js`, `dist/manifest.webmanifest` y `dist/workbox-*`

Resultado:

- Frontend: 17 passed / 0 failed
- Lint: OK
- Typecheck: OK
- Build PWA: OK

### 3.4 E2E

Se ejecutaron ambos flujos E2E relevantes.

#### E2E offline (verificado OK)

Comando ejecutado:

```bash
cd /home/herman/Escritorio/restaurante/frontend
npx playwright test e2e/offline.spec.ts --reporter=list
```

Evidencia observada:

- 1 prueba ejecutada
- 1 prueba pasada
- cover del caso offline de cola/idempotencia

#### E2E flujo principal (falla real)

Comando ejecutado:

```bash
cd /home/herman/Escritorio/restaurante/frontend
npm run test:e2e -- --reporter=list
```

Evidencia observada:

- 1 prueba ejecutada
- 1 prueba fallida
- fallo en `frontend/e2e/flow.spec.ts` al esperar el toast de `Listo para entregar`
- el punto exacto es la línea 72 del archivo de flujo principal

Resultado:

- E2E: 1 passed / 1 failed

Conclusión: la remediación crítica de backend está apoyada por pruebas de PostgreSQL, pero la aplicación todavía no cumple el flujo principal completo end-to-end.

## 4. Verificación de los hallazgos CRITICAL

### C-01 — Idempotencia / respuesta perdida

Status: VERIFICADO como corregido en backend y código del cliente.

Evidencia:

- `backend/tests/test_concurrency.py` ejecuta la concurrencia real y pasa
- `frontend/src/offline/queue.ts` crea y persiste el UUID antes del fetch
- `withClientId()` reusa el mismo `client_operation_id`
- `idempotencyKey` se reenvía con la misma clave en la cola
- la lógica de reintento preserva el UUID

Conclusión: el patrón del bug reportado fue corregido de forma consistente en código y validado por prueba real.

### C-02 — Pagos concurrentes sobre saldo

Status: VERIFICADO como corregido.

Evidencia:

- `backend/app/api/billing.py` bloquea el pedido con `with_for_update` antes de validar el pago
- se recalculan pendientes sobre el valor persistido
- se comprueba `split_id` contra el pedido
- la prueba `test_concurrent_payments_never_exceed_order_total` pasó

Conclusión: el sobrecobro no se reproduce en PostgreSQL real.

### C-03 — Doble pedido activo por mesa

Status: VERIFICADO como corregido.

Evidencia:

- `backend/app/models/orders.py` define el índice parcial único `uq_orders_active_dine_in_table`
- `backend/alembic/versions/0002_critical_high_integrity.py` crea ese índice en la migración
- la prueba `test_concurrent_dine_in_opening_creates_exactly_one_active_order` pasó

Conclusión: se observa protección real en PostgreSQL y no solo una validación Python.

Resultado final CRITICAL:

- CRITICAL abiertos: 0
- CRITICAL verificados: 3/3

## 5. Verificación de los hallazgos HIGH

### H-01 — Cola detenida en SENDING

Status: VERIFICADO como corregido en la capa de cola.

Evidencia:

- `frontend/src/offline/queue.ts` procesa `LOCAL_PENDING`, recurre en `NetworkError` y devuelve a `LOCAL_PENDING`
- `retryOperation()` reintenta sin cambiar UUID
- la prueba offline pasa con reintento real

Conclusión: la recuperación de la cola queda cubierta por la prueba de regresión.

### H-02 / H-03 — RBAC y acceso cruzado

Status: VERIFICADO en backend por suite.

Evidencia:

- `backend/tests/test_orders.py` y `backend/tests/test_billing.py` pasan en el suite completa
- el código de autorización por recurso y área queda commitado en el backend
- los endpoints de lectura de pedidos, pagos y gastos exigen rol/propiedad en `billing.py` y `orders.py`

Conclusión: los controles de RBAC del backend quedaron implementados y la suite completa respalda la corrección.

### H-04 — Cierre de turno serializado con mutaciones

Status: VERIFICADO como corregido en la prueba real de concurrencia.

Evidencia:

- `backend/tests/test_concurrency.py::test_shift_close_serializes_with_order_creation` pasa
- la operación de cierre y la creación de pedido comparten el bloqueo del turno/pedido dentro de la transacción

Conclusión: el cierro no acepta operaciones semánticamente posteriores al cierre.

### H-05 — WebSocket y despliegue V1

Status: PARCIALMENTE VERIFICADO, pero con requisito operativo abierto.

Lo confirmado en código:

- `backend/app/api/ws.py` no envía el JWT por URL
- el primer mensaje del WS trae el token autenticado
- hay validación de `Origin` con `CORS_ORIGINS`
- el `timeout` de autenticación existe (`asyncio.wait_for`)
- el cliente no expone el JWT en query string

Lo que sigue siendo una limitación real:

- `backend/app/ws/hub.py` es un hub en memoria
- no hay broker compartido, ni persistencia del hub
- la documentación de despliegue lo marca explícitamente como V1 de una sola instancia / un solo worker

Esto significa que la solución es solo segura operativamente cuando el entorno no escala a múltiples workers ni instancias. Si la configuración de despliegue permite `--workers` o varios procesos, el hallazgo queda abierto como riesgo de operación real.

Conclusión: el código cumple la defensa básica, pero la arquitectura V1 sigue siendo un límite estructural de un solo proceso; no es una solución multiinstancia.

### H-06 — Comprobantes y uploads

Status: VERIFICADO como corregido.

Evidencia:

- `backend/app/api/receipts.py` valida MIME, extensión y firma
- `backend/tests/test_receipts_security.py` confirma rechazo de PNG falso y aceptación de PNG real
- `backend/app/config.py` exige `JWT_SECRET` y `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` fuera de desarrollo

Conclusión: la validación del contenido y la configuración de producción quedó reforzada.

### H-07 — Configuración insegura y rate limit preventivo

Status: VERIFICADO como corregido.

Evidencia:

- `backend/app/config.py` lanza error si `ENVIRONMENT` distinto de desarrollo/test tiene secreto débil o storage faltante
- `backend/app/core/login_rate.py` usa PostgreSQL y `pg_advisory_xact_lock` para serializar el primer fallo
- la suite de auth sigue pasando

Conclusión: la seguridad de configuración y del rate limit queda reforzada con persistencia compartida.

Resultado final HIGH:

- HIGH abiertos: 1 (H-05 queda como límite operativo de despliegue; no es multiinstancia)
- HIGH verificados: 6/7

## 6. Evaluación de MEDIUM y clasificación pilot

No se exige corrección automática de todos los MEDIUM, pero sí se clasifican por su efecto operacional. El criterio de este auditor es estricto con los elementos que pueden:

- perder pedidos,
- duplicar pedidos,
- generar cobros incorrectos,
- romper permisos,
- inutilizar cocina/meseros,
- dejar la operación insegura durante un piloto.

### M-01 — Divisiones de cuenta y validación de `split_id`

Clasificación: PILOT_BLOCKER

Riesgo: afecta cobro y reparto final.

### M-02 — Integridad de negocio depende de Python y no de PostgreSQL

Clasificación: PILOT_BLOCKER

Riesgo: la invariant de negocio crítica queda expuesta si el dato entra por otra vía o por escrituras excepcionales.

### M-03 — Eventos WebSocket emitidos antes del commit

Clasificación: FIX_BEFORE_PRODUCTION

Riesgo: la UI puede recibir eventos de datos que luego se revierten.

### M-04 — Auditoría incompleta o sin actor correcto

Clasificación: FIX_BEFORE_PRODUCTION

Riesgo: trazabilidad insuficiente para soporte operativo.

### M-05 — Tests no representan despliegue ni condiciones adversas

Clasificación: FIX_BEFORE_PRODUCTION

Riesgo: falsa confianza por suite verde incompleta.

### M-06 — `command.sequence_number` bajo concurrencia

Clasificación: PILOT_BLOCKER

Riesgo: puede afectar la secuencia y la entrega de órdenes.

### M-07 — UX offline comunica “enviada” para una comanda sólo local

Clasificación: ACCEPTABLE_FOR_PILOT

Riesgo: es un problema de UX, no de integridad monetaria.

### M-08 — Repositorio Git no inicializado en el directorio del proyecto

Clasificación: FIX_BEFORE_PRODUCTION

Riesgo: trazabilidad y seguridad del repositorio no cumplen la operación del restaurante.

## 7. PWA y estado real de instalación

Se verificó build de producción con `vite-plugin-pwa` y se generó el artefacto con manifest y service worker.

Se comprobó:

- `manifest.webmanifest` generado
- `sw.js` generado
- `start_url: "/"`
- `display: "standalone"`
- `icons` presentes
- `navigateFallback` presente

También se pudo confirmar que la revisión actual del código no hardcodea datos operativos reales de producción en el frontend y que los valores de negocio se mantienen en fixtures, seeds y tests.

Sin embargo, no fue posible certificar la instalación real en un dispositivo iPhone/Android desde este entorno. La limitación es documental y no una prueba negada del build; se requiere validación manual en dispositivo real antes del piloto.

Resultado:

- PWA: OK / OBSERVACIONES (build funcional + instalación pendiente en móvil real)

## 8. Veredicto final

### Veredicto

NO APTO PARA PRUEBA MANUAL DEL DESARROLLADOR

### Motivo principal

Aunque los tres CRITICAL se validan con pruebas Postgres reales y la mayoría de HIGH quedan cubiertos, el flujo principal completo de la experiencia del restaurante falla en E2E y el diseño actual de WebSocket exige un despliegue V1 de una sola instancia/worker para ser seguro.

Esto significa que no se puede declarar la aplicación como lista para prueba manual del desarrollador en condiciones reales del restaurante.

### Estado final en formato de resumen

- CRITICAL abiertos: 0
- HIGH abiertos: 1 (operativo: H-05, V1 de un solo worker)
- MEDIUM PILOT_BLOCKER: 3
- Backend: 68 passed / 0 failed
- Frontend: 17 passed / 0 failed
- E2E: 1 passed / 1 failed
- PostgreSQL concurrency: 4 passed / 0 failed
- Alembic: OK
- PWA: OK / OBSERVACIONES
- Veredicto: NO APTO PARA PRUEBA MANUAL DEL DESARROLLADOR

## 9. Observación final

Lo que sí quedó validado es que la capa de integridad crítica del backend está muy mejorada y que la cola offline / idempotencia en red intermitente quedó reforzada. Por contra, el sistema no está aún listo para pasar a una validación manual real del restaurante porque la experiencia total del flujo operativo no termina de sostenerse en E2E y la arquitectura WebSocket no escala a múltiples procesos.

La recomendación para el siguiente paso no es una corrección masiva al azar, sino una segunda revisión orientada a:

1. recuperar con fiabilidad el flujo principal E2E,
2. forzar la restricción de despliegue V1 para WebSocket, y
3. resolver los MEDIUM PILOT_BLOCKER antes de abrir manuales de restaurante.
