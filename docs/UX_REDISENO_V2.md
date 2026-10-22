# Rediseño UX/UI «Brasa» — Restaurante V2

Rama: `feature/ux-ui-premium-v2` (desde `main`). Alcance: **solo frontend**. No se tocó `backend/`, migraciones,
contratos REST, autenticación, permisos, lógica financiera, estados de preparación, concurrencia, cola offline,
WebSocket ni Web Push (comprobado con `git diff --name-only main` al final de este documento).

## 1. Auditoría UX inicial

Evidencia: capturas reales por rol en escritorio y móvil antes del cambio (`docs/ux-v2/comparacion/`, columna izquierda).

| # | Hallazgo | Impacto en el trabajo | Dónde |
|---|---|---|---|
| 1 | En escritorio la barra de navegación inferior flotaba **encima del contenido** (tapaba títulos y botones: «Carta», «Agotados»). El layout era una columna móvil estirada a 1170 px. | Controles tapados; mucho desplazamiento; sin densidad. | Todas las pantallas ≥ 900 px |
| 2 | Sin navegación de escritorio: el administrador tenía 5 pestañas y «Más» para llegar a 8 destinos (Carta, Usuarios, Turnos, Historial…). | 2–3 toques extra para tareas frecuentes; funciones difíciles de encontrar. | Admin |
| 3 | Estados internos visibles como código: `IN_PREPARATION`, `OPEN`, `READY`. | El mesero debe interpretar jerga; el estado no «dice» qué hacer. | Pedidos, mesa, cobro |
| 4 | Iconografía mixta: emojis (💳 🟡 🔵 🍽️ ✕) más SVG. Los emojis cambian por dispositivo y no heredan color/contraste. | Incoherencia visual; estados que dependen del color del emoji. | Casi todo |
| 5 | Cocina/parrilla: texto pequeño (≈ 15 px), temporizador secundario, botones de 36–44 px, sin orden por urgencia. Un plato atrasado podía estar al final. | Más lectura y más errores de toque con manos ocupadas; se detecta tarde lo atrasado. | Tablero |
| 6 | El avance de un plato multiárea se leía como dos chips sueltos («Parrilla: pendiente» + «Esperando a Parrilla»), repetidos a nivel de comanda y de tarea. | Información repetida, difícil distinguir «mi parte lista» de «plato listo». | Tablero |
| 7 | Mesero: la comanda y el seguimiento competían en una sola columna; no había forma de ver lo **entregable ahora**. Cantidades solo editables en el carrito. | Más desplazamiento y toques; lo urgente (listo para entregar) quedaba enterrado. | Mesa |
| 8 | Carta (98+ productos): lista plana por categoría sin búsqueda, sin filtro de disponibilidad, con bloques enormes. | Encontrar y editar un producto exigía recorrer toda la carta. | Admin / Carta |
| 9 | Formularios: etiquetas sin `for`/`id`, grupos sin nombre accesible, PIN solo con teclado en pantalla (el administrador con teclado físico no podía teclearlo). | Teclado y lectores de pantalla poco usables. | Login, formularios |
| 10 | `Modal` re-ejecutaba su efecto en cada render y **robaba el foco** mientras se escribía; no devolvía el foco al cerrar; Tab escapaba del diálogo. | Campos que pierden el foco; navegación por teclado rota. | Todos los modales |
| 11 | `viewport` con `user-scalable=no`/`maximum-scale=1`; manifiesto fijado a vertical. | Bloquea el zoom (accesibilidad) y la orientación horizontal de tablets de cocina. | PWA |
| 12 | Estado de conexión/sincronización como textos pequeños y ocultos en móvil; «sincronizado» con ✓ sin aclarar qué había quedado solo en el dispositivo. | Riesgo de creer que algo llegó al servidor. | Cabecera |
| 13 | Cerrar sesión con un solo toque en el avatar. | Cierres accidentales a mitad de servicio. | Cabecera |
| 14 | Pedidos pagados/cancelados: el cobro mostraba «Pedido pagado» ante cualquier saldo 0. | Mensaje incorrecto en pedidos cancelados. | Cobro |

## 2. Sistema de diseño «Brasa»

Dirección: carbón cálido + **un único acento, la brasa**, y un motivo propio del oficio: la **comanda (ticket)**
—borde de estado a la izquierda, línea de corte punteada, tiempos grandes— usada en cocina, pedidos y en la línea de
corte del ingreso. La audacia se concentra ahí; el resto es sobrio.

- **Color** (tokens en `src/styles/tokens.css`): Hollín `#121110` (fondo), Plancha `#1b1a18` (panel), Hierro `#252320`
  (elevado), Cal `#f3eee6` (texto), Brasa `#ff7a1a` (acento). Estados: Jade `#46d9a4` (listo), Azul `#70b8ff` (en curso),
  Ámbar `#f3bb4c` (espera), Coral `#ff6f62` (atraso/error). Contraste verificado ≥ 4,5:1 (texto 5,1–15,1; botón sobre
  brasa 7,3).
- **Tipografía**: *Bricolage Grotesque* (títulos, cifras, temporizadores; carácter propio, cifras tabulares) +
  *Instrument Sans* (interfaz). Autoalojadas con `@fontsource-variable` (≈ 110 kB en total, precacheadas por el service
  worker; cumple la CSP `'self'` y funciona offline).
- **Espaciado** base 4 px (`--s1…--s12`), **radios** por jerarquía (control 10, panel 14, ticket 10), **una sola sombra**
  solo para elementos flotantes. Sin gradientes decorativos.
- **Estados sin depender del color**: `StatusBadge` = icono + texto; el temporizador de cocina combina barra, número y
  texto «atrasado».
- **Movimiento**: transiciones de 110–180 ms, solo como respuesta a una acción (modal, toque, cambio de estado); skeletons
  con la forma del contenido; `prefers-reduced-motion` anula todo (`--dur: 0ms`).
- **Densidad adaptativa**: `--hit` = 44 px en táctil y 38 px con mouse en pantallas ≥ 900 px.

Componentes compartidos (`src/components/`): `Icon` (40 iconos de línea), `PageHeader`, `StatusBadge`, `SearchField`
(atajo `/`), `SkeletonList`, `EmptyState` (con icono y acción), `Kpi`, `Modal` (foco contenido, retorno de foco, bloqueo de
scroll, hoja inferior en móvil), `Toasts`. Etiquetas centralizadas en `src/lib/labels.ts` (estados, áreas, métodos, roles).
Estilos en `src/styles/{tokens,base,shell,components,pages}.css`.

## 3. Decisiones principales y por qué

1. **Barra lateral + cabecera de contexto en escritorio** (barra inferior solo < 900 px; iconos en 900–1199 px). Elimina el
   solape (#1), pone los 12 destinos del administrador a un clic (#2) y muestra el turno y la conexión siempre.
2. **Panel operativo con datos reales**: ventas, gastos, neto, mesas ocupadas, pedidos con algo para entregar, pedidos por
   cobrar y tareas en cocina/parrilla (de los endpoints existentes), cada tarjeta lleva a su pantalla. Barras de
   participación por método de pago y mesero. No hay gráficos decorativos ni datos inventados.
3. **Cocina y parrilla**: tipografía de 26–28 px para el plato, cantidad en brasa, botón principal de 56 px a todo el
   ancho, **barra de «calor»** contra el tiempo estimado, orden por urgencia (atrasadas → en curso → pendientes → listas
   esperando), contadores por estado y, en multiárea, el progreso de cada área con la nota «Su parte está lista.
   Esperando a Parrilla» (nunca confundible con plato completo). Una acción (Empezar / Listo) por tarea; confirmación solo
   al cancelar el plato completo.
4. **Mesero**: en escritorio, carta y panel «Nueva comanda + Pedido» lado a lado (la comanda siempre visible); en móvil,
   alternador Carta/Pedido que abre por defecto en *Pedido* cuando hay algo para entregar. Cantidad con − / + sobre la
   propia tarjeta del producto (menos toques), búsqueda con `/`, categorías en píldoras. El pedido se ordena por
   urgencia (listos primero) y cada plato muestra su avance real por área. El salón resume cada mesa con lo accionable
   («2 listos», «1 preparando») y diferencia «Sin enviar» (solo en el dispositivo).
5. **Cobro**: resumen Total / Pagado / Pendiente en un bloque fijo y un único botón «Cobrar S/ …»; método en cuadrícula
   de 3 columnas; sin divisiones. Mantiene la verificación de pagos con respuesta perdida. Un pedido cancelado dice
   «Pedido cancelado», no «pagado».
6. **Carta**: carril de categorías con conteos, búsqueda global, filtro de disponibilidad, filas densas con precio y
   resumen de preparación («Preparar alitas (parrilla 12 min) + Preparar papas (cocina 7 min)»), edición en modal ancho con
   la sección «Preparación del producto».
7. **Usuarios, turnos, reportes, historial, gastos, compras**: `PageHeader` coherente; tablas con cabecera fija y cifras
   tabulares; reportes con rangos rápidos (Hoy / 7 días / Este mes / Todo) y barras de participación; historial en tabla;
   confirmación para deshabilitar usuarios y cerrar turno; ayuda de permisos por rol en el formulario de usuario.
8. **Offline y tiempo real**: indicadores de conexión y sincronización siempre visibles (etiqueta completa en tablet y
   escritorio; «Sin conexión» se muestra incluso en móvil). La píldora «n por enviar» aclara en su ayuda que está
   «guardada solo en este dispositivo»; los errores de sincronización explican que **el servidor no las recibió**. Las
   tarjetas de pedidos y mesas distinguen «Sin enviar». No se modificó la cola, el WebSocket ni los avisos únicos de
   finalización.
9. **Accesibilidad**: enlace «Saltar al contenido», `main` enfocable, `aria-pressed` en filtros, grupos con nombre,
   etiquetas con `for`/`id`, PIN escribible (el teclado en pantalla se conserva), cuenta con menú de confirmación antes de
   cerrar sesión, zoom permitido, orientación libre. Corregida la pérdida de foco del `Modal`.

## 4. Comparación visual antes / después

`docs/ux-v2/comparacion/` (izquierda = antes, derecha = después):
`admin-panel-escritorio`, `admin-carta-escritorio`, `cocina-comandas-escritorio`, `mesero-salon-escritorio`,
`cobro-escritorio`, `login-escritorio`, `mesero-detalle-mesa-movil`, `cocina-comandas-movil`, `mesero-pedidos-movil`,
`admin-panel-movil`. Capturas finales por rol y dispositivo (escritorio 1440, tablet 768, horizontal 900×420, móvil 390):
`docs/ux-v2/capturas/`. Se generan con `SHOTS_DIR=<carpeta> npx playwright test e2e/screenshots.spec.ts`
(`SHOTS_VIEWPORTS` opcional); la prueba se omite si no se define `SHOTS_DIR`.

## 5. Validación

- Vitest, TypeScript, ESLint y build: ver resultados en el informe final de la entrega.
- Playwright (móvil 390 y escritorio): flujo principal, offline, plato compartido, pago anticipado y la nueva
  `e2e/ux.spec.ts`: acceso directo y recarga de `/admin/mesas`, `/carta`, `/usuarios`, `/reportes`, `/historial`
  (y redirección de un rol sin permiso); ingreso solo con teclado; modal (foco al escribir, Tab/Shift+Tab contenidos, Esc,
  retorno de foco); atajo `/`; zoom permitido y movimiento reducido; **sin desbordamiento horizontal** en 13+3+3 rutas por
  rol a 1920, 1440, 1024, 768, 430 y 360 px con datos reales; barra lateral vs. inferior según ancho; indicador sin
  conexión.
- La prueba de 360 px detectó un desbordamiento real (rejilla con ancho mínimo 22 rem) que se corrigió con
  `minmax(min(22rem, 100%), 1fr)`.

## 6. Riesgos y limitaciones

- El rediseño cambia textos y roles accesibles de varios botones («Nuevo producto», «Editar <producto>», «Restar … (comanda)»);
  las pruebas se actualizaron, pero cualquier automatización externa debe revisarse.
- `matchMedia('(pointer: fine)')` decide el enfoque inicial del campo de usuario en el ingreso (evita abrir el teclado táctil
  encima del teclado numérico).
- La cola offline sigue sin mostrar el contenido de cada operación pendiente (solo conteo y errores): requiere un cambio de
  diseño de datos no contemplado aquí.
- Las capturas usan datos de prueba de la base E2E (no producción).
- No se ensayó en dispositivos físicos (iOS Safari, tabletas de cocina): la validación fue con Chromium emulando tamaños y
  puntero táctil/fino.

## 7. Recomendaciones futuras (requieren backend o decisiones de producto)

1. Tiempo estimado de preparación por pedido y *promesa de entrega* para el mesero (hoy solo hay tiempos por tarea).
2. Notas del plato visibles también como «alergias» destacadas (campo estructurado).
3. Filtros y paginación en el servidor para `reportes` e historial de turnos largos.
4. Asignación de mesero a mesa y transferencia de mesas.
5. Una vista de «cola offline» legible (qué operación, cuándo, reintento selectivo) con un endpoint de verificación de
   idempotencia.
6. Modo pantalla completa de cocina (TV) con sonido configurable por área.
