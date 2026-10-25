import { beforeEach, describe, expect, it } from "vitest";
import type { QueuedOperation } from "../types/api";
import { usePendingOrders, type PendingOrder } from "./pendingOrders";
import { useQueue } from "./queue";
import { useSession } from "./session";

function op(status: QueuedOperation["status"], extra: Partial<QueuedOperation> = {}): QueuedOperation {
  return {
    client_operation_id: "op-1", owner_user_id: "w1", operation_type: "OPEN_TABLE_WITH_COMMAND",
    path: "/api/v1/orders/open-with-command", method: "POST", body: {}, parent_operation_id: null,
    created_at: 1, attempt_count: 1, last_attempt_at: 1, status, last_error: null, ...extra,
  };
}

const record: PendingOrder = {
  operation_id: "op-1", table_id: "t1", table_name: "Mesa 1", persons_count: 2, created_at: 1000, server_order_id: null, error: null,
};

describe("registro local de la primera comanda", () => {
  beforeEach(() => {
    localStorage.clear();
    useSession.setState({ user: { id: "w1", username: "ana", display_name: "Ana", role: "WAITER", is_active: true, created_at: "" } });
    usePendingOrders.setState({ records: [record] });
  });

  it("refleja el error de sincronización y lo limpia al reintentar", () => {
    useQueue.setState({ operations: [op("SYNC_ERROR", { last_error: "ITEM_SOLD_OUT: agotado" })], loaded: true, snapshotAt: 2000 });
    expect(usePendingOrders.getState().records[0].error).toBe("ITEM_SOLD_OUT: agotado");
    useQueue.setState({ operations: [op("LOCAL_PENDING")], loaded: true, snapshotAt: 3000 });
    expect(usePendingOrders.getState().records[0].error).toBeNull();
  });

  it("registra el pedido del servidor una sola vez al sincronizar", () => {
    useQueue.setState({ operations: [op("SYNCED", { server_resource_id: "order-9" })], loaded: true, snapshotAt: 2000 });
    expect(usePendingOrders.getState().records).toEqual([{ ...record, server_order_id: "order-9" }]);
  });

  it("si la operación se descartó, el registro desaparece y la mesa queda libre", () => {
    useQueue.setState({ operations: [], loaded: true, snapshotAt: 2000 });
    expect(usePendingOrders.getState().records).toEqual([]);
  });

  it("no borra un registro con una lectura de la cola anterior a su creación", () => {
    useQueue.setState({ operations: [], loaded: true, snapshotAt: 500 });
    expect(usePendingOrders.getState().records).toHaveLength(1);
    useQueue.setState({ operations: [], loaded: false, snapshotAt: 5000 });
    expect(usePendingOrders.getState().records).toHaveLength(1);
  });
});
