import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueue, flushQueue, getBackoffMs, resetBackoff } from "./queue";
import { deleteOperation, listOperations, onQueueChange, putOperation, recoverInterruptedOperations } from "./queue-db";

function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(async () => {
  resetBackoff();
  vi.restoreAllMocks();
  localStorage.clear();
  for (const op of await listOperations()) {
    await deleteOperation(op.client_operation_id);
  }
});

describe("cola offline", () => {
  it("guarda operaciones como LOCAL_PENDING", async () => {
    const op = await enqueue({
      operation_type: "REGISTER_EXPENSE",
      path: "/api/v1/expenses",
      method: "POST",
      body: { amount: "10.00", description: "limón" },
    });

    expect(op.status).toBe("LOCAL_PENDING");
    expect(op.client_operation_id).toMatch(/^[0-9a-f-]{36}$/i);
    const stored = await listOperations();
    expect(stored).toHaveLength(1);
    expect(stored[0].operation_type).toBe("REGISTER_EXPENSE");
  });

  it("sincroniza y marca SYNCED con el id devuelto por el servidor", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "order-123" }));
    vi.stubGlobal("fetch", fetchMock);

    const op = await enqueue({
      operation_type: "CREATE_ORDER",
      path: "/api/v1/orders",
      method: "POST",
      body: { order_type: "DINE_IN" },
    });

    const result = await flushQueue();

    expect(result.synced).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(op.client_operation_id);

    const stored = await listOperations();
    expect(stored[0].status).toBe("SYNCED");
    expect(stored[0].server_resource_id).toBe("order-123");
  });

  it("reintenta con backoff cuando no hay red", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("Failed to fetch")),
    );

    await enqueue({
      operation_type: "CREATE_COMMAND",
      path: "/api/v1/orders/abc/commands",
      method: "POST",
      body: { items: [] },
    });

    const result = await flushQueue();

    expect(result.networkFailure).toBe(true);
    expect(getBackoffMs()).toBeGreaterThan(0);
    const stored = await listOperations();
    expect(stored[0].status).toBe("LOCAL_PENDING");

    // con backoff activo no vuelve a intentar
    const second = await flushQueue();
    expect(second.synced).toHaveLength(0);
  });

  it("marca SYNC_ERROR ante respuestas 4xx del servidor", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          { error: { code: "TABLE_ALREADY_OPEN", message: "La mesa ya está abierta.", details: {} } },
          409,
        ),
      ),
    );

    await enqueue({
      operation_type: "CREATE_ORDER",
      path: "/api/v1/orders",
      method: "POST",
      body: {},
    });

    const result = await flushQueue();

    expect(result.failed).toHaveLength(1);
    const stored = await listOperations();
    expect(stored[0].status).toBe("SYNC_ERROR");
    expect(stored[0].last_error).toContain("TABLE_ALREADY_OPEN");
  });

  it("espera al pedido padre y resuelve su id en la comanda", async () => {
    let failFirst = true;
    const fetchMock = vi.fn().mockImplementation(async () => {
      if (failFirst) {
        failFirst = false;
        throw new TypeError("Failed to fetch");
      }
      return jsonResponse({ id: "order-xyz" });
    });
    vi.stubGlobal("fetch", fetchMock);

    const orderOp = await enqueue({
      operation_type: "CREATE_ORDER",
      path: "/api/v1/orders",
      method: "POST",
      body: { order_type: "DINE_IN" },
    });
    const commandOp = await enqueue({
      operation_type: "CREATE_COMMAND",
      path: "/api/v1/orders/{orderRef}/commands",
      method: "POST",
      body: { items: [{ menu_item_id: "m1", quantity: 1 }] },
      parent_operation_id: orderOp.client_operation_id,
    });

    // sin red: el pedido no se sincroniza y la comanda espera
    const first = await flushQueue();
    expect(first.networkFailure).toBe(true);
    expect(first.deferred.map((op) => op.client_operation_id)).toContain(commandOp.client_operation_id);

    resetBackoff();
    const second = await flushQueue();
    expect(second.synced.map((op) => op.client_operation_id).sort()).toEqual(
      [orderOp.client_operation_id, commandOp.client_operation_id].sort(),
    );

    const paths = (fetchMock.mock.calls as [string, RequestInit][]).map(([url]) => url);
    expect(paths[0]).toBe("/api/v1/orders");
    expect(paths[paths.length - 1]).toBe("/api/v1/orders/order-xyz/commands");
  });

  it("notifica cambios de la cola", async () => {
    const listener = vi.fn();
    const unsubscribe = onQueueChange(listener);
    await enqueue({
      operation_type: "REGISTER_EXPENSE",
      path: "/api/v1/expenses",
      method: "POST",
      body: {},
    });
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });

  it("recupera un SENDING interrumpido y lo reintenta con el mismo UUID", async () => {
    const op = await enqueue({
      operation_type: "CREATE_COMMAND",
      path: "/api/v1/orders/order-1/commands",
      method: "POST",
      body: { items: [{ menu_item_id: "m1", quantity: 1 }] },
    });
    await putOperation({ ...op, status: "SENDING" });

    await recoverInterruptedOperations();
    expect((await listOperations())[0]).toMatchObject({ client_operation_id: op.client_operation_id, status: "LOCAL_PENDING" });

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "command-1" }));
    vi.stubGlobal("fetch", fetchMock);
    await flushQueue();

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(op.client_operation_id);
    expect((await listOperations())[0].status).toBe("SYNCED");
  });
});
