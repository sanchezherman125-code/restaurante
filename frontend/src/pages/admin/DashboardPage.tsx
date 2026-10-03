import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { reportsApi, shiftsApi } from "../../api/endpoints";
import { Kpi, Spinner } from "../../components/Layout";
import { money } from "../../hooks/useElapsed";

export function DashboardPage() {
  const navigate = useNavigate();
  const shift = useQuery({ queryKey: ["shifts", "current"], queryFn: shiftsApi.current, retry: false });
  const sales = useQuery({ queryKey: ["reports", "current-shift"], queryFn: reportsApi.currentShift, retry: false });

  if (sales.isLoading) return <Spinner label="Cargando panel…" />;

  const data = sales.data;
  const openShift = shift.data && shift.data.status === "OPEN" ? shift.data : null;

  return (
    <div className="stack">
      <div className="card">
        <div className="row wrap">
          <div className="grow">
            <h2>Panel de control</h2>
            <div className="hint">
              {openShift
                ? `Turno abierto desde ${new Date(openShift.opened_at).toLocaleString("es-PE", { hour: "2-digit", minute: "2-digit" })}`
                : "No hay turno abierto"}
            </div>
          </div>
          <button className="btn small" onClick={() => navigate("/turnos")}>
            Turnos
          </button>
        </div>
      </div>

      <div className="grid-2">
        <Kpi label="Ventas del turno" value={money(data?.total_sales)} />
        <Kpi label="Gastos" value={money(data?.total_expenses)} />
        <Kpi label="Neto" value={money(data?.net_result)} />
        <Kpi label="Pedidos" value={data?.orders_count ?? 0} />
        <Kpi label="Mesas atendidas" value={data?.tables_served ?? 0} />
        <Kpi label="Personas" value={data?.persons_served ?? 0} />
      </div>

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          <h2>Ventas por método de pago</h2>
        </div>
        {Object.entries(data?.sales_by_payment_method ?? {}).length === 0 ? (
          <span className="hint">Sin pagos registrados en el turno.</span>
        ) : (
          Object.entries(data?.sales_by_payment_method ?? {}).map(([method, amount]) => (
            <div className="item-row" key={method}>
              <span className="name">{method}</span>
              <strong>{money(amount)}</strong>
            </div>
          ))
        )}
      </div>

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          <h2>Ventas por mesero</h2>
        </div>
        {Object.entries(data?.sales_by_waiter ?? {}).length === 0 ? (
          <span className="hint">Sin ventas registradas.</span>
        ) : (
          Object.entries(data?.sales_by_waiter ?? {}).map(([waiter, amount]) => (
            <div className="item-row" key={waiter}>
              <span className="name">{waiter}</span>
              <strong>{money(amount)}</strong>
            </div>
          ))
        )}
      </div>

      <div className="grid-2">
        <button className="btn secondary" onClick={() => navigate("/comandas")}>
          👨‍🍳 Cocina / Parrilla
        </button>
        <button className="btn secondary" onClick={() => navigate("/gastos")}>
          💸 Gastos
        </button>
        <button className="btn secondary" onClick={() => navigate("/compras")}>
          🛒 Compras
        </button>
        <button className="btn secondary" onClick={() => navigate("/reportes")}>
          📈 Reportes
        </button>
      </div>
    </div>
  );
}
