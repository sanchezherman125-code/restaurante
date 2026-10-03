import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { reportsApi, shiftsApi } from "../../api/endpoints";
import { Modal } from "../../components/Modal";
import { EmptyState, Spinner } from "../../components/Layout";
import { money } from "../../hooks/useElapsed";
import type { ShiftReport } from "../../types/api";

function formatSeconds(seconds: number | null): string {
  if (seconds === null || seconds === undefined) return "—";
  const min = Math.floor(seconds / 60);
  const sec = Math.round(seconds % 60);
  return `${min}m ${sec}s`;
}

function ReportView({ report }: { report: ShiftReport }) {
  return (
    <div className="stack">
      <div className="grid-2">
        <div className="kpi">
          <div className="label">Ventas</div>
          <div className="value">{money(report.sales.total_sales)}</div>
        </div>
        <div className="kpi">
          <div className="label">Neto</div>
          <div className="value">{money(report.sales.net_result)}</div>
        </div>
      </div>

      <table className="data">
        <tbody>
          <tr>
            <td>Pedidos</td>
            <td>{report.sales.orders_count}</td>
          </tr>
          <tr>
            <td>Mesas atendidas</td>
            <td>{report.sales.tables_served}</td>
          </tr>
          <tr>
            <td>Personas</td>
            <td>{report.sales.persons_served}</td>
          </tr>
          <tr>
            <td>Gastos</td>
            <td>{money(report.sales.total_expenses)}</td>
          </tr>
        </tbody>
      </table>

      <div>
        <strong>Productos</strong>
        {report.products.lines.map((line) => (
          <div className="item-row" key={line.name}>
            <span className="name">{line.name}</span>
            <span className="hint">×{line.quantity}</span>
            <strong>{money(line.revenue)}</strong>
          </div>
        ))}
      </div>

      <div>
        <strong>Preparación</strong>
        {report.preparation.lines.map((line) => (
          <div className="item-row" key={line.area}>
            <span className="name">{line.area}</span>
            <span className="hint">{line.items_measured} mediciones</span>
            <strong>{formatSeconds(line.average_seconds)}</strong>
          </div>
        ))}
        {report.preparation.lines.length === 0 ? <div className="hint">Sin mediciones.</div> : null}
      </div>

      <div>
        <strong>Gastos</strong>
        {report.expenses.map((expense) => (
          <div className="item-row" key={expense.id}>
            <span className="name">{expense.description}</span>
            <strong>{money(expense.amount)}</strong>
          </div>
        ))}
        {report.expenses.length === 0 ? <div className="hint">Sin gastos.</div> : null}
      </div>

      <div>
        <strong>Lista de compras</strong>
        {report.purchase_list.map((item) => (
          <div className="item-row" key={item.id}>
            <span className="name">{item.description}</span>
            <span className="hint">{item.area}</span>
          </div>
        ))}
        {report.purchase_list.length === 0 ? <div className="hint">Sin pendientes de compra.</div> : null}
      </div>
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

  if (history.isLoading) return <Spinner label="Cargando historial…" />;

  return (
    <div className="stack">
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2>Historial de turnos</h2>
        <span className="hint">{history.data?.length ?? 0} registros</span>
      </div>

      {(history.data ?? []).length === 0 ? (
        <EmptyState icon="🗓️" title="No hay turnos cerrados" hint="Cierre un turno desde la pantalla de Turnos." />
      ) : (
        (history.data ?? []).map((shift) => (
          <div className="card" key={shift.id}>
            <div className="row wrap">
              <div className="grow">
                <strong>{new Date(shift.opened_at).toLocaleString("es-PE")}</strong>
                <div className="hint">
                  {shift.closed_at ? `Cerrado: ${new Date(shift.closed_at).toLocaleString("es-PE")}` : "Sin cerrar"}
                </div>
                {shift.snapshot ? (
                  <div className="hint">
                    Ventas {money(String(shift.snapshot["total_sales"] ?? 0))} · Neto{" "}
                    {money(String(shift.snapshot["net_result"] ?? 0))}
                  </div>
                ) : null}
              </div>
              <button className="btn small" onClick={() => setSelected(shift.id)}>
                Ver reporte
              </button>
            </div>
          </div>
        ))
      )}

      {selected ? (
        <Modal title="Reporte de turno" onClose={() => setSelected(null)}>
          {report.isLoading ? (
            <Spinner />
          ) : report.isError || !report.data ? (
            <div className="hint">No se pudo cargar el reporte.</div>
          ) : (
            <ReportView report={report.data} />
          )}
        </Modal>
      ) : null}
    </div>
  );
}
