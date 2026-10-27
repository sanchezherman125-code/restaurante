import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ordersApi } from "../../api/endpoints";
import { Icon } from "../../components/Icon";
import { ConfirmDialog } from "../../components/Modal";
import { errorMessage } from "../../lib/send";
import { useUi } from "../../stores/ui";
import { EmptyState, PageHeader, SkeletonList, StaleNotice, StatusBadge, UnavailableState } from "../../components/Layout";
import { formatElapsed, money, useElapsed } from "../../hooks/useElapsed";
import { freshness } from "../../lib/freshness";
import { ORDER_STATUS } from "../../lib/labels";
import { usePendingOrders } from "../../stores/pendingOrders";
import type { Order } from "../../types/api";

type Filter = "ALL" | "READY" | "PREPARING" | "UNPAID";

function counts(order: Order) {
  const live = order.items.filter((item) => item.status !== "CANCELLED");
  return {
    pending: live.filter((item) => item.status === "PENDING").length,
    preparing: live.filter((item) => item.status === "PREPARING").length,
    ready: live.filter((item) => item.status === "READY").length,
    delivered: live.filter((item) => item.status === "DELIVERED").length,
    total: live.length,
  };
}

function OrderCard({ order }: { order: Order }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useUi((state) => state.toast);
  const [confirmRelease, setConfirmRelease] = useState(false);
  const [releasing, setReleasing] = useState(false);
  const empty = order.status === "OPEN" && Number(order.paid_amount) === 0 && order.items.every((item) => item.status === "CANCELLED");

  async function release() {
    setReleasing(true);
    try {
      await ordersApi.cancelEmpty(order.id, crypto.randomUUID());
      toast("success", `${order.table_name ?? "Mesa"} liberada`, "El pedido vacío se anuló.");
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: ["tables"] });
    } catch (error) {
      toast("error", "No se pudo liberar la mesa", errorMessage(error));
    } finally {
      setReleasing(false);
      setConfirmRelease(false);
    }
  }
  const elapsed = useElapsed(order.opened_at);
  const c = counts(order);
  const status = ORDER_STATUS[order.status];
  const owed = Math.max(0, Number(order.total) - Number(order.paid_amount));
  const tone = c.ready > 0 ? "ready" : c.preparing > 0 ? "running" : "waiting";

  return (
    <article className="ticket-card" data-tone={tone}>
      <div className="ticket-head">
        <strong>{order.table_name ?? (order.order_type === "TAKEAWAY" ? "Para llevar" : "Pedido")}</strong>
        {order.persons_count ? <span className="chip"><Icon name="users" />{order.persons_count}</span> : null}
        <span className="grow" />
        <span className="timer" title="Tiempo desde que se abrió">{formatElapsed(elapsed)}</span>
      </div>
      <div className="ticket-body">
        <div className="row wrap" style={{ margin: "var(--s2) 0", gap: "var(--s2)" }}>
          {/* Abierto/En preparación ya se leen en los contadores de abajo. */}
          {order.status !== "OPEN" && order.status !== "IN_PREPARATION" ? <StatusBadge label={status.label} tone={status.tone} icon={status.icon} /> : null}
          {c.ready > 0 ? <span className="chip success"><Icon name="check" />{c.ready} listo{c.ready > 1 ? "s" : ""} para entregar</span> : null}
          {c.preparing > 0 ? <span className="chip info"><Icon name="flame" />{c.preparing} preparando</span> : null}
          {c.pending > 0 ? <span className="chip warning"><Icon name="hourglass" />{c.pending} pendiente{c.pending > 1 ? "s" : ""}</span> : null}
          {c.delivered > 0 ? <span className="chip">{c.delivered} entregado{c.delivered > 1 ? "s" : ""}</span> : null}
        </div>
        <div className="row wrap">
          <div className="grow">
            <div className="num" style={{ fontSize: "var(--fs-md)", fontWeight: 650 }}>{money(order.total)}</div>
            <div className="hint">
              {c.total} {c.total === 1 ? "producto" : "productos"}
              {Number(order.paid_amount) > 0 ? ` · pagado ${money(order.paid_amount)}` : ""}
              {owed > 0.001 && Number(order.paid_amount) > 0 ? ` · falta ${money(owed)}` : ""}
            </div>
          </div>
          {order.table_id ? (
            <button className="btn small secondary" onClick={() => navigate(`/mesas/${order.table_id}`)}>Ver mesa</button>
          ) : null}
          {empty ? (
            <button className="btn small ghost" disabled={releasing} onClick={() => setConfirmRelease(true)}><Icon name="x" />Liberar mesa</button>
          ) : (
            <button className="btn small" onClick={() => navigate(`/cobro/${order.id}`)}><Icon name="money" />Cobro</button>
          )}
        </div>
        {empty ? <p className="hint" style={{ marginTop: "var(--s2)" }}>Pedido sin productos: libere la mesa si nadie va a pedir.</p> : null}
      </div>
      {confirmRelease ? (
        <ConfirmDialog
          title="Liberar mesa"
          message={`${order.table_name ?? "El pedido"} no tiene productos ni pagos. Se anulará el pedido vacío y la mesa quedará libre. Queda registrado en la auditoría.`}
          confirmLabel="Liberar mesa"
          onConfirm={() => void release()}
          onCancel={() => setConfirmRelease(false)}
        />
      ) : null}
    </article>
  );
}

export function ActiveOrdersPage() {
  const orders = useQuery({ queryKey: ["orders", "active"], queryFn: () => ordersApi.active(), refetchInterval: 15000, retry: false });
  const records = usePendingOrders((state) => state.records);
  const [filter, setFilter] = useState<Filter>("ALL");
  const pending = useMemo(() => records.filter((record) => !record.server_order_id && !record.error), [records]);

  const sorted = useMemo(() => {
    const rows = [...(orders.data ?? [])];
    // Lo que se puede entregar ahora va primero; después lo más antiguo.
    rows.sort((a, b) => (counts(b).ready > 0 ? 1 : 0) - (counts(a).ready > 0 ? 1 : 0) || a.opened_at.localeCompare(b.opened_at));
    return rows;
  }, [orders.data]);

  const tally = useMemo(() => ({
    ready: sorted.filter((order) => counts(order).ready > 0).length,
    preparing: sorted.filter((order) => counts(order).preparing + counts(order).pending > 0).length,
    unpaid: sorted.filter((order) => Number(order.total) - Number(order.paid_amount) > 0.001).length,
  }), [sorted]);

  const visible = sorted.filter((order) =>
    filter === "ALL" ? true
    : filter === "READY" ? counts(order).ready > 0
    : filter === "PREPARING" ? counts(order).preparing + counts(order).pending > 0
    : Number(order.total) - Number(order.paid_amount) > 0.001);

  const state = freshness(orders);
  if (state === "loading") return <div className="page"><PageHeader title="Pedidos activos" /><SkeletonList rows={4} height={140} label="Cargando pedidos" /></div>;
  const unavailable = state === "unavailable";

  return (
    <div className="page">
      <PageHeader title="Pedidos activos" subtitle={unavailable ? "Sin datos del servidor"
        : `${sorted.length} ${sorted.length === 1 ? "abierto" : "abiertos"}`} />

      <div className="segmented" role="group" aria-label="Filtrar pedidos">
        {([["ALL", "Todos", sorted.length], ["READY", "Para entregar", tally.ready], ["PREPARING", "En preparación", tally.preparing], ["UNPAID", "Por cobrar", tally.unpaid]] as const).map(([key, label, count]) => (
          <button key={key} className={filter === key ? "active" : ""} aria-pressed={filter === key} onClick={() => setFilter(key)}>
            {label}<span className="count">{unavailable ? "—" : count}</span>
          </button>
        ))}
      </div>

      {pending.map((record) => (
        <article className="ticket-card" data-tone="waiting" key={record.operation_id}>
          <div className="ticket-head">
            <strong>{record.table_name}</strong>
            <span className="chip warning"><Icon name="cloud" />Sin enviar</span>
          </div>
          <div className="ticket-body">
            <span className="hint">{record.persons_count} personas · guardado solo en este dispositivo; se enviará al recuperar la conexión</span>
          </div>
        </article>
      ))}

      {state === "stale" ? <StaleNotice updatedAt={orders.dataUpdatedAt} message="Sin conexión con el servidor: los pedidos pueden no estar al día." onRetry={() => void orders.refetch()} /> : null}

      {unavailable ? (
        <UnavailableState title="No se pudieron cargar los pedidos"
          hint="Sin conexión con el servidor: puede haber pedidos abiertos que todavía no se ven aquí. Se reintenta solo."
          onRetry={() => void orders.refetch()} />
      ) : visible.length === 0 && pending.length === 0 ? (
        <EmptyState icon="receipt" title={filter === "ALL" ? "No hay pedidos activos" : "Nada en esta vista"}
          hint={filter === "ALL" ? "Abra una mesa desde el salón." : "Cambie el filtro para ver los demás pedidos."} />
      ) : (
        <div className="order-grid">{visible.map((order) => <OrderCard key={order.id} order={order} />)}</div>
      )}
    </div>
  );
}
