import { beforeEach, describe, expect, it, vi } from "vitest";
import type { QueuedOperation, User } from "../types/api";

// IndexedDB controlada: cada lectura queda pendiente hasta que la prueba decide resolverla.
const db = vi.hoisted(() => ({
  reads: [] as { resolve: (ops: QueuedOperation[]) => void }[],
  deleteOperation: vi.fn(),
}));
vi.mock("../offline/queue-db", () => ({
  listOperations: () => new Promise<QueuedOperation[]>((resolve) => db.reads.push({ resolve })),
  getOperation: vi.fn(),
  putOperation: vi.fn(),
  deleteOperation: db.deleteOperation,
  clearSynced: vi.fn(),
  onQueueChange: () => () => undefined,
  recoverInterruptedOperations: vi.fn(),
}));
vi.mock("../api/endpoints", () => ({ authApi: { me: vi.fn(), login: vi.fn(), logout: vi.fn() } }));

const { useSession } = await import("./session");
const { useQueue } = await import("./queue");
const { usePendingOrders } = await import("./pendingOrders");

const user = (id: string, name: string): User => ({ id, username: name, display_name: name, role: "WAITER", is_active: true, created_at: "" });
const op = (id: string, owner: string): QueuedOperation => ({
  client_operation_id: id, owner_user_id: owner, operation_type: "OPEN_TABLE_WITH_COMMAND", path: "/api/v1/orders/open-with-command",
  method: "POST", body: {}, parent_operation_id: null, created_at: 1, attempt_count: 0, last_attempt_at: null,
  status: "LOCAL_PENDING", last_error: null,
});
const anaOp = op("op-ana", "ana");
const luisOp = op("op-luis", "luis");
const luisRecord = { operation_id: "op-luis", table_id: "t2", table_name: "Mesa 2", persons_count: 2, created_at: 1, server_order_id: null, error: null };

describe("cambio de usuario con lecturas de IndexedDB demoradas", () => {
  beforeEach(() => {
    db.reads.length = 0;
    db.deleteOperation.mockReset();
    localStorage.clear();
  });

  it("una lectura antigua de Ana que termina después no reemplaza la cola de Luis ni borra sus referencias", async () => {
    useSession.setState({ user: user("ana", "Ana") });
    const anaRead = useQueue.getState().refresh();            // lectura lenta iniciada por Ana
    const anaPending = db.reads.at(-1)!;

    useSession.setState({ user: user("luis", "Luis") });      // Luis ingresa; nueva generación y nueva lectura
    localStorage.setItem("restaurante.pendingOrders.luis", JSON.stringify([luisRecord]));
    usePendingOrders.setState({ records: [luisRecord] });
    const luisPending = db.reads.at(-1)!;
    expect(luisPending).not.toBe(anaPending);

    luisPending.resolve([anaOp, luisOp]);                       // termina primero la de Luis
    await vi.waitFor(() => expect(useQueue.getState().ownerId).toBe("luis"));
    expect(useQueue.getState().operations.map((o) => o.client_operation_id)).toEqual(["op-luis"]);

    anaPending.resolve([anaOp]);                                // después la de Ana, sin la operación de Luis
    await anaRead;
    expect(useQueue.getState().ownerId).toBe("luis");
    expect(useQueue.getState().operations.map((o) => o.client_operation_id)).toEqual(["op-luis"]);
    expect(usePendingOrders.getState().records).toEqual([luisRecord]);
    expect(JSON.parse(localStorage.getItem("restaurante.pendingOrders.luis")!)).toEqual([luisRecord]);
    expect(db.deleteOperation).not.toHaveBeenCalled();
  });

  it("mientras no hay lectura vigente del nuevo usuario, nada se interpreta como operación eliminada", () => {
    useSession.setState({ user: user("luis", "Luis") });
    usePendingOrders.setState({ records: [luisRecord] });
    useQueue.setState({ operations: [anaOp], loaded: true, ownerId: "ana", snapshotAt: Date.now() });
    expect(usePendingOrders.getState().records).toEqual([luisRecord]);
    useQueue.setState({ operations: [], loaded: false, ownerId: null, snapshotAt: Date.now() });
    expect(usePendingOrders.getState().records).toEqual([luisRecord]);
  });
});
