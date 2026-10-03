import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { shiftsApi } from "../../api/endpoints";
import { ConfirmDialog } from "../../components/Modal";
import { EmptyState, Spinner } from "../../components/Layout";
import { errorMessage } from "../../lib/send";
import { useUi } from "../../stores/ui";

export function ShiftsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useUi((state) => state.toast);
  const [confirmClose, setConfirmClose] = useState(false);
  const [busy, setBusy] = useState(false);

  const shift = useQuery({ queryKey: ["shifts", "current"], queryFn: shiftsApi.current, retry: false });
  const history = useQuery({ queryKey: ["shifts", "history"], queryFn: () => shiftsApi.history(), retry: false });

  const current = shift.data && shift.data.status === "OPEN" ? shift.data : null;

  async function openShift() {
    setBusy(true);
    try {
      await shiftsApi.open();
      toast("success", "Turno abierto");
      void queryClient.invalidateQueries({ queryKey: ["shifts"] });
      void queryClient.invalidateQueries({ queryKey: ["reports"] });
    } catch (error) {
      toast("error", "No se pudo abrir el turno", errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function closeShift() {
    if (!current) return;
    setBusy(true);
    try {
      await shiftsApi.close(current.id);
      toast("success", "Turno cerrado", "El reporte del turno quedó guardado.");
      void queryClient.invalidateQueries({ queryKey: ["shifts"] });
      void queryClient.invalidateQueries({ queryKey: ["reports"] });
    } catch (error) {
      const message = errorMessage(error);
      toast("error", "No se pudo cerrar el turno", message.includes("SHIFT_HAS_OPEN_ORDERS") ? "Hay pedidos sin finalizar o pagar." : message);
    } finally {
      setBusy(false);
      setConfirmClose(false);
    }
  }

  return (
    <div className="stack">
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2>Turnos</h2>
      </div>

      <div className="card">
        {shift.isLoading ? (
          <Spinner />
        ) : current ? (
          <>
            <div className="row wrap">
              <div className="grow">
                <h2>Turno abierto</h2>
                <div className="hint">
                  Inicio: {new Date(current.opened_at).toLocaleString("es-PE")}
                </div>
              </div>
              <span className="chip open">abierto</span>
            </div>
            <button
              className="btn danger block"
              style={{ marginTop: 12 }}
              onClick={() => setConfirmClose(true)}
              disabled={busy}
            >
              Cerrar turno
            </button>
          </>
        ) : (
          <>
            <h2>No hay turno abierto</h2>
            <p className="hint">Debe abrir un turno para registrar pedidos, comandas, gastos y cobros.</p>
            <button className="btn block" onClick={() => void openShift()} disabled={busy}>
              {busy ? "Abriendo…" : "Abrir turno"}
            </button>
          </>
        )}
      </div>

      <div className="section-title">
        <h2>Historial</h2>
        <button className="btn ghost small" onClick={() => navigate("/historial")}>
          Ver reportes →
        </button>
      </div>

      {history.isLoading ? (
        <Spinner />
      ) : (history.data ?? []).length === 0 ? (
        <EmptyState icon="🗓️" title="Sin turnos cerrados" />
      ) : (
        (history.data ?? []).slice(0, 10).map((entry) => (
          <div className="card" key={entry.id}>
            <div className="row wrap">
              <div className="grow">
                <strong>{new Date(entry.opened_at).toLocaleDateString("es-PE")}</strong>
                <div className="hint">
                  {new Date(entry.opened_at).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" })}
                  {entry.closed_at
                    ? ` → ${new Date(entry.closed_at).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" })}`
                    : ""}
                </div>
              </div>
              <span className={`chip ${entry.status === "CLOSED" ? "" : "open"}`}>{entry.status === "CLOSED" ? "cerrado" : "abierto"}</span>
              <button className="btn small secondary" onClick={() => navigate(`/historial?shift=${entry.id}`)}>
                Reporte
              </button>
            </div>
          </div>
        ))
      )}

      {confirmClose && current ? (
        <ConfirmDialog
          title="Cerrar turno"
          message="Se generará el reporte de ventas, productos, tiempos de preparación, gastos y lista de compras. Los pedidos deben estar pagados."
          confirmLabel="Cerrar turno"
          danger
          onConfirm={() => void closeShift()}
          onCancel={() => setConfirmClose(false)}
        />
      ) : null}
    </div>
  );
}
