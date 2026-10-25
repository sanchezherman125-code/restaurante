import { create } from "zustand";
import type { QueuedOperation, SyncStatus } from "../types/api";
import { flushQueue, getBackoffMs, retryOperation, discardOperation } from "../offline/queue";
import { clearSynced, listOperations, onQueueChange, recoverInterruptedOperations } from "../offline/queue-db";
import { useSession } from "./session";

interface QueueState {
  operations: QueuedOperation[];
  /** ``operations`` proviene de una lectura completa de IndexedDB hecha para ``ownerId``. */
  loaded: boolean;
  /** Usuario para el que se leyó ``operations`` (null mientras no hay lectura vigente). */
  ownerId: string | null;
  /** Momento en que empezó la lectura de ``operations``: lo creado después puede no figurar. */
  snapshotAt: number;
  flushing: boolean;
  online: boolean;
  refresh: () => Promise<void>;
  flush: () => Promise<void>;
  retry: (id: string) => Promise<void>;
  discard: (id: string) => Promise<void>;
  clearSynced: () => Promise<void>;
  setOnline: (online: boolean) => void;
}

/** Cambia con cada cambio de usuario: una lectura iniciada en otra generación nunca se aplica. */
let generation = 0;

const sessionUserId = () => useSession.getState().user?.id ?? null;

/**
 * Lee la cola y la publica solo si, al terminar, siguen activos el mismo usuario y la misma generación.
 * Una lectura lenta de Ana que termina después del ingreso de Luis se descarta sin tocar su estado.
 */
async function reload(set: (state: Partial<QueueState>) => void): Promise<void> {
  const readGeneration = generation;
  const ownerId = sessionUserId();
  const snapshotAt = Date.now();
  const all = await listOperations();
  if (readGeneration !== generation || ownerId !== sessionUserId()) return;
  set({
    operations: all.filter((op) => !op.owner_user_id || op.owner_user_id === ownerId),
    loaded: true,
    ownerId,
    snapshotAt,
  });
}

export const useQueue = create<QueueState>((set, get) => ({
  operations: [],
  loaded: false,
  ownerId: null,
  snapshotAt: 0,
  flushing: false,
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  refresh: () => reload(set),
  flush: async () => {
    if (get().flushing || !useSession.getState().user) return;
    set({ flushing: true });
    try {
      await flushQueue();
    } finally {
      set({ flushing: false });
      await reload(set);
    }
  },
  retry: async (id) => {
    await retryOperation(id);
    await reload(set);
    void get().flush();
  },
  discard: async (id) => {
    await discardOperation(id);
    await reload(set);
  },
  clearSynced: async () => {
    await clearSynced();
    await reload(set);
  },
  setOnline: (online) => set({ online }),
}));

export function queueCounts(operations: QueuedOperation[]): Record<SyncStatus, number> {
  const counts: Record<SyncStatus, number> = {
    LOCAL_PENDING: 0,
    SENDING: 0,
    SYNCED: 0,
    SYNC_ERROR: 0,
  };
  for (const op of operations) counts[op.status] += 1;
  return counts;
}

export function hasUnsynced(operations: QueuedOperation[]): boolean {
  return operations.some((op) => op.status === "LOCAL_PENDING" || op.status === "SENDING" || op.status === "SYNC_ERROR");
}

onQueueChange(() => {
  void useQueue.getState().refresh();
});

useSession.subscribe((state, previous) => {
  if (state.user?.id !== previous.user?.id) {
    // Nueva generación: hasta releer IndexedDB no se conocen las operaciones del nuevo usuario.
    generation += 1;
    useQueue.setState({ operations: [], loaded: false, ownerId: null });
    void useQueue.getState().refresh();
    if (state.user) void useQueue.getState().flush();
  }
});

let started = false;

export function startQueueSync(): void {
  if (started) return;
  started = true;
  const store = useQueue.getState();
  void (async () => {
    await recoverInterruptedOperations();
    await store.refresh();
    await store.flush();
  })();

  window.addEventListener("online", () => {
    useQueue.getState().setOnline(true);
    void useQueue.getState().flush();
  });
  window.addEventListener("offline", () => useQueue.getState().setOnline(false));

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") void useQueue.getState().flush();
  });

  const tick = async () => {
    if (useQueue.getState().operations.some((op) => op.status === "LOCAL_PENDING")) {
      await useQueue.getState().flush();
    } else {
      await useQueue.getState().refresh();
    }
    window.setTimeout(() => void tick(), Math.max(15000, getBackoffMs() + 1000));
  };
  window.setTimeout(() => void tick(), 15000);

}
