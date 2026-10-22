import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { menuApi, ordersApi } from "../../api/endpoints";
import { Icon } from "../../components/Icon";
import { ConfirmDialog, Modal } from "../../components/Modal";
import { EmptyState, SearchField, SkeletonList, StatusBadge } from "../../components/Layout";
import { formatElapsed, money, useElapsed } from "../../hooks/useElapsed";
import { AREA_NAME, ITEM_STATUS, ORDER_STATUS, TASK_STATUS } from "../../lib/labels";
import { errorMessage, sendOrQueue } from "../../lib/send";
import { enqueue } from "../../offline/queue";
import type { MenuItem, OrderItem } from "../../types/api";
import { usePendingOrders } from "../../stores/pendingOrders";
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

/** Un plato del pedido con su avance real (por área cuando se prepara en más de una). */
function OrderLine({ item, commandNumber, onStatus, onCancel }: {
  item: OrderItem; commandNumber: number; onStatus: (item: OrderItem, status: string) => void; onCancel: (item: OrderItem) => void;
}) {
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
          {live.length > 1 && item.status !== "DELIVERED"
            ? live.map((task) => (
                <span key={task.id} className={`chip ${task.status === "READY" ? "success" : task.status === "PREPARING" ? "info" : ""}`}>
                  {AREA_NAME[task.area]}: {TASK_STATUS[task.status].label.toLowerCase()}
                </span>
              ))
            : null}
        </div>
        <div className="row wrap" style={{ marginTop: 8 }}>
          {item.status === "READY" && item.requires_preparation ? (
            <button className="btn success small" onClick={() => onStatus(item, "DELIVERED")}><Icon name="check" />Entregado</button>
          ) : null}
          {item.status === "PENDING" && !item.requires_preparation ? (
            <button className="btn success small" onClick={() => onStatus(item, "DELIVERED")}><Icon name="check" />Entregado</button>
          ) : null}
          {item.status === "PENDING" ? (
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

  const menu = useQuery({ queryKey: ["menu"], queryFn: menuApi.get });
  const orders = useQuery({ queryKey: ["orders", "active"], queryFn: () => ordersApi.active(), refetchInterval: 15000, retry: false });

  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [cart, setCart] = useState<CartLine[]>([]);
  const [cartOpen, setCartOpen] = useState(false);
  const [orderNotes, setOrderNotes] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmSend, setConfirmSend] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState<OrderItem | null>(null);
  const [chosenView, setChosenView] = useState<"menu" | "order" | null>(null);

  const order = useMemo(() => orders.data?.find((o) => o.table_id === tableId), [orders.data, tableId]);
  const activeCategory = categoryId ?? menu.data?.categories[0]?.id ?? null;
  const visibleItems = (menu.data?.items ?? []).filter((item) => {
    const matchesCategory = search.trim() ? true : item.category_id === activeCategory;
    const matchesSearch = !search.trim() || `${item.name} ${item.description ?? ""}`.toLocaleLowerCase("es-PE").includes(search.trim().toLocaleLowerCase("es-PE"));
    return item.is_active && matchesCategory && matchesSearch;
  });
  const table = pendingRecord?.table_name ?? order?.table_name ?? "Mesa";
  const cartUnits = cart.reduce((sum, line) => sum + line.quantity, 0);
  const cartSubtotal = cart.reduce((sum, line) => sum + Number(line.item.price) * line.quantity, 0);
  const cartUnitLabel = `${cartUnits} ${cartUnits === 1 ? "unidad" : "unidades"}`;

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
      toast("error", "No se pudo enviar la comanda", errorMessage(error));
    } finally {
      setSending(false);
    }
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
      }
      toast("info", "Producto cancelado");
    } catch (error) {
      toast("error", "No se pudo cancelar", errorMessage(error));
    } finally {
      setConfirmCancel(null);
    }
  }

  if (orders.isLoading && !orders.data) return <div className="page"><SkeletonList rows={5} height={72} label="Cargando pedido" /></div>;
  if (!order && !pendingRecord) {
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
  const activeCategoryName = menu.data?.categories.find((category) => category.id === activeCategory)?.name ?? "Productos";
  // Por defecto se muestra el pedido cuando hay algo que entregar ahora (listo, o bebida directa pendiente).
  const actionable = orderLines.some((item) => item.status === "READY" || (item.status === "PENDING" && !item.requires_preparation));
  const view = chosenView ?? (actionable ? "order" : "menu");
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
              : `${order?.persons_count ?? 0} personas`}
            {orderStatus ? <> · <StatusBadge label={orderStatus.label} tone={orderStatus.tone} icon={orderStatus.icon} /></> : null}
          </div>
        </div>
        {order ? <button className="btn" onClick={() => navigate(`/cobro/${order.id}`)}><Icon name="money" />Cobrar</button> : null}
      </div>

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
          {menu.isLoading ? <SkeletonList rows={5} height={76} label="Cargando carta" /> : (
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
                        <div className="grow"><strong>{line.item.name}</strong><span className="num">{money(Number(line.item.price) * line.quantity)}</span></div>
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
                <button data-testid="send-command" className="btn block large" onClick={() => setConfirmSend(true)} disabled={sending || cart.length === 0}>
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
            {!order || order.items.length === 0 ? (
              <EmptyState icon="receipt" title="Aún no hay productos" hint="Agregue productos desde la carta y envíe la comanda." />
            ) : (
              <>
                <ul className="order-lines">
                  {orderLines.map((item) => (
                    <OrderLine key={item.id} item={item} commandNumber={commandOf.get(item.id) ?? 1}
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

      {cart.length > 0 && !cartOpen ? (
        <button className="cart-quick-access" onClick={() => setCartOpen(true)}>
          <span><Icon name="orders" />Ver comanda · {cartUnitLabel}</span>
          <strong className="num">{money(cartSubtotal)}</strong>
        </button>
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
            <div className="row"><span className="grow">{table} · {order?.persons_count ?? pendingRecord?.persons_count ?? 0} personas</span><strong className="num">{money(cartSubtotal)}</strong></div>
            <p className="hint">Se enviará a las áreas de preparación correspondientes.</p>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
