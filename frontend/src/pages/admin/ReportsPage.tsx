import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { reportsApi } from "../../api/endpoints";
import { Icon } from "../../components/Icon";
import { Kpi, PageHeader, SkeletonList } from "../../components/Layout";
import { money } from "../../hooks/useElapsed";
import { AREA_NAME } from "../../lib/labels";

function formatSeconds(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return "—";
  const min = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return `${min}m ${sec}s`;
}

const iso = (date: Date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;

export function ReportsPage() {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const params = {
    ...(dateFrom ? { date_from: dateFrom } : {}),
    ...(dateTo ? { date_to: dateTo } : {}),
  };

  const sales = useQuery({ queryKey: ["reports", "sales", params], queryFn: () => reportsApi.sales(params), retry: false });
  const products = useQuery({ queryKey: ["reports", "products", params], queryFn: () => reportsApi.products(params), retry: false });
  const prep = useQuery({ queryKey: ["reports", "preparation", params], queryFn: () => reportsApi.preparation(params), retry: false });

  function preset(days: number | "month" | "all") {
    const today = new Date();
    if (days === "all") { setDateFrom(""); setDateTo(""); return; }
    const from = days === "month" ? new Date(today.getFullYear(), today.getMonth(), 1) : new Date(today.getTime() - (days - 1) * 86_400_000);
    setDateFrom(iso(from));
    setDateTo(iso(today));
  }

  if (sales.isLoading) return <div className="page"><PageHeader title="Reportes" /><SkeletonList rows={3} height={90} label="Generando reportes" /></div>;

  const rows = products.data?.lines ?? [];
  const topRevenue = Math.max(0, ...rows.map((line) => Number(line.revenue)));
  const net = Number(sales.data?.net_result ?? 0);

  return (
    <div className="page">
      <PageHeader title="Reportes" subtitle={dateFrom || dateTo ? "Rango personalizado" : "Turno actual y datos disponibles"} />

      <section className="card filters" aria-label="Rango de fechas">
        <div className="field">
          <label className="label" htmlFor="rep-from">Desde</label>
          <input id="rep-from" className="input" type="date" value={dateFrom} max={dateTo || undefined} onChange={(event) => setDateFrom(event.target.value)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="rep-to">Hasta</label>
          <input id="rep-to" className="input" type="date" value={dateTo} min={dateFrom || undefined} onChange={(event) => setDateTo(event.target.value)} />
        </div>
        <div className="segmented" role="group" aria-label="Rangos rápidos">
          <button onClick={() => preset(1)}>Hoy</button>
          <button onClick={() => preset(7)}>7 días</button>
          <button onClick={() => preset("month")}>Este mes</button>
          <button onClick={() => preset("all")}>Todo</button>
        </div>
      </section>

      <section className="kpi-grid" aria-label="Resumen">
        <Kpi label="Ventas" value={money(sales.data?.total_sales)} tone="accent" />
        <Kpi label="Gastos" value={money(sales.data?.total_expenses)} />
        <Kpi label="Resultado neto" value={money(sales.data?.net_result)} tone={net < 0 ? "neg" : undefined} />
        <Kpi label="Pedidos" value={sales.data?.orders_count ?? 0} />
        <Kpi label="Mesas atendidas" value={sales.data?.tables_served ?? 0} />
        <Kpi label="Personas atendidas" value={sales.data?.persons_served ?? 0} />
      </section>

      <div className="two-col">
        <section>
          <div className="section-title"><h2>Productos más vendidos</h2></div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Producto</th><th className="num-col">Cant.</th><th className="num-col">Importe</th></tr></thead>
              <tbody>
                {rows.map((line) => (
                  <tr key={line.name}>
                    <td>
                      {line.name}
                      <div className="bar thin" aria-hidden="true"><span style={{ width: `${topRevenue > 0 ? Math.round((Number(line.revenue) / topRevenue) * 100) : 0}%` }} /></div>
                    </td>
                    <td className="num-col num">{line.quantity}</td>
                    <td className="num-col num">{money(line.revenue)}</td>
                  </tr>
                ))}
                {rows.length === 0 ? <tr><td colSpan={3} className="hint">No hay ventas en este rango.</td></tr> : null}
              </tbody>
            </table>
          </div>
        </section>

        <section>
          <div className="section-title">
            <h2>Tiempos de preparación</h2>
            <span className="chip info"><Icon name="clock" />promedio {formatSeconds(prep.data?.average_seconds ?? null)}</span>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Área</th><th className="num-col">Promedio</th><th className="num-col">Mediciones</th></tr></thead>
              <tbody>
                {(prep.data?.lines ?? []).map((line) => (
                  <tr key={line.area}>
                    <td>{AREA_NAME[line.area] ?? line.area}</td>
                    <td className="num-col num">{formatSeconds(line.average_seconds)}</td>
                    <td className="num-col num">{line.items_measured}</td>
                  </tr>
                ))}
                {(prep.data?.lines ?? []).length === 0 ? <tr><td colSpan={3} className="hint">No hay mediciones en este rango.</td></tr> : null}
              </tbody>
            </table>
          </div>
          <p className="hint" style={{ marginTop: "var(--s2)" }}>Las áreas cuentan tareas: un plato en varias áreas aparece una vez en cada una.</p>
        </section>
      </div>
    </div>
  );
}
