import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { reportsApi } from "../../api/endpoints";
import { Kpi, Spinner } from "../../components/Layout";
import { money } from "../../hooks/useElapsed";

const AREA_LABEL: Record<string, string> = { KITCHEN: "Cocina", GRILL: "Parrilla", WAITER: "Barra" };

function formatSeconds(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return "—";
  const min = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return `${min}m ${sec}s`;
}

export function ReportsPage() {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const params = {
    ...(dateFrom ? { date_from: dateFrom } : {}),
    ...(dateTo ? { date_to: dateTo } : {}),
  };

  const sales = useQuery({
    queryKey: ["reports", "sales", params],
    queryFn: () => reportsApi.sales(params),
    retry: false,
  });
  const products = useQuery({
    queryKey: ["reports", "products", params],
    queryFn: () => reportsApi.products(params),
    retry: false,
  });
  const prep = useQuery({
    queryKey: ["reports", "preparation", params],
    queryFn: () => reportsApi.preparation(params),
    retry: false,
  });

  if (sales.isLoading) return <Spinner label="Generando reportes…" />;

  return (
    <div className="stack">
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2>Reportes</h2>
      </div>

      <div className="card">
        <div className="grid-2">
          <div>
            <label className="label">Desde</label>
            <input className="input" type="date" value={dateFrom} onChange={(event) => setDateFrom(event.target.value)} />
          </div>
          <div>
            <label className="label">Hasta</label>
            <input className="input" type="date" value={dateTo} onChange={(event) => setDateTo(event.target.value)} />
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <button
            className="btn ghost small"
            onClick={() => {
              setDateFrom("");
              setDateTo("");
            }}
          >
            Limpiar
          </button>
          <span className="hint grow">{dateFrom || dateTo ? "Rango personalizado" : "Turno actual / todo"}</span>
        </div>
      </div>

      <div className="grid-2">
        <Kpi label="Ventas" value={money(sales.data?.total_sales)} />
        <Kpi label="Gastos" value={money(sales.data?.total_expenses)} />
        <Kpi label="Resultado neto" value={money(sales.data?.net_result)} />
        <Kpi label="Pedidos" value={sales.data?.orders_count ?? 0} />
        <Kpi label="Mesas atendidas" value={sales.data?.tables_served ?? 0} />
        <Kpi label="Personas atendidas" value={sales.data?.persons_served ?? 0} />
      </div>

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          <h2>Productos más vendidos</h2>
        </div>
        <table className="data">
          <thead>
            <tr>
              <th>Producto</th>
              <th>Cant.</th>
              <th>Importe</th>
            </tr>
          </thead>
          <tbody>
            {(products.data?.lines ?? []).map((line) => (
              <tr key={line.name}>
                <td>{line.name}</td>
                <td>{line.quantity}</td>
                <td>{money(line.revenue)}</td>
              </tr>
            ))}
            {(products.data?.lines ?? []).length === 0 ? (
              <tr>
                <td colSpan={3} className="hint">
                  Sin ventas en el rango.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          <h2>Tiempos de preparación</h2>
          <span className="chip info">promedio {formatSeconds(prep.data?.average_seconds ?? null)}</span>
        </div>
        <table className="data">
          <thead>
            <tr>
              <th>Área</th>
              <th>Promedio</th>
              <th>Mediciones</th>
            </tr>
          </thead>
          <tbody>
            {(prep.data?.lines ?? []).map((line) => (
              <tr key={line.area}>
                <td>{AREA_LABEL[line.area] ?? line.area}</td>
                <td>{formatSeconds(line.average_seconds)}</td>
                <td>{line.items_measured}</td>
              </tr>
            ))}
            {(prep.data?.lines ?? []).length === 0 ? (
              <tr>
                <td colSpan={3} className="hint">
                  Sin mediciones en el rango.
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
