import { queueCounts, useQueue } from "../stores/queue";
import { useState } from "react";
import { ConfirmDialog, Modal } from "./Modal";

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
        ⚠ {counts.SYNC_ERROR} con error
      </button>
      {showErrors ? <Modal title="Pendientes de sincronización" onClose={() => setShowErrors(false)}>
        <div className="stack">
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
        title="Operaciones pendientes de sincronizar"
        disabled={flushing}
      >
        {flushing ? "↻" : "☁"} {counts.LOCAL_PENDING + counts.SENDING} por enviar
      </button>
    );
  }
  if (counts.SYNCED > 0) {
    return (
      <button data-testid="sync-indicator" className="sync-pill ok" onClick={() => void useQueue.getState().clearSynced()} title="Sincronizado — toque para limpiar">
        ✓ sincronizado
      </button>
    );
  }
  return null;
}
