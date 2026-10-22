import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { reportsApi, shiftsApi } from "../../api/endpoints";
import { Icon } from "../../components/Icon";
import { Modal } from "../../components/Modal";
import { EmptyState, Kpi, PageHeader, SkeletonList } from "../../components/Layout";
import { money } from "../../hooks/useElapsed";
import { AREA_NAME } from "../../lib/labels";
import type { ShiftReport } from "../../types/api";

function formatSeconds(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return "—";
  const min = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return `${min}m ${sec}s`;
}

function Section({ title, empty, children }: { title: string; empty?: string; children: React.ReactNode[] }) {
  return (
    <section className="report-section">
      <h3>{title}</h3>
      {children.length === 0 ? <div className="hint">{empty}</div> : children}
    </section>
  );
}

function ReportView({ report }: { report: ShiftReport }) {
  return (
    <div className="stack">
      <div className="kpi-grid">
        <Kpi label="Ventas" value={money(report.sales.total_sales)} tone="accent" />
        <Kpi label="Gastos" value={money(report.sales.total_expenses)} />
        <Kpi label="Neto" value={money(report.sales.net_result)} tone={Number(report.sales.net_result) < 0 ? "neg" : undefined} />
      </div>
      <p className="hint">{report.sales.orders_count} pedidos · {report.sales.tables_served} mesas atendidas · {report.sales.persons_served} personas</p>

      <Section title="Productos vendidos" empty="No se vendieron productos.">
        {report.products.lines.map((line) => (
          <div className="item-row" key={line.name}>
            <span className="name">{line.name}</span>
            <span className="hint">×{line.quantity}</span>
            <strong className="num">{money(line.revenue)}</strong>
          </div>
        ))}
      </Section>
      <Section title="Tiempos de preparación" empty="Sin mediciones.">
        {report.preparation.lines.map((line) => (
          <div className="item-row" key={line.area}>
            <span className="name">{AREA_NAME[line.area] ?? line.area}</span>
            <span className="hint">{line.items_measured} mediciones</span>
            <strong className="num">{formatSeconds(line.average_seconds)}</strong>
          </div>
        ))}
      </Section>
      <Section title="Gastos" empty="Sin gastos.">
        {report.expenses.map((expense) => (
          <div className="item-row" key={expense.id}>
            <span className="name">{expense.description}</span>
            <strong className="num">{money(expense.amount)}</strong>
          </div>
        ))}
      </Section>
      <Section title="Lista de compras" empty="Sin pendientes de compra.">
        {report.purchase_list.map((item) => (
          <div className="item-row" key={item.id}>
            <span className="name">{item.description}</span>
            <span className="hint">{AREA_NAME[item.area] ?? item.area}</span>
          </div>
        ))}
      </Section>
    </div>
  );
}

export function HistoryPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [selected, setSelected] = useState<string | null>(searchParams.get("shift"));

  const history = useQuery({ queryKey: ["shifts", "history"], queryFn: () => shiftsApi.history(), retry: false });
  const report = useQuery({
    queryKey: ["reports", "shift", selected],
    queryFn: () => reportsApi.shift(selected!),
    enabled: !!selected,
    retry: false,
  });

  useEffect(() => {
    if (selected) setSearchParams({ shift: selected }, { replace: true });
    else setSearchParams({}, { replace: true });
  }, [selected, setSearchParams]);

  if (history.isLoading) return <div className="page"><PageHeader title="Historial de turnos" /><SkeletonList rows={5} height={56} label="Cargando historial" /></div>;

  const time = (value: string) => new Date(value).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
  const day = (value: string) => new Date(value).toLocaleDateString("es-PE", { weekday: "short", day: "2-digit", month: "short", year: "numeric" });

  return (
    <div className="page">
      <PageHeader title="Historial de turnos" subtitle={`${history.data?.length ?? 0} turnos cerrados`} />

      {(history.data ?? []).length === 0 ? (
        <EmptyState icon="history" title="No hay turnos cerrados" hint="Cuando cierre un turno aparecerá aquí con su reporte completo."
          action={undefined} />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr><th>Fecha</th><th>Horario</th><th className="num-col">Ventas</th><th className="num-col">Neto</th><th><span className="visually-hidden">Acciones</span></th></tr>
            </thead>
            <tbody>
              {(history.data ?? []).map((shift) => (
                <tr key={shift.id}>
                  <td><strong>{day(shift.opened_at)}</strong></td>
                  <td className="hint">{time(shift.opened_at)}{shift.closed_at ? ` – ${time(shift.closed_at)}` : " · sin cerrar"}</td>
                  <td className="num-col num">{shift.snapshot ? money(String(shift.snapshot["total_sales"] ?? 0)) : "—"}</td>
                  <td className="num-col num">{shift.snapshot ? money(String(shift.snapshot["net_result"] ?? 0)) : "—"}</td>
                  <td className="num-col">
                    <button className="btn small secondary" aria-label={`Ver reporte del ${day(shift.opened_at)}`} onClick={() => setSelected(shift.id)}>
                      Ver reporte<Icon name="chevronRight" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected ? (
        <Modal title="Reporte de turno" className="wide" onClose={() => setSelected(null)}>
          {report.isLoading ? (
            <SkeletonList rows={3} height={72} label="Cargando reporte" />
          ) : report.isError || !report.data ? (
            <div className="hint">No se pudo cargar el reporte. Verifique la conexión e intente de nuevo.</div>
          ) : (
            <ReportView report={report.data} />
          )}
        </Modal>
      ) : null}
    </div>
  );
}
