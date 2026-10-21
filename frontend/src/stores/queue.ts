import { create } from "zustand";
import type { QueuedOperation, SyncStatus } from "../types/api";
import { flushQueue, getBackoffMs, retryOperation, discardOperation } from "../offline/queue";
import { clearSynced, listOperations, onQueueChange, recoverInterruptedOperations } from "../offline/queue-db";
import { useSession } from "./session";

interface QueueState {
  operations: QueuedOperation[];
  flushing: boolean;
  online: boolean;
  refresh: () => Promise<void>;
  flush: () => Promise<void>;
  retry: (id: string) => Promise<void>;
  discard: (id: string) => Promise<void>;
  clearSynced: () => Promise<void>;
  setOnline: (online: boolean) => void;
}

async function currentOperations(): Promise<QueuedOperation[]> {
  const userId = useSession.getState().user?.id;
  return (await listOperations()).filter((op) => !op.owner_user_id || op.owner_user_id === userId);
}

export const useQueue = create<QueueState>((set, get) => ({
  operations: [],
  flushing: false,
  online: typeof navigator === "undefined" ? true : navigator.onLine,
  refresh: async () => {
    set({ operations: await currentOperations() });
  },
  flush: async () => {
    if (get().flushing || !useSession.getState().user) return;
    set({ flushing: true });
    try {
      await flushQueue();
    } finally {
      set({ flushing: false, operations: await currentOperations() });
    }
  },
  retry: async (id) => {
    await retryOperation(id);
    set({ operations: await currentOperations() });
    void get().flush();
  },
  discard: async (id) => {
    await discardOperation(id);
    set({ operations: await currentOperations() });
  },
  clearSynced: async () => {
    await clearSynced();
    set({ operations: await currentOperations() });
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
