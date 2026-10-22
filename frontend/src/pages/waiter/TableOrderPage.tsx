import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { menuApi, ordersApi } from "../../api/endpoints";
import { ConfirmDialog, Modal } from "../../components/Modal";
import { EmptyState, Spinner } from "../../components/Layout";
import { formatElapsed, money, useElapsed } from "../../hooks/useElapsed";
import { errorMessage, sendOrQueue } from "../../lib/send";
import { enqueue } from "../../offline/queue";
import type { MenuItem, Order, OrderItem } from "../../types/api";
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

function ItemRow({
  item,
  order,
  onStatus,
  onCancel,
}: {
  item: OrderItem;
  order: Order;
  onStatus: (item: OrderItem, status: string) => void;
  onCancel: (item: OrderItem) => void;
}) {
  const elapsed = useElapsed(item.preparation_started_at ?? item.created_at);
  const expectedSeconds = (item.expected_prep_minutes_snapshot ?? 0) * 60;
  const late = expectedSeconds > 0 && elapsed > expectedSeconds && item.status !== "DELIVERED" && item.status !== "CANCELLED";

  return (
    <div className="item-row">
      <span className="qty">×{item.quantity}</span>
      <div className="name">
        <div style={{ fontWeight: 700 }}>{item.menu_item_name_snapshot}</div>
        {item.notes ? <div className="hint">“{item.notes}”</div> : null}
        <div className="row wrap" style={{ marginTop: 6 }}>
          <StatusChip status={item.status} />
          <span className={`timer ${late ? "late" : ""}`}>{formatElapsed(elapsed)}</span>
          {item.tasks && item.tasks.length > 1 && item.status !== "CANCELLED" && item.status !== "DELIVERED"
            ? item.tasks.map((task) => (
                <span key={task.id} className={`chip ${task.status === "READY" ? "success" : ""}`}>
                  {task.area === "GRILL" ? "Parrilla" : "Cocina"}: {task.status === "READY" ? "listo" : task.status === "PREPARING" ? "preparando" : "pendiente"}
                </span>
              ))
            : null}
          {item.status === "PENDING" ? (
            <button className="btn ghost small" onClick={() => onCancel(item)}>
              Cancelar
            </button>
          ) : null}
          {item.status === "READY" && item.requires_preparation ? (
            <button className="btn success small" onClick={() => onStatus(item, "DELIVERED")}>
              Entregado ✓
            </button>
          ) : null}
          {item.status === "PENDING" && !item.requires_preparation ? (
            <button className="btn success small" onClick={() => onStatus(item, "DELIVERED")}>
              Entregado ✓
            </button>
          ) : null}
        </div>
      </div>
      <strong>{money(item.line_total ?? Number(item.unit_price_snapshot) * item.quantity)}</strong>
      {order.status === "PAID" || order.status === "CLOSED" ? null : null}
    </div>
  );
}

function StatusChip({ status }: { status: string }) {
  const map: Record<string, { cls: string; label: string }> = {
    PENDING: { cls: "warning", label: "pendiente" },
    PREPARING: { cls: "info", label: "preparando" },
    READY: { cls: "success", label: "listo" },
    DELIVERED: { cls: "", label: "entregado" },
    CANCELLED: { cls: "danger", label: "cancelado" },
  };
  const config = map[status] ?? { cls: "", label: status };
  return <span className={`chip ${config.cls}`}>{config.label}</span>;
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

  if (orders.isLoading && !orders.data) return <Spinner label="Cargando pedido…" />;
  if (!order && !pendingRecord) {
    return (
      <div className="stack">
        <EmptyState icon="🪑" title="Esta mesa no tiene pedido abierto" hint="Vuelva al salón para abrir la mesa." />
        <button className="btn secondary" onClick={() => navigate("/mesas")}>
          ← Volver al salón
        </button>
      </div>
    );
  }

  return (
    <div className="waiter-page order-page stack">
      <div className="order-header-card">
        <div className="order-table-summary">
          <span className="eyebrow">PEDIDO EN CURSO</span>
          <h1>{table}</h1>
          <p>
            {pendingRecord
              ? "Pedido guardado localmente · pendiente de sincronización"
              : `${order?.persons_count ?? 0} personas · ${order?.status === "OPEN" ? "Abierta" : order?.status ?? ""}`}
          </p>
        </div>
        <div className="order-header-actions">
          <button className="btn ghost small" onClick={() => navigate("/mesas")}>← Salón</button>
          {order ? (
            <button className="btn small" onClick={() => navigate(`/cobro/${order.id}`)}>Cobrar</button>
          ) : null}
        </div>
        {order?.items.some((i) => i.status === "READY") ? (
          <div className="order-ready-alert">✓ Hay productos listos para entregar</div>
        ) : null}
      </div>

      {!cartOpen ? (
        <section className="order-catalog" aria-labelledby="catalog-title">
          <div className="section-title waiter-section-title">
            <h2 id="catalog-title">Carta</h2>
            <span>{search.trim() ? `${visibleItems.length} resultados` : ""}</span>
          </div>
          <label className="visually-hidden" htmlFor="menu-search">Buscar platos y bebidas</label>
          <input
            id="menu-search"
            className="input menu-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Buscar platos y bebidas…"
          />
          <span className="category-label">CATEGORÍAS</span>
          <div className="category-tabs" aria-label="Categorías de la carta">
          {menu.data?.categories.map((category) => (
            <button
              key={category.id}
              className={category.id === activeCategory ? "active" : ""}
              onClick={() => {
                setCategoryId(category.id);
                setSearch("");
              }}
            >
              {category.name}
            </button>
          ))}
          </div>
          <div className="catalog-heading">
            <h3>{search.trim() ? "Resultados de búsqueda" : menu.data?.categories.find((category) => category.id === activeCategory)?.name ?? "Productos"}</h3>
            <span>{visibleItems.length} platos</span>
          </div>
          <div className="menu-product-list">
          {visibleItems.map((item) => (
            <div key={item.id} className={`menu-item ${item.availability_status === "SOLD_OUT" ? "soldout" : ""}`}>
              <div className="menu-item-image">
                {item.image_url ? (
                  <img
                    src={resolveMenuImageUrl(item.image_url)}
                    alt={item.name}
                    loading="lazy"
                    onError={(event) => {
                      event.currentTarget.style.display = "none";
                    }}
                  />
                ) : null}
              </div>
              <div className="grow menu-item-details">
                <div className="menu-item-name">{item.name}</div>
                {item.description ? <div className="hint">{item.description}</div> : null}
                <div className="row wrap menu-item-price-row">
                  <span className="price">{money(item.price)}</span>
                  <span className={item.availability_status === "SOLD_OUT" ? "availability soldout" : "availability"}>
                    {item.availability_status === "SOLD_OUT" ? "Agotado" : "Disponible"}
                  </span>
                </div>
              </div>
              <button
                className="btn menu-add-button"
                aria-label={`Agregar ${item.name}`}
                disabled={item.availability_status === "SOLD_OUT"}
                onClick={() => addToCart(item)}
              >
                +
              </button>
            </div>
          ))}
          {visibleItems.length === 0 ? <EmptyState icon="⌕" title="No hay productos para mostrar" hint="Prueba otra categoría o búsqueda." /> : null}
          </div>
        </section>
      ) : (
        <section className="cart-panel" aria-labelledby="cart-title">
          <div className="section-title waiter-section-title">
            <div>
              <span className="eyebrow">NUEVA COMANDA</span>
              <h2 id="cart-title">Tu comanda</h2>
            </div>
            <button className="btn ghost small" onClick={() => setCartOpen(false)}>← Carta</button>
          </div>
          <div className="cart-overview">{cartUnitLabel} · {cart.length} productos <span>Aún no enviados a preparación</span></div>
          <span className="category-label">PRODUCTOS AGREGADOS</span>
          <div className="cart-line-list">
            {cart.map((line) => (
              <article className="cart-line" key={line.item.id}>
                <div className="cart-line-heading">
                  <span className="cart-quantity-badge">{line.quantity}×</span>
                  <div className="grow"><strong>{line.item.name}</strong><span>{money(Number(line.item.price) * line.quantity)}</span></div>
                </div>
                <input
                  className="input cart-note-input"
                  placeholder="Observación (ej. sin cebolla)"
                  value={line.notes}
                  onChange={(event) => setCart((lines) => lines.map((entry) => (entry.item.id === line.item.id ? { ...entry, notes: event.target.value } : entry)))}
                />
                <div className="cart-line-footer">
                  <span>{money(line.item.price)} c/u</span>
                  <div className="qty-stepper">
                    <button aria-label={`Restar ${line.item.name}`} onClick={() => setQuantity(line.item.id, line.quantity - 1)}>−</button>
                    <span className="value">{line.quantity}</span>
                    <button aria-label={`Sumar ${line.item.name}`} onClick={() => setQuantity(line.item.id, line.quantity + 1)}>+</button>
                  </div>
                </div>
              </article>
            ))}
          </div>
          <label className="label" htmlFor="order-notes">Observaciones de la comanda</label>
          <textarea id="order-notes" className="textarea cart-order-notes" placeholder="Indicaciones generales (opcional)" value={orderNotes} onChange={(event) => setOrderNotes(event.target.value)} />
          <div className="cart-subtotal"><span>Subtotal de la comanda</span><strong>{money(cartSubtotal)}</strong></div>
          <button data-testid="send-command" className="btn block send-command-button" onClick={() => setConfirmSend(true)} disabled={sending || cart.length === 0}>
            Enviar comanda →
          </button>
        </section>
      )}

      {cart.length > 0 && !cartOpen ? (
        <button className="cart-quick-access" onClick={() => setCartOpen(true)}>
          <span>▣ &nbsp; Ver comanda · {cartUnitLabel}</span>
          <strong>{money(cartSubtotal)}</strong>
        </button>
      ) : null}

      <div className="card order-history-card">
        <div className="section-title">
          <h2>Productos del pedido</h2>
        </div>
        {!order || order.items.length === 0 ? (
          <EmptyState icon="🧾" title="Aún no hay productos" hint="Agregue desde la carta." />
        ) : (
          <>
            {order.commands.map((command) => (
              <div key={command.id} style={{ marginBottom: 8 }}>
                <div className="hint" style={{ margin: "8px 0 2px" }}>
                  Comanda #{command.sequence_number} · {new Date(command.created_at).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" })}
                  {command.notes ? ` · “${command.notes}”` : ""}
                </div>
                {command.items.map((item) => (
                  <ItemRow key={item.id} item={item} order={order} onStatus={(i, s) => void changeItemStatus(i, s)} onCancel={(i) => setConfirmCancel(i)} />
                ))}
              </div>
            ))}
            <div className="row" style={{ marginTop: 10 }}>
              <span className="grow hint">Total del pedido</span>
              <strong>{money(order.total)}</strong>
            </div>
          </>
        )}
      </div>

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
          <div className="send-confirmation">
            <span className="eyebrow">CONFIRMACIÓN</span>
            <h3>Detalle de envío</h3>
            <div className="send-confirmation-detail">
              <strong>{cartUnitLabel} en {cart.length} productos</strong>
              <span>{table} · {order?.persons_count ?? pendingRecord?.persons_count ?? 0} personas</span>
              <div><span>Subtotal</span><strong>{money(cartSubtotal)}</strong></div>
            </div>
            <p className="hint">Se enviará a las áreas de preparación correspondientes.</p>
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
