import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { menuApi, ordersApi, tablesApi } from "../../api/endpoints";
import { Icon } from "../../components/Icon";
import { ConfirmDialog, Modal } from "../../components/Modal";
import { EmptyState, SearchField, SkeletonList, StatusBadge } from "../../components/Layout";
import { formatElapsed, money, useElapsed } from "../../hooks/useElapsed";
import { AREA_NAME, ITEM_STATUS, ORDER_STATUS, TASK_STATUS } from "../../lib/labels";
import { ApiError } from "../../api/client";
import { errorMessage, sendOrQueue } from "../../lib/send";
import { enqueue } from "../../offline/queue";
import type { MenuItem, Order, OrderItem, QueuedOperation } from "../../types/api";
import { usePendingOrders } from "../../stores/pendingOrders";
import { useQueue } from "../../stores/queue";
import { useTableDrafts } from "../../stores/tableDrafts";
import { useUi } from "../../stores/ui";

interface CartLine {
  item: MenuItem;
  quantity: number;
  notes: string;
}

function resolveMenuImageUrl(imageUrl: string): string {
  return new URL(imageUrl, import.meta.env.VITE_API_URL || window.location.origin).toString();
}

const URGENCY: Record<string, number> = { READY: 0, PREPARING: 1, PENDING: 2, DELIVERED: 3, CANCELLED: 4 };

/** Operación local (cola) que afecta a un plato: se muestra como pendiente, nunca como confirmada. */
function localItemNote(op: QueuedOperation | undefined, item: OrderItem): { label: string; tone: string; blocking: boolean } | null {
  // El estado del servidor manda: si el plato ya terminó, un aviso local atrasado no lo contradice.
  if (!op || item.status === "CANCELLED" || item.status === "DELIVERED") return null;
  const action = op.operation_type === "CANCEL_ORDER_ITEM" ? "Cancelación" : "Entrega";
  if (op.status === "SYNC_ERROR") return { label: `${action} no aplicada`, tone: "danger", blocking: false };
  if (op.status === "SENDING") return { label: `${action}: enviando…`, tone: "info", blocking: true };
  return { label: `${action} pendiente de envío`, tone: "warning", blocking: true };
}

/** Un plato del pedido con su avance real (por área cuando se prepara en más de una). */
function OrderLine({ item, commandNumber, localOp, canCancel, onStatus, onCancel }: {
  item: OrderItem; commandNumber: number; localOp?: QueuedOperation; canCancel: boolean;
  onStatus: (item: OrderItem, status: string) => void; onCancel: (item: OrderItem) => void;
}) {
  const local = localItemNote(localOp, item);
  const actionable = !local?.blocking;
  const elapsed = useElapsed(item.preparation_started_at ?? item.created_at);
  const expectedSeconds = (item.expected_prep_minutes_snapshot ?? 0) * 60;
  const open = item.status === "PENDING" || item.status === "PREPARING";
  const late = expectedSeconds > 0 && elapsed > expectedSeconds && open;
  const status = ITEM_STATUS[item.status];
  const live = (item.tasks ?? []).filter((task) => task.status !== "CANCELLED");
  const total = item.quantity * Number(item.unit_price_snapshot);

  return (
    <li className={`order-line status-${item.status.toLowerCase()}`}>
      <span className="qty">×{item.quantity}</span>
      <div className="name">
        <div className="line-title">{item.menu_item_name_snapshot}</div>
        {item.notes ? <div className="hint">“{item.notes}”</div> : null}
        <div className="row wrap" style={{ gap: "var(--s2)", marginTop: 6 }}>
          <StatusBadge label={status.label} tone={status.tone} icon={status.icon} />
          {open && item.requires_preparation ? <span className={`timer ${late ? "late" : ""}`} title="Tiempo de preparación">{formatElapsed(elapsed)}</span> : null}
          {local ? <span className={`chip ${local.tone}`} data-testid="local-item-state"><Icon name="cloud" />{local.label}</span> : null}
          {live.length > 1 && item.status !== "DELIVERED"
            ? live.map((task) => (
                <span key={task.id} className={`chip ${task.status === "READY" ? "success" : task.status === "PREPARING" ? "info" : ""}`}>
                  {AREA_NAME[task.area]}: {TASK_STATUS[task.status].label.toLowerCase()}
                </span>
              ))
            : null}
        </div>
        <div className="row wrap" style={{ marginTop: 8 }}>
          {actionable && item.status === "READY" && item.requires_preparation ? (
            <button className="btn success small" onClick={() => onStatus(item, "DELIVERED")}><Icon name="check" />Entregado</button>
          ) : null}
          {actionable && item.status === "PENDING" && !item.requires_preparation ? (
            <button className="btn success small" onClick={() => onStatus(item, "DELIVERED")}><Icon name="check" />Entregado</button>
          ) : null}
          {actionable && canCancel && item.status === "PENDING" ? (
            <button className="btn ghost small" onClick={() => onCancel(item)}>Cancelar</button>
          ) : null}
          <span className="hint" style={{ marginLeft: "auto" }}>Comanda #{commandNumber}</span>
        </div>
      </div>
      <strong className="num">{money(item.line_total ?? total)}</strong>
    </li>
  );
}

export function TableOrderPage() {
  const { tableId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useUi((state) => state.toast);
  const pendingRecord = usePendingOrders((state) => state.records.find((r) => r.table_id === tableId && !r.server_order_id && !r.error));
  const failedRecord = usePendingOrders((state) => state.records.find((r) => r.table_id === tableId && !r.server_order_id && r.error));
  const syncedRecord = usePendingOrders((state) => state.records.find((r) => r.table_id === tableId && r.server_order_id));
  const operations = useQueue((state) => state.operations);
  const addPending = usePendingOrders((state) => state.add);
  const draft = useTableDrafts((state) => state.drafts[tableId]);
  const discardDraft = useTableDrafts((state) => state.discard);

  const menu = useQuery({ queryKey: ["menu"], queryFn: menuApi.get });
  const orders = useQuery({ queryKey: ["orders", "active"], queryFn: () => ordersApi.active(), refetchInterval: 15000, retry: false });
  const tables = useQuery({ queryKey: ["tables"], queryFn: tablesApi.list });

  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [orderNotes, setOrderNotes] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState<OrderItem | null>(null);
  const [chosenView, setChosenView] = useState<"menu" | "order" | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const removePending = usePendingOrders((state) => state.remove);

  const order = useMemo(() => orders.data?.find((o) => o.table_id === tableId), [orders.data, tableId]);
  // Un pedido pagado sigue visible para entregar lo pendiente, pero el servidor ya no admite comandas ni cancelaciones.
  const acceptsCommands = !order || order.status !== "PAID";
  const localRecord = pendingRecord ?? failedRecord;
  const localCommands = useMemo(() => operations.filter((op) => op.status !== "SYNCED" && (
    (localRecord && (op.client_operation_id === localRecord.operation_id || op.parent_operation_id === localRecord.operation_id))
    || (order && op.operation_type === "CREATE_COMMAND" && op.path === `/api/v1/orders/${order.id}/commands`)
  )), [localRecord, operations, order]);
  const itemOperations = useMemo(() => {
    const byItem = new Map<string, QueuedOperation>();
    if (!order) return byItem;
    const pattern = new RegExp(`^/api/v1/orders/${order.id}/items/([^/]+)/(cancel|status)$`);
    for (const op of operations) {
      const match = op.status !== "SYNCED" ? pattern.exec(op.path) : null;
      if (match) byItem.set(match[1], op);
    }
    return byItem;
  }, [operations, order]);
  const menuById = useMemo(() => new Map((menu.data?.items ?? []).map((item) => [item.id, item])), [menu.data]);
  const activeCategory = categoryId ?? menu.data?.categories[0]?.id ?? null;
  const visibleItems = (menu.data?.items ?? []).filter((item) => {
    const matchesCategory = search.trim() ? true : item.category_id === activeCategory;
    const matchesSearch = !search.trim() || `${item.name} ${item.description ?? ""}`.toLocaleLowerCase("es-PE").includes(search.trim().toLocaleLowerCase("es-PE"));
    return item.is_active && matchesCategory && matchesSearch;
  });
  const table = localRecord?.table_name ?? order?.table_name ?? draft?.table_name ?? "Mesa";
  // Si la mesa ya tiene pedido (enviado desde aquí o por otro mesero), el borrador local deja de tener sentido.
  useEffect(() => {
    if (draft && (order || localRecord)) discardDraft(draft.table_id);
  }, [draft, order, localRecord, discardDraft]);
  const [releasing, setReleasing] = useState(false);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const cartUnits = cart.reduce((sum, line) => sum + line.quantity, 0);
  const cartSubtotal = cart.reduce((sum, line) => sum + Number(line.item.price) * line.quantity, 0);
  const cartUnitLabel = `${cartUnits} ${cartUnits === 1 ? "unidad" : "unidades"}`;
  // La disponibilidad puede cambiar mientras se arma la comanda: se marca antes de enviarla.
  const unavailableIds = new Set(menu.data ? cart.filter((line) => {
    const current = menuById.get(line.item.id);
    return !current || current.availability_status === "SOLD_OUT";
  }).map((line) => line.item.id) : []);

  function addToCart(item: MenuItem) {
    setCart((lines) => {
      const existing = lines.find((line) => line.item.id === item.id);
      if (existing) return lines.map((line) => (line.item.id === item.id ? { ...line, quantity: line.quantity + 1 } : line));
      return [...lines, { item, quantity: 1, notes: "" }];
    });
  }

  function setQuantity(itemId: string, quantity: number) {
    setCart((lines) =>
      quantity <= 0
        ? lines.filter((line) => line.item.id !== itemId)
        : lines.map((line) => (line.item.id === itemId ? { ...line, quantity } : line)),
    );
  }

  async function sendCommand() {
    if (cart.length === 0) return;
    setSending(true);
    try {
      const payload = {
        items: cart.map((line) => ({
          menu_item_id: line.item.id,
          quantity: line.quantity,
          notes: line.notes.trim() || null,
        })),
        notes: orderNotes.trim() || null,
      };

      let queued = false;
      if (pendingRecord) {
        await enqueue({
          operation_type: "CREATE_COMMAND",
          path: "/api/v1/orders/{orderRef}/commands",
          method: "POST",
          body: payload,
          parent_operation_id: pendingRecord.operation_id,
        });
        queued = true;
      } else if (order) {
        const outcome = await sendOrQueue(
          {
            operation_type: "CREATE_COMMAND",
            path: `/api/v1/orders/${order.id}/commands`,
            method: "POST",
            body: payload,
          },
          (clientOperationId) => ordersApi.createCommand(order.id, payload, clientOperationId),
        );
        queued = outcome.queued;
      } else if (draft) {
        // Primera comanda de una mesa recién abierta: el pedido y la comanda nacen en UNA transacción del servidor,
        // así un fallo a mitad de camino nunca deja un pedido vacío ocupando la mesa.
        const openBody = { table_id: draft.table_id, persons_count: draft.persons_count, ...payload, order_notes: null };
        const opened: { order: (Order & { command: unknown }) | null } = { order: null };
        const outcome = await sendOrQueue(
          { operation_type: "OPEN_TABLE_WITH_COMMAND", path: "/api/v1/orders/open-with-command", method: "POST", body: openBody },
          async (clientOperationId) => {
            opened.order = await ordersApi.openWithCommand(openBody, clientOperationId);
          },
        );
        if (outcome.queued && outcome.operationId) {
          // Guardado solo en este dispositivo: las siguientes comandas se encadenan a esta operación.
          addPending({
            operation_id: outcome.operationId, table_id: draft.table_id, table_name: draft.table_name,
            persons_count: draft.persons_count, created_at: Date.now(), server_order_id: null, error: null,
          });
          queued = true;
        } else if (opened.order) {
          const known: Order = opened.order;
          queryClient.setQueryData<Order[]>(["orders", "active"], (current) => [...(current ?? []).filter((entry) => entry.id !== known.id), known]);
        }
        discardDraft(draft.table_id);
      } else {
        toast("error", "No hay pedido abierto en esta mesa");
        return;
      }

      setCart([]);
      setOrderNotes("");
      setCartOpen(false);
      setConfirmSend(false);
      if (queued) {
        toast("warning", "Comanda guardada localmente", "Se enviará automáticamente al recuperar la conexión.");
      } else {
        toast("success", "Comanda enviada", `${cartUnits} unidad(es) a cocina/parrilla`);
        void queryClient.invalidateQueries({ queryKey: ["orders"] });
        void queryClient.invalidateQueries({ queryKey: ["tables"] });
      }
    } catch (error) {
      if (error instanceof ApiError && error.code === "TABLE_ALREADY_OPEN") {
        // Otro dispositivo ganó la mesa: nada se creó aquí y el carrito se conserva para reubicarlo.
        toast("error", "Esta mesa ya fue abierta por otro mesero", "Su comanda no se envió y sigue en pantalla. Elija otra mesa o pida que la liberen.");
        void queryClient.invalidateQueries({ queryKey: ["tables"] });
        void queryClient.invalidateQueries({ queryKey: ["orders"] });
      } else {
        toast("error", "No se pudo enviar la comanda", errorMessage(error));
      }
    } finally {
      setSending(false);
    }
  }

  async function retryLocalOrder() {
    if (!failedRecord) return;
    const chain = operations.filter((op) => op.client_operation_id === failedRecord.operation_id || op.parent_operation_id === failedRecord.operation_id);
    for (const op of chain) {
      if (op.status === "SYNC_ERROR") await useQueue.getState().retry(op.client_operation_id);
    }
  }

  async function discardLocalOrder() {
    if (!failedRecord) return;
    const chain = operations.filter((op) => op.client_operation_id === failedRecord.operation_id || op.parent_operation_id === failedRecord.operation_id);
    for (const op of chain) await useQueue.getState().discard(op.client_operation_id);
    removePending(failedRecord.operation_id);
    setConfirmDiscard(false);
    toast("info", `${table}: comanda local descartada`);
  }

  async function changeItemStatus(item: OrderItem, status: string) {
    if (!order) return;
    try {
      const outcome = await sendOrQueue(
        {
          operation_type: "UPDATE_ORDER_ITEM_STATUS",
          path: `/api/v1/orders/${order.id}/items/${item.id}/status`,
          method: "POST",
          body: { status },
        },
        (clientOperationId) => ordersApi.setItemStatus(order.id, item.id, status, clientOperationId),
      );
      if (!outcome.queued) {
        void queryClient.invalidateQueries({ queryKey: ["orders"] });
      }
    } catch (error) {
      toast("error", "No se pudo actualizar el producto", errorMessage(error));
    }
  }

  async function cancelItem(item: OrderItem) {
    if (!order) return;
    try {
      const outcome = await sendOrQueue(
        {
          operation_type: "CANCEL_ORDER_ITEM",
          path: `/api/v1/orders/${order.id}/items/${item.id}/cancel`,
          method: "POST",
          body: { reason: "Cancelado por mesero" },
        },
        (operationId) => ordersApi.cancelItem(order.id, item.id, "Cancelado por mesero", operationId),
      );
      if (!outcome.queued) {
        void queryClient.invalidateQueries({ queryKey: ["orders"] });
        toast("info", "Producto cancelado");
      }
    } catch (error) {
      toast("error", "No se pudo cancelar", errorMessage(error));
    } finally {
      setConfirmCancel(null);
    }
  }

  if (orders.isLoading && !orders.data) return <div className="page"><SkeletonList rows={5} height={72} label="Cargando pedido" /></div>;
  async function releaseEmptyOrder() {
    if (!order) return;
    setReleasing(true);
    try {
      await ordersApi.cancelEmpty(order.id, crypto.randomUUID());
      toast("success", `${table} liberada`, "El pedido vacío se anuló.");
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: ["tables"] });
      navigate("/mesas");
    } catch (error) {
      toast("error", "No se pudo liberar la mesa", errorMessage(error));
    } finally {
      setReleasing(false);
      setConfirmRelease(false);
    }
  }

  const syncedOp = syncedRecord ? operations.find((op) => op.client_operation_id === syncedRecord.operation_id) : undefined;
  // Recién sincronizado: hasta releer los pedidos no se afirma que la mesa está libre.
  if (!order && !localRecord && !draft && syncedRecord && orders.dataUpdatedAt < (syncedOp?.last_attempt_at ?? 0)) {
    return <div className="page"><SkeletonList rows={3} height={72} label="Confirmando el pedido con el servidor" /></div>;
  }

  const servedByOther = !order && !localRecord && !draft && Boolean(tables.data?.find((entry) => entry.id === tableId)?.order_id);
  if (servedByOther) {
    return (
      <div className="page narrow">
        <EmptyState icon="user" title="Otro mesero atiende esta mesa" hint="Solo quien abrió el pedido (o un administrador) puede modificarlo."
          action={<button className="btn secondary" onClick={() => navigate("/mesas")}><Icon name="arrowLeft" />Volver al salón</button>} />
      </div>
    );
  }

  if (!order && !localRecord && !draft) {
    return (
      <div className="page narrow">
        <EmptyState icon="chair" title="Esta mesa no tiene pedido abierto" hint="Vuelva al salón para abrir la mesa."
          action={<button className="btn secondary" onClick={() => navigate("/mesas")}><Icon name="arrowLeft" />Volver al salón</button>} />
      </div>
    );
  }

  const commandOf = new Map<string, number>();
  order?.commands.forEach((command) => command.items.forEach((item) => commandOf.set(item.id, command.sequence_number)));
  const orderLines = [...(order?.items ?? [])].sort((a, b) => URGENCY[a.status] - URGENCY[b.status]);
  const readyCount = orderLines.filter((item) => item.status === "READY").length;
  const orderStatus = order ? ORDER_STATUS[order.status] : null;
  // Pedido que quedó sin productos ni pagos (p. ej. creado por la versión anterior al abrir la mesa).
  const orderIsEmpty = Boolean(order && order.status === "OPEN" && Number(order.paid_amount) === 0
    && order.items.every((item) => item.status === "CANCELLED"));
  const activeCategoryName = menu.data?.categories.find((category) => category.id === activeCategory)?.name ?? "Productos";
  // Por defecto se muestra el pedido cuando hay algo que entregar ahora (listo, o bebida directa pendiente).
  const actionable = orderLines.some((item) => item.status === "READY" || (item.status === "PENDING" && !item.requires_preparation));
  const view = chosenView ?? (actionable || !acceptsCommands || failedRecord ? "order" : "menu");
  const quantityOf = (id: string) => cart.find((line) => line.item.id === id)?.quantity ?? 0;

  return (
    <div className={`page wide order-page view-${view} ${cartOpen ? "cart-open" : ""}`}>
      <div className="order-bar">
        <button className="btn ghost small" onClick={() => navigate("/mesas")}><Icon name="arrowLeft" />Salón</button>
        <div className="grow">
          <h1>{table}</h1>
          <div className="hint">
            {pendingRecord
              ? "Pedido guardado en este dispositivo: aún no llegó al servidor"
              : failedRecord
                ? "El pedido no llegó al servidor: revise el error"
              : !order && draft
                ? `${draft.persons_count} personas · el pedido se crea al enviar la primera comanda`
                : `${order?.persons_count ?? 0} personas`}
            {orderStatus ? <> · <StatusBadge label={orderStatus.label} tone={orderStatus.tone} icon={orderStatus.icon} /></> : null}
          </div>
        </div>
        {!order && !localRecord && draft ? (
          <button className="btn ghost" onClick={() => { discardDraft(draft.table_id); navigate("/mesas"); }}>
            <Icon name="x" />Cerrar mesa
          </button>
        ) : null}
        {orderIsEmpty ? (
          <button className="btn ghost" onClick={() => setConfirmRelease(true)} disabled={releasing}><Icon name="x" />Liberar mesa</button>
        ) : null}
        {order && !orderIsEmpty ? <button className="btn" onClick={() => navigate(`/cobro/${order.id}`)}><Icon name="money" />{order.status === "PAID" ? "Ver pago" : "Cobrar"}</button> : null}
      </div>

      {failedRecord ? (
        <div className="card local-sync-error" role="alert" data-testid="local-order-error">
          <strong>La primera comanda no se pudo registrar en el servidor</strong>
          <p className="hint">{failedRecord.error}</p>
          <div className="row">
            <button className="btn secondary" onClick={() => void retryLocalOrder()}><Icon name="refresh" />Reintentar</button>
            <button className="btn danger" onClick={() => setConfirmDiscard(true)}>Descartar</button>
          </div>
        </div>
      ) : null}

      {!acceptsCommands ? (
        <div className="ready-banner" role="status" data-testid="paid-order-notice"><Icon name="money" />
          Pedido pagado: ya no admite comandas nuevas. Entregue lo pendiente.
        </div>
      ) : null}

      {readyCount > 0 ? (
        <div className="ready-banner" role="status"><Icon name="check" />
          {readyCount === 1 ? "Hay 1 producto listo para entregar" : `Hay ${readyCount} productos listos para entregar`}
        </div>
      ) : null}

      <div className="segmented order-tabs" role="group" aria-label="Vista del pedido">
        <button className={view === "menu" ? "active" : ""} aria-pressed={view === "menu"} onClick={() => { setChosenView("menu"); setCartOpen(false); }}>Carta</button>
        <button className={view === "order" ? "active" : ""} aria-pressed={view === "order"} onClick={() => { setChosenView("order"); setCartOpen(false); }}>
          Pedido{readyCount > 0 ? <span className="count">{readyCount} listo{readyCount > 1 ? "s" : ""}</span> : null}
        </button>
      </div>

      <div className="order-layout">
        <section className="order-catalog" aria-labelledby="catalog-title">
          <div className="catalog-tools">
            <h2 id="catalog-title" className="visually-hidden">Carta</h2>
            <SearchField value={search} onChange={setSearch} label="Buscar platos y bebidas" placeholder="Buscar platos y bebidas" hotkey />
            <div className="category-tabs" role="group" aria-label="Categorías de la carta">
              {menu.data?.categories.map((category) => (
                <button key={category.id} className={category.id === activeCategory && !search.trim() ? "active" : ""}
                  aria-pressed={category.id === activeCategory && !search.trim()}
                  onClick={() => { setCategoryId(category.id); setSearch(""); }}>
                  {category.name}
                </button>
              ))}
            </div>
          </div>
          <div className="catalog-heading">
            <h3>{search.trim() ? "Resultados" : activeCategoryName}</h3>
            <span className="hint">{visibleItems.length} {visibleItems.length === 1 ? "producto" : "productos"}</span>
          </div>
          {!acceptsCommands || failedRecord ? (
            <EmptyState icon="ban" title={failedRecord ? "Resuelva primero el envío pendiente" : "El pedido ya está pagado"}
              hint={failedRecord ? "Reintente o descarte la comanda que no llegó al servidor." : "Para pedir más, abra un pedido nuevo cuando se libere la mesa."} />
          ) : menu.isLoading ? <SkeletonList rows={5} height={76} label="Cargando carta" /> : (
            <div className="menu-product-list">
              {visibleItems.map((item) => {
                const soldOut = item.availability_status === "SOLD_OUT";
                const inCart = quantityOf(item.id);
                return (
                  <div key={item.id} className={`menu-item ${soldOut ? "soldout" : ""} ${inCart ? "in-cart" : ""}`}>
                    {item.image_url ? (
                      <div className="menu-item-image">
                        <img src={resolveMenuImageUrl(item.image_url)} alt="" loading="lazy" onError={(event) => { event.currentTarget.style.display = "none"; }} />
                      </div>
                    ) : null}
                    <div className="grow menu-item-details">
                      <div className="menu-item-name">{item.name}</div>
                      {item.description ? <div className="hint clamp">{item.description}</div> : null}
                      <div className="row wrap menu-item-price-row">
                        <span className="price num">{money(item.price)}</span>
                        {soldOut ? <span className="chip danger"><Icon name="ban" />Agotado</span> : null}
                      </div>
                    </div>
                    {inCart > 0 ? (
                      <div className="qty-stepper compact">
                        <button aria-label={`Restar ${item.name}`} onClick={() => setQuantity(item.id, inCart - 1)}>−</button>
                        <span className="value" aria-live="polite">{inCart}</span>
                        <button aria-label={`Agregar ${item.name}`} onClick={() => addToCart(item)}>+</button>
                      </div>
                    ) : (
                      <button className="btn menu-add-button" aria-label={`Agregar ${item.name}`} disabled={soldOut} onClick={() => addToCart(item)}>
                        <Icon name="plus" />
                      </button>
                    )}
                  </div>
                );
              })}
              {visibleItems.length === 0 ? <EmptyState icon="search" title="No hay productos para mostrar" hint="Pruebe otra categoría o búsqueda." /> : null}
            </div>
          )}
        </section>

        <aside className="order-side">
          <section className="cart-panel card" aria-labelledby="cart-title">
            <div className="section-title">
              <h2 id="cart-title">Nueva comanda</h2>
              <button className="btn ghost small cart-back" onClick={() => setCartOpen(false)}><Icon name="arrowLeft" />Carta</button>
            </div>
            {cart.length === 0 ? (
              <p className="hint">Toque + en un producto para agregarlo. Aún no se envía nada a preparación.</p>
            ) : (
              <>
                <div className="hint" style={{ marginBottom: "var(--s2)" }}>{cartUnitLabel} · aún no enviadas a preparación</div>
                <div className="cart-line-list">
                  {cart.map((line) => (
                    <article className="cart-line" key={line.item.id}>
                      <div className="cart-line-heading">
                        <div className="grow">
                          <strong>{line.item.name}</strong><span className="num">{money(Number(line.item.price) * line.quantity)}</span>
                          {unavailableIds.has(line.item.id) ? <span className="chip danger"><Icon name="ban" />Ya no disponible</span> : null}
                        </div>
                        <div className="qty-stepper compact">
                          <button aria-label={`Restar ${line.item.name} (comanda)`} onClick={() => setQuantity(line.item.id, line.quantity - 1)}>−</button>
                          <span className="value">{line.quantity}</span>
                          <button aria-label={`Sumar ${line.item.name}`} onClick={() => setQuantity(line.item.id, line.quantity + 1)}>+</button>
                        </div>
                      </div>
                      <input
                        className="input cart-note-input"
                        aria-label={`Observación de ${line.item.name}`}
                        placeholder="Observación (ej. sin cebolla)"
                        value={line.notes}
                        onChange={(event) => setCart((lines) => lines.map((entry) => (entry.item.id === line.item.id ? { ...entry, notes: event.target.value } : entry)))}
                      />
                    </article>
                  ))}
                </div>
                <div className="field" style={{ marginTop: "var(--s3)" }}>
                  <label className="label" htmlFor="order-notes">Observaciones de la comanda</label>
                  <textarea id="order-notes" className="textarea" style={{ minHeight: "4rem" }} placeholder="Indicaciones generales (opcional)" value={orderNotes} onChange={(event) => setOrderNotes(event.target.value)} />
                </div>
                <div className="cart-subtotal"><span>Subtotal</span><strong className="num">{money(cartSubtotal)}</strong></div>
                {unavailableIds.size > 0 ? <p className="hint">Quite los productos agotados o retirados de la carta para enviar la comanda.</p> : null}
                <button data-testid="send-command" className="btn block large" onClick={() => setConfirmSend(true)} disabled={sending || cart.length === 0 || unavailableIds.size > 0 || !acceptsCommands || Boolean(failedRecord)}>
                  <Icon name="send" />Enviar comanda
                </button>
              </>
            )}
          </section>

          <section className="card order-history-card" aria-labelledby="order-title">
            <div className="section-title">
              <h2 id="order-title">Pedido</h2>
              {order ? <strong className="num">{money(order.total)}</strong> : null}
            </div>
            {localCommands.length > 0 ? (
              <ul className="order-lines local-commands" aria-label="Comandas guardadas en este dispositivo">
                {localCommands.map((op) => {
                  const body = op.body as { items?: { menu_item_id: string; quantity?: number; notes?: string | null }[] };
                  const failed = op.status === "SYNC_ERROR";
                  return (body.items ?? []).map((line, index) => (
                    <li key={`${op.client_operation_id}-${index}`} className="order-line status-pending" data-testid="local-command-line">
                      <span className="qty">×{line.quantity ?? 1}</span>
                      <div className="name">
                        <div className="line-title">{menuById.get(line.menu_item_id)?.name ?? "Producto"}</div>
                        {line.notes ? <div className="hint">“{line.notes}”</div> : null}
                        <span className={`chip ${failed ? "danger" : "warning"}`}>
                          <Icon name={failed ? "alert" : "cloud"} />{failed ? "No enviada al servidor" : "Pendiente de sincronización"}
                        </span>
                      </div>
                    </li>
                  ));
                })}
              </ul>
            ) : null}
            {!order || order.items.length === 0 ? (
              localCommands.length > 0 ? null : <EmptyState icon="receipt" title="Aún no hay productos" hint="Agregue productos desde la carta y envíe la comanda." />
            ) : (
              <>
                <ul className="order-lines">
                  {orderLines.map((item) => (
                    <OrderLine key={item.id} item={item} commandNumber={commandOf.get(item.id) ?? 1}
                      localOp={itemOperations.get(item.id)} canCancel={acceptsCommands}
                      onStatus={(i, s) => void changeItemStatus(i, s)} onCancel={(i) => setConfirmCancel(i)} />
                  ))}
                </ul>
                {order.paid_amount && Number(order.paid_amount) > 0 ? (
                  <div className="row" style={{ marginTop: "var(--s3)" }}>
                    <span className="grow hint">Pagado</span><strong className="num" style={{ color: "var(--ok)" }}>{money(order.paid_amount)}</strong>
                  </div>
                ) : null}
              </>
            )}
          </section>
        </aside>
      </div>

      {confirmDiscard && failedRecord ? (
        <ConfirmDialog
          title="Descartar comanda no enviada"
          message="La comanda guardada en este dispositivo dejará de enviarse. El servidor no la registró: la mesa queda libre."
          confirmLabel="Descartar" danger
          onConfirm={() => void discardLocalOrder()}
          onCancel={() => setConfirmDiscard(false)}
        />
      ) : null}

      {cart.length > 0 && !cartOpen && acceptsCommands ? (
        <button className="cart-quick-access" onClick={() => setCartOpen(true)}>
          <span><Icon name="orders" />Ver comanda · {cartUnitLabel}</span>
          <strong className="num">{money(cartSubtotal)}</strong>
        </button>
      ) : null}

      {confirmRelease && order ? (
        <ConfirmDialog
          title="Liberar mesa"
          message={`${table} no tiene productos ni pagos. Se anulará el pedido vacío y la mesa quedará libre. Queda registrado en la auditoría.`}
          confirmLabel="Liberar mesa"
          onConfirm={() => void releaseEmptyOrder()}
          onCancel={() => setConfirmRelease(false)}
        />
      ) : null}

      {confirmCancel && order ? (
        <ConfirmDialog
          title="Cancelar producto"
          message={`¿Cancelar ${confirmCancel.quantity} × ${confirmCancel.menu_item_name_snapshot}? Esta acción queda registrada en la auditoría.`}
          confirmLabel="Cancelar producto"
          danger
          onConfirm={() => void cancelItem(confirmCancel)}
          onCancel={() => setConfirmCancel(null)}
        />
      ) : null}

      {confirmSend ? (
        <Modal
          title="Enviar comanda"
          onClose={() => !sending && setConfirmSend(false)}
          footer={
            <>
              <button className="btn secondary grow" onClick={() => setConfirmSend(false)} disabled={sending}>Cancelar</button>
              <button className="btn grow" onClick={() => void sendCommand()} disabled={sending}>{sending ? "Enviando…" : "Confirmar envío"}</button>
            </>
          }
        >
          <div className="stack" style={{ gap: "var(--s3)" }}>
            <ul className="confirm-list">
              {cart.map((line) => (
                <li key={line.item.id}><span><strong>{line.quantity}×</strong> {line.item.name}{line.notes.trim() ? <em> — {line.notes.trim()}</em> : null}</span><span className="num">{money(Number(line.item.price) * line.quantity)}</span></li>
              ))}
            </ul>
            <div className="row"><span className="grow">{table} · {order?.persons_count ?? localRecord?.persons_count ?? draft?.persons_count ?? 0} personas</span><strong className="num">{money(cartSubtotal)}</strong></div>
            <p className="hint">Se enviará a las áreas de preparación correspondientes.</p>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
