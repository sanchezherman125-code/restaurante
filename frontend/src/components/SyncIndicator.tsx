import { queueCounts, useQueue } from "../stores/queue";
import { useState } from "react";
import { ConfirmDialog, Modal } from "./Modal";
import { Icon } from "./Icon";

export function SyncIndicator() {
  const [showErrors, setShowErrors] = useState(false);
  const [discardId, setDiscardId] = useState<string | null>(null);
  const operations = useQueue((state) => state.operations);
  const flushing = useQueue((state) => state.flushing);
  const flush = useQueue((state) => state.flush);
  const counts = queueCounts(operations);

  if (counts.SYNC_ERROR > 0) {
    return (
      <>
      <button data-testid="sync-indicator" className="sync-pill error" onClick={() => setShowErrors(true)} title="Hay operaciones con error de sincronización">
        <Icon name="alert" /> {counts.SYNC_ERROR} con error
      </button>
      {showErrors ? <Modal title="Operaciones que no se pudieron enviar" onClose={() => setShowErrors(false)}>
        <div className="stack">
          <p className="hint">Estas operaciones siguen guardadas solo en este dispositivo: el servidor no las recibió.</p>
          {operations.filter((op) => op.status === "SYNC_ERROR").map((op) => (
            <div className="card" key={op.client_operation_id}>
              <p>{op.last_error ?? "No se pudo sincronizar la operación."}</p>
              <div className="row">
                <button className="btn secondary" onClick={() => void useQueue.getState().retry(op.client_operation_id)}>Reintentar</button>
                <button className="btn danger" onClick={() => setDiscardId(op.client_operation_id)}>Descartar</button>
              </div>
            </div>
          ))}
        </div>
      </Modal> : null}
      {discardId ? <ConfirmDialog
        title="Descartar operación local"
        message="Esta operación dejará de enviarse. Verifique primero si ya se registró en el servidor."
        confirmLabel="Descartar" danger
        onConfirm={() => { void useQueue.getState().discard(discardId); setDiscardId(null); }}
        onCancel={() => setDiscardId(null)}
      /> : null}
      </>
    );
  }
  if (counts.LOCAL_PENDING + counts.SENDING > 0) {
    return (
      <button
        data-testid="sync-indicator"
        className="sync-pill pending"
        onClick={() => void flush()}
        title="Guardadas solo en este dispositivo hasta recuperar la conexión. Toque para reintentar."
        disabled={flushing}
      >
        <Icon name={flushing ? "refresh" : "cloud"} className={flushing ? "spin" : undefined} /> {counts.LOCAL_PENDING + counts.SENDING} por enviar
      </button>
    );
  }
  if (counts.SYNCED > 0) {
    return (
      <button data-testid="sync-indicator" className="sync-pill ok" onClick={() => void useQueue.getState().clearSynced()} title="Sincronizado — toque para limpiar">
        <Icon name="check" /> sincronizado
      </button>
    );
  }
  return null;
}
