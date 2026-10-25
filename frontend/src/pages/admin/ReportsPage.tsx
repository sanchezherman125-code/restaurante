import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { reportsApi, shiftsApi } from "../../api/endpoints";
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

type Period = "shift" | "today" | "7d" | "month" | "all" | "custom";

const PERIOD_LABEL: Record<Exclude<Period, "custom">, string> = {
  shift: "Turno actual", today: "Hoy", "7d": "7 días", month: "Este mes", all: "Todo",
};

/** Fecha calendario (AAAA-MM-DD) en Perú, sin depender de la zona horaria del dispositivo. */
export function peruDate(at: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

function shiftDays(isoDate: string, days: number): string {
  const [year, month, day] = isoDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

/** Parámetros del reporte para cada período. Sin parámetros el servidor responde el turno actual. */
export function periodParams(period: Period, dateFrom: string, dateTo: string, now: Date = new Date()): Record<string, string> {
  const today = peruDate(now);
  switch (period) {
    case "shift": return {};
    case "today": return { date_from: today, date_to: today };
    case "7d": return { date_from: shiftDays(today, -6), date_to: today };
    case "month": return { date_from: `${today.slice(0, 8)}01`, date_to: today };
    case "all": return { scope: "all" };
    case "custom": return { ...(dateFrom ? { date_from: dateFrom } : {}), ...(dateTo ? { date_to: dateTo } : {}) };
  }
}

export function ReportsPage() {
  const [period, setPeriod] = useState<Period>("shift");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");

  const params = periodParams(period, dateFrom, dateTo);
  const shownFrom = params.date_from ?? "";
  const shownTo = params.date_to ?? "";

  const sales = useQuery({ queryKey: ["reports", "sales", params], queryFn: () => reportsApi.sales(params), retry: false });
  const products = useQuery({ queryKey: ["reports", "products", params], queryFn: () => reportsApi.products(params), retry: false });
  const prep = useQuery({ queryKey: ["reports", "preparation", params], queryFn: () => reportsApi.preparation(params), retry: false });
  const shift = useQuery({ queryKey: ["shifts", "current"], queryFn: shiftsApi.current, retry: false });

  function customRange(from: string, to: string) {
    setPeriod(from || to ? "custom" : "shift");
    setDateFrom(from);
    setDateTo(to);
  }

  const subtitle = period === "all" ? "Historial completo"
    : period === "custom" ? "Rango personalizado (fecha de apertura del turno, hora de Perú)"
    : period === "shift" ? (shift.data?.status === "OPEN" ? "Turno abierto" : "Sin turno abierto: se muestra el último turno")
    : `${PERIOD_LABEL[period]} · turnos abiertos en el período (hora de Perú)`;

  if (sales.isLoading) return <div className="page"><PageHeader title="Reportes" /><SkeletonList rows={3} height={90} label="Generando reportes" /></div>;

  const rows = products.data?.lines ?? [];
  const topRevenue = Math.max(0, ...rows.map((line) => Number(line.revenue)));
  const net = Number(sales.data?.net_result ?? 0);

  return (
    <div className="page">
      <PageHeader title="Reportes" subtitle={subtitle} />

      <section className="card filters" aria-label="Rango de fechas">
        <div className="field">
          <label className="label" htmlFor="rep-from">Desde</label>
          <input id="rep-from" className="input" type="date" value={shownFrom} max={shownTo || undefined} onChange={(event) => customRange(event.target.value, shownTo)} />
        </div>
        <div className="field">
          <label className="label" htmlFor="rep-to">Hasta</label>
          <input id="rep-to" className="input" type="date" value={shownTo} min={shownFrom || undefined} onChange={(event) => customRange(shownFrom, event.target.value)} />
        </div>
        <div className="segmented" role="group" aria-label="Rangos rápidos">
          {(Object.keys(PERIOD_LABEL) as (keyof typeof PERIOD_LABEL)[]).map((key) => (
            <button key={key} className={period === key ? "active" : ""} aria-pressed={period === key} onClick={() => setPeriod(key)}>
              {PERIOD_LABEL[key]}
            </button>
          ))}
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
