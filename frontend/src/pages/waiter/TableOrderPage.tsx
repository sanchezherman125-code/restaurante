import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { menuApi, ordersApi } from "../../api/endpoints";
import { ConfirmDialog } from "../../components/Modal";
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
  const orders = useQuery({ queryKey: ["orders", "active"], queryFn: () => ordersApi.active(), retry: false });

  const [categoryId, setCategoryId] = useState<string | null>(null);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [orderNotes, setOrderNotes] = useState("");
  const [sending, setSending] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState<OrderItem | null>(null);

  const order = useMemo(() => orders.data?.find((o) => o.table_id === tableId), [orders.data, tableId]);
  const activeCategory = categoryId ?? menu.data?.categories[0]?.id ?? null;
  const visibleItems = (menu.data?.items ?? []).filter((item) => item.is_active && item.category_id === activeCategory);
  const table = pendingRecord?.table_name ?? order?.table_name ?? "Mesa";

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

      if (pendingRecord) {
        await enqueue({
          operation_type: "CREATE_COMMAND",
          path: "/api/v1/orders/{orderRef}/commands",
          method: "POST",
          body: payload,
          parent_operation_id: pendingRecord.operation_id,
        });
        toast("warning", "Comanda guardada", "Se enviará automáticamente al recuperar la conexión.");
        setCart([]);
        setOrderNotes("");
        return;
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
        if (outcome.queued) return;
      } else {
        toast("error", "No hay pedido abierto en esta mesa");
        return;
      }

      setCart([]);
      setOrderNotes("");
      toast("success", "Comanda enviada", `${cart.length} producto(s) a cocina/parrilla`);
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: ["tables"] });
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
        () => ordersApi.cancelItem(order.id, item.id, "Cancelado por mesero"),
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
    <div className="stack">
      <div className="card">
        <div className="row wrap">
          <div className="grow">
            <h2>{table}</h2>
            <div className="hint">
              {pendingRecord
                ? "Pedido aún sin sincronizar (offline)"
                : `${order?.persons_count ?? 0} personas · ${order?.status ?? ""}`}
            </div>
          </div>
          <button className="btn ghost small" onClick={() => navigate("/mesas")}>
            ← Salón
          </button>
          {order ? (
            <button className="btn small" onClick={() => navigate(`/cobro/${order.id}`)}>
              💳 Cobrar
            </button>
          ) : null}
        </div>
        {order?.items.some((i) => i.status === "READY") ? (
          <div className="chip success" style={{ marginTop: 10 }}>
            Hay productos listos para entregar
          </div>
        ) : null}
      </div>

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          <h2>Carta</h2>
        </div>
        <div className="segmented" style={{ marginBottom: 12, overflowX: "auto" }}>
          {menu.data?.categories.map((category) => (
            <button
              key={category.id}
              className={category.id === activeCategory ? "active" : ""}
              onClick={() => setCategoryId(category.id)}
            >
              {category.name}
            </button>
          ))}
        </div>

        <div className="stack">
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
              <div className="grow">
                <div style={{ fontWeight: 700 }}>{item.name}</div>
                {item.description ? <div className="hint">{item.description}</div> : null}
                <div className="row wrap" style={{ marginTop: 4 }}>
                  <span className="price">{money(item.price)}</span>
                  {item.availability_status === "SOLD_OUT" ? <span className="chip danger">agotado</span> : null}
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
          {visibleItems.length === 0 ? <EmptyState icon="🍽️" title="Sin productos en esta categoría" /> : null}
        </div>
      </div>

      {cart.length > 0 ? (
        <div className="card sticky-actions">
          <div className="section-title" style={{ marginTop: 0 }}>
            <h2>Comanda ({cart.reduce((sum, line) => sum + line.quantity, 0)})</h2>
            <button className="btn ghost small" onClick={() => setCart([])}>
              Vaciar
            </button>
          </div>
          {cart.map((line) => (
            <div className="item-row" key={line.item.id}>
              <div className="name">
                <div style={{ fontWeight: 700 }}>{line.item.name}</div>
                <input
                  className="input"
                  style={{ minHeight: 38, marginTop: 6, fontSize: 13 }}
                  placeholder="Observación (ej. sin cebolla)"
                  value={line.notes}
                  onChange={(event) =>
                    setCart((lines) =>
                      lines.map((entry) => (entry.item.id === line.item.id ? { ...entry, notes: event.target.value } : entry)),
                    )
                  }
                />
              </div>
              <div className="qty-stepper">
                <button onClick={() => setQuantity(line.item.id, line.quantity - 1)}>−</button>
                <span className="value">{line.quantity}</span>
                <button onClick={() => setQuantity(line.item.id, line.quantity + 1)}>+</button>
              </div>
            </div>
          ))}
          <textarea
            className="textarea"
            style={{ marginTop: 10 }}
            placeholder="Observaciones del pedido (opcional)"
            value={orderNotes}
            onChange={(event) => setOrderNotes(event.target.value)}
          />
          <button
            data-testid="send-command"
            className="btn block"
            style={{ marginTop: 10 }}
            onClick={() => void sendCommand()}
            disabled={sending}
          >
            {sending ? "Enviando…" : "🚀 Enviar comanda"}
          </button>
        </div>
      ) : null}

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
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
    </div>
  );
}
