import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { ordersApi } from "../../api/endpoints";
import { EmptyState, Spinner } from "../../components/Layout";
import { formatElapsed, money, useElapsed } from "../../hooks/useElapsed";
import { usePendingOrders } from "../../stores/pendingOrders";
import type { Order } from "../../types/api";

function OrderCard({ order }: { order: Order }) {
  const navigate = useNavigate();
  const elapsed = useElapsed(order.opened_at);
  const counts = {
    pending: order.items.filter((i) => i.status === "PENDING").length,
    preparing: order.items.filter((i) => i.status === "PREPARING").length,
    ready: order.items.filter((i) => i.status === "READY").length,
    cancelled: order.items.filter((i) => i.status === "CANCELLED").length,
  };

  return (
    <div className="ticket-card">
      <div className="ticket-head">
        <strong>{order.table_name ?? (order.order_type === "TAKEAWAY" ? "Para llevar" : "Pedido")}</strong>
        <span className="chip">{order.persons_count ? `${order.persons_count} pers.` : "—"}</span>
        <span className={`chip ${order.status === "READY" ? "success" : order.status === "PAID" ? "" : "info"}`}>
          {order.status}
        </span>
        <span className="grow" />
        <span className="timer">{formatElapsed(elapsed)}</span>
      </div>
      <div className="ticket-body">
        <div className="row wrap" style={{ margin: "8px 0" }}>
          {counts.pending > 0 ? <span className="chip warning">🟡 {counts.pending} pendientes</span> : null}
          {counts.preparing > 0 ? <span className="chip info">🔵 {counts.preparing} preparando</span> : null}
          {counts.ready > 0 ? <span className="chip success">🟢 {counts.ready} listos</span> : null}
          {counts.cancelled > 0 ? <span className="chip danger">✕ {counts.cancelled} cancelados</span> : null}
        </div>
        <div className="row">
          <span className="grow hint">
            {order.items.filter((i) => i.status !== "CANCELLED").length} productos · {money(order.total)}
          </span>
          {order.table_id ? (
            <button className="btn small secondary" onClick={() => navigate(`/mesas/${order.table_id}`)}>
              Ver mesa
            </button>
          ) : null}
          <button className="btn small" onClick={() => navigate(`/cobro/${order.id}`)}>
            💳 Cobro
          </button>
        </div>
      </div>
    </div>
  );
}

export function ActiveOrdersPage() {
  const orders = useQuery({ queryKey: ["orders", "active"], queryFn: () => ordersApi.active(), retry: false });
  const records = usePendingOrders((state) => state.records);
  const pending = useMemo(
    () => records.filter((record) => !record.server_order_id && !record.error),
    [records],
  );

  if (orders.isLoading) return <Spinner label="Cargando pedidos…" />;

  return (
    <div className="stack">
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2>Pedidos activos</h2>
        <span className="hint">{orders.data?.length ?? 0} abiertos</span>
      </div>

      {pending.map((record) => (
        <div className="ticket-card" key={record.operation_id}>
          <div className="ticket-head">
            <strong>{record.table_name}</strong>
            <span className="chip warning">⏳ pendiente de envío</span>
          </div>
          <div className="ticket-body">
            <span className="hint">{record.persons_count} personas · se sincronizará al reconectar</span>
          </div>
        </div>
      ))}

      {!orders.data || orders.data.length === 0 ? (
        pending.length === 0 ? (
          <EmptyState icon="🧾" title="No hay pedidos activos" hint="Abra una mesa desde el salón." />
        ) : null
      ) : (
        orders.data.map((order) => <OrderCard key={order.id} order={order} />)
      )}
    </div>
  );
}
