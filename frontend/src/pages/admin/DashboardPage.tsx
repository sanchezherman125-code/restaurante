import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { ordersApi, preparationApi, reportsApi, shiftsApi, tablesApi } from "../../api/endpoints";
import { Icon, type IconName } from "../../components/Icon";
import { Kpi, PageHeader, SkeletonList, StaleNotice } from "../../components/Layout";
import { money } from "../../hooks/useElapsed";
import { freshness } from "../../lib/freshness";
import { PAYMENT_METHOD } from "../../lib/labels";
import type { Order } from "../../types/api";

function LiveTile({ icon, label, value, hint, tone, to }: { icon: IconName; label: string; value: number | string; hint?: string; tone?: "ok" | "run" | "wait" | "bad"; to: string }) {
  const navigate = useNavigate();
  return (
    <button className={`live-tile ${tone ?? ""}`} onClick={() => navigate(to)}>
      <span className="live-icon"><Icon name={icon} /></span>
      <span className="live-copy">
        <span className="num live-value">{value}</span>
        <span className="live-label">{label}</span>
        {hint ? <span className="hint">{hint}</span> : null}
      </span>
      <Icon name="chevronRight" className="live-go" />
    </button>
  );
}

function Distribution({ title, rows, empty }: { title: string; rows: [string, number][]; empty: string }) {
  const total = rows.reduce((sum, [, amount]) => sum + amount, 0);
  return (
    <section className="card">
      <div className="section-title"><h2>{title}</h2></div>
      {rows.length === 0 ? <p className="hint">{empty}</p> : (
        <ul className="bars">
          {rows.sort((a, b) => b[1] - a[1]).map(([label, amount]) => (
            <li key={label}>
              <div className="row"><span className="grow">{label}</span><strong className="num">{money(amount)}</strong></div>
              <div className="bar" aria-hidden="true"><span style={{ width: `${total > 0 ? Math.round((amount / total) * 100) : 0}%` }} /></div>
              <span className="visually-hidden">{total > 0 ? Math.round((amount / total) * 100) : 0}% del total</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function DashboardPage() {
  const navigate = useNavigate();
  const shift = useQuery({ queryKey: ["shifts", "current"], queryFn: shiftsApi.current, retry: false });
  const sales = useQuery({ queryKey: ["reports", "current-shift"], queryFn: reportsApi.currentShift, retry: false, refetchInterval: 15000 });
  const orders = useQuery({ queryKey: ["orders", "active"], queryFn: () => ordersApi.active(), retry: false, refetchInterval: 15000 });
  const tables = useQuery({ queryKey: ["tables"], queryFn: tablesApi.list, retry: false });
  const kitchen = useQuery({ queryKey: ["preparation", "kitchen"], queryFn: preparationApi.kitchen, retry: false, refetchInterval: 15000 });
  const grill = useQuery({ queryKey: ["preparation", "grill"], queryFn: preparationApi.grill, retry: false, refetchInterval: 15000 });

  if (sales.isLoading) {
    return <div className="page"><PageHeader title="Panel" /><SkeletonList rows={3} height={96} label="Cargando panel" /></div>;
  }

  // Sin respuesta del servidor ni copia local, cada cifra se muestra como "—", nunca como un cero confirmado.
  const queries = [shift, sales, orders, tables, kitchen, grill];
  const unconfirmed = queries.filter((query) => ["stale", "unavailable"].includes(freshness(query)));
  const copies = unconfirmed.filter((query) => query.data !== undefined).map((query) => query.dataUpdatedAt);
  const missing = unconfirmed.length > copies.length;

  const data = sales.data;
  const openShift = shift.data && shift.data.status === "OPEN" ? shift.data : null;
  const active: Order[] = orders.data ?? [];
  const readyToDeliver = orders.data ? active.filter((order) => order.items.some((item) => item.status === "READY")).length : null;
  const unpaid = orders.data ? active.filter((order) => Number(order.total) - Number(order.paid_amount) > 0.001).length : null;
  const tasksOf = (groups: typeof kitchen.data) => groups
    ? groups.flatMap((group) => group.tasks).filter((task) => task.status === "PENDING" || task.status === "PREPARING").length
    : null;
  const kitchenTasks = tasksOf(kitchen.data);
  const grillTasks = tasksOf(grill.data);
  const occupied = (tables.data ?? []).filter((table) => table.status === "OPEN").length;
  const activeTables = (tables.data ?? []).filter((table) => table.is_active).length;
  const net = Number(data?.net_result ?? 0);
  const amount = (value: string | undefined) => (data ? money(value) : "—");
  const count = (value: number | null) => value ?? "—";

  return (
    <div className="page">
      <PageHeader
        title="Panel"
        subtitle={openShift
          ? `Turno abierto desde las ${new Date(openShift.opened_at).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" })}`
          : shift.data === undefined ? "Turno sin confirmar" : "No hay un turno abierto"}
        actions={<button className="btn secondary" onClick={() => navigate("/turnos")}><Icon name="shift" />{openShift ? "Gestionar turno" : "Abrir turno"}</button>}
      />

      {unconfirmed.length > 0 ? (
        <StaleNotice
          message={copies.length === 0 ? "Sin conexión con el servidor: las cifras marcadas «—» no están disponibles."
            : missing ? "Sin conexión con el servidor: las cifras pueden no estar al día y las marcadas «—» no están disponibles."
            : "Sin conexión con el servidor: las cifras pueden no estar al día."}
          updatedAt={copies.length > 0 ? Math.min(...copies) : undefined}
          onRetry={() => unconfirmed.forEach((query) => void query.refetch())} />
      ) : null}

      {!openShift && shift.data !== undefined ? (
        <div className="empty-shift card">
          <Icon name="shift" />
          <div className="grow">
            <strong>Sin turno abierto</strong>
            <div className="hint">Los meseros no pueden abrir pedidos hasta que abra un turno. Los importes de abajo corresponden al último turno consultado.</div>
          </div>
          <button className="btn" onClick={() => navigate("/turnos")}>Abrir turno</button>
        </div>
      ) : null}

      <section aria-label="Resumen financiero del turno" className="kpi-grid">
        <Kpi label="Ventas cobradas" value={amount(data?.total_sales)} tone="accent" note={data ? `${data.orders_count} ${data.orders_count === 1 ? "pedido" : "pedidos"}` : "Sin datos"} />
        <Kpi label="Gastos" value={amount(data?.total_expenses)} />
        <Kpi label="Resultado neto" value={amount(data?.net_result)} tone={net < 0 ? "neg" : undefined} note={net < 0 ? "Los gastos superan las ventas" : undefined} />
        <Kpi label="Mesas atendidas" value={data ? data.tables_served : "—"} note={data ? `${data.persons_served} personas` : "Sin datos"} />
      </section>

      <section aria-label="Operación en vivo">
        <div className="section-title"><h2>Ahora en el local</h2></div>
        <div className="live-grid">
          <LiveTile icon="tables" label="Mesas ocupadas" value={tables.data ? `${occupied}/${activeTables}` : "—"} to="/mesas" />
          <LiveTile icon="check" label="Pedidos con algo para entregar" value={count(readyToDeliver)} tone={readyToDeliver ? "ok" : undefined} to="/pedidos" />
          <LiveTile icon="money" label="Pedidos por cobrar" value={count(unpaid)} tone={unpaid ? "wait" : undefined} to="/pedidos" />
          <LiveTile icon="kitchen" label="Tareas en cocina" value={count(kitchenTasks)} tone={kitchenTasks ? "run" : undefined} hint="pendientes y en curso" to="/comandas" />
          <LiveTile icon="flame" label="Tareas en parrilla" value={count(grillTasks)} tone={grillTasks ? "run" : undefined} hint="pendientes y en curso" to="/comandas" />
        </div>
      </section>

      <div className="two-col">
        <Distribution title="Ventas por método de pago"
          rows={Object.entries(data?.sales_by_payment_method ?? {}).map(([method, amount]) => [PAYMENT_METHOD[method as keyof typeof PAYMENT_METHOD] ?? method, Number(amount)])}
          empty={data ? "Aún no hay cobros registrados en este turno." : "Sin datos del servidor."} />
        <Distribution title="Ventas por mesero"
          rows={Object.entries(data?.sales_by_waiter ?? {}).map(([waiter, amount]) => [waiter, Number(amount)])}
          empty={data ? "Aún no hay ventas atribuidas a un mesero." : "Sin datos del servidor."} />
      </div>
    </div>
  );
}
