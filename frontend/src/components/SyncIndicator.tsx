import { queueCounts, useQueue } from "../stores/queue";

export function SyncIndicator() {
  const operations = useQueue((state) => state.operations);
  const flushing = useQueue((state) => state.flushing);
  const flush = useQueue((state) => state.flush);
  const counts = queueCounts(operations);

  if (counts.SYNC_ERROR > 0) {
    return (
      <button data-testid="sync-indicator" className="sync-pill error" onClick={() => void flush()} title="Hay operaciones con error de sincronización">
        ⚠ {counts.SYNC_ERROR} con error
      </button>
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
