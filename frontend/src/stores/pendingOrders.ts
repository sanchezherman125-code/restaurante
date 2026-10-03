import { create } from "zustand";
import { useQueue } from "./queue";

export interface PendingOrder {
  operation_id: string;
  table_id: string | null;
  table_name: string;
  persons_count: number | null;
  created_at: number;
  server_order_id: string | null;
  error: string | null;
}

const STORAGE_KEY = "restaurante.pendingOrders";

function load(): PendingOrder[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as PendingOrder[];
  } catch {
    return [];
  }
}

function save(records: PendingOrder[]): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(records));
}

interface PendingOrdersState {
  records: PendingOrder[];
  add: (record: PendingOrder) => void;
  remove: (operationId: string) => void;
  byTable: (tableId: string) => PendingOrder | undefined;
  sync: () => void;
}

export const usePendingOrders = create<PendingOrdersState>((set, get) => ({
  records: load(),
  add: (record) => {
    const records = [...get().records.filter((r) => r.operation_id !== record.operation_id), record];
    save(records);
    set({ records });
  },
  remove: (operationId) => {
    const records = get().records.filter((r) => r.operation_id !== operationId);
    save(records);
    set({ records });
  },
  byTable: (tableId) => get().records.find((r) => r.table_id === tableId && !r.error),
  sync: () => {
    const operations = useQueue.getState().operations;
    const records = get().records;
    let changed = false;
    const next = records.map((record) => {
      const op = operations.find((o) => o.client_operation_id === record.operation_id);
      if (!op) return record;
      if (op.status === "SYNCED") {
        const serverOrderId = op.server_resource_id ?? null;
        if (record.server_order_id !== serverOrderId) {
          changed = true;
          return { ...record, server_order_id: serverOrderId };
        }
        return record;
      }
      if (op.status === "SYNC_ERROR" && record.error !== (op.last_error ?? "error")) {
        changed = true;
        return { ...record, error: op.last_error ?? "No se pudo sincronizar el pedido." };
      }
      return record;
    });
    if (changed) {
      save(next);
      set({ records: next });
    }
  },
}));

useQueue.subscribe((state) => {
  if (state.operations.length > 0 || usePendingOrders.getState().records.length > 0) {
    usePendingOrders.getState().sync();
  }
});
