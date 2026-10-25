import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueue, flushQueue, getBackoffMs, resetBackoff } from "./queue";
import { deleteOperation, listOperations, onQueueChange, putOperation, recoverInterruptedOperations } from "./queue-db";
import { useSession } from "../stores/session";

function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(async () => {
  useSession.setState({ user: null });
  resetBackoff();
  vi.restoreAllMocks();
  localStorage.clear();
  for (const op of await listOperations()) {
    await deleteOperation(op.client_operation_id);
  }
});

describe("cola offline", () => {
  it("no sincroniza operaciones de otro usuario en un dispositivo compartido", async () => {
    const op = await enqueue({ operation_type: "REGISTER_EXPENSE", path: "/api/v1/expenses", method: "POST", body: {} });
    await putOperation({ ...op, owner_user_id: "other-user" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await flushQueue();
    expect(result.deferred).toHaveLength(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
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

  describe("tareas de preparación en un plato compartido", () => {
    const taskOp = (task: string, status: string) => ({
      operation_type: "UPDATE_PREPARATION_TASK" as const,
      path: `/api/v1/orders/o1/items/i1/tasks/${task}/status`,
      method: "POST" as const,
      body: { status },
    });
    const bodyOf = (call: unknown) => JSON.parse(((call as [string, RequestInit])[1].body as string));

    it("envía en orden las actualizaciones de cocina y parrilla con una clave propia cada una", async () => {
      const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ id: "o1" }, 200));
      vi.stubGlobal("fetch", fetchMock);
      const ops = [
        await enqueue(taskOp("papas", "PREPARING")),
        await enqueue(taskOp("alitas", "PREPARING")),
        await enqueue(taskOp("papas", "READY")),
        await enqueue(taskOp("alitas", "READY")),
      ];
      const result = await flushQueue();
      expect(result.synced).toHaveLength(4);
      const calls = fetchMock.mock.calls as [string, RequestInit][];
      expect(calls.map(([url]) => url.split("/").slice(-2)[0])).toEqual(["papas", "alitas", "papas", "alitas"]);
      expect(calls.map((call) => bodyOf(call).status)).toEqual(["PREPARING", "PREPARING", "READY", "READY"]);
      expect(calls.map((call) => bodyOf(call).client_operation_id)).toEqual(ops.map((op) => op.client_operation_id));
      expect(new Set(calls.map(([, init]) => (init.headers as Record<string, string>)["Idempotency-Key"])).size).toBe(4);
    });

    it("tras una desconexión reenvía solo lo pendiente y conserva el mismo UUID", async () => {
      const fetchMock = vi.fn()
        .mockImplementationOnce(async () => jsonResponse({ id: "o1" }, 200))
        .mockRejectedValueOnce(new TypeError("Failed to fetch"));
      vi.stubGlobal("fetch", fetchMock);
      const first = await enqueue(taskOp("papas", "PREPARING"));
      const second = await enqueue(taskOp("papas", "READY"));
      const third = await enqueue(taskOp("alitas", "PREPARING"));

      const interrupted = await flushQueue();
      expect(interrupted.networkFailure).toBe(true);
      expect((await listOperations()).map((op) => op.status)).toEqual(["SYNCED", "LOCAL_PENDING", "LOCAL_PENDING"]);

      resetBackoff();
      fetchMock.mockImplementation(async () => jsonResponse({ id: "o1" }, 200));
      const resumed = await flushQueue();
      expect(resumed.synced.map((op) => op.client_operation_id)).toEqual([second.client_operation_id, third.client_operation_id]);
      const keys = (fetchMock.mock.calls as [string, RequestInit][]).map(
        ([, init]) => (init.headers as Record<string, string>)["Idempotency-Key"],
      );
      expect(keys).toEqual([first.client_operation_id, second.client_operation_id, second.client_operation_id, third.client_operation_id]);
    });

    it("un rechazo del servidor (plato cancelado) no bloquea las demás tareas", async () => {
      const fetchMock = vi.fn()
        .mockImplementationOnce(async () => jsonResponse(
          { error: { code: "ITEM_CANCELLED", message: "El producto fue cancelado.", details: {} } }, 409))
        .mockImplementationOnce(async () => jsonResponse({ id: "o2" }, 200));
      vi.stubGlobal("fetch", fetchMock);
      await enqueue(taskOp("papas", "PREPARING"));
      await enqueue({ ...taskOp("sopa", "PREPARING"), path: "/api/v1/orders/o2/items/i2/tasks/sopa/status" });
      const result = await flushQueue();
      expect(result.failed).toHaveLength(1);
      expect(result.synced).toHaveLength(1);
      expect((await listOperations()).map((op) => op.status)).toEqual(["SYNC_ERROR", "SYNCED"]);
    });
  });

  describe("primera comanda de una mesa (pedido + comanda atómicos)", () => {
    const open = () => ({
      operation_type: "OPEN_TABLE_WITH_COMMAND" as const,
      path: "/api/v1/orders/open-with-command",
      method: "POST" as const,
      body: { table_id: "t2", persons_count: 2, items: [{ menu_item_id: "m1", quantity: 1 }] },
    });
    const followUp = (parent: string) => ({
      operation_type: "CREATE_COMMAND" as const,
      path: "/api/v1/orders/{orderRef}/commands",
      method: "POST" as const,
      body: { items: [{ menu_item_id: "m2", quantity: 1 }] },
      parent_operation_id: parent,
    });

    it("una sola solicitud crea pedido y comanda; la siguiente comanda usa el id del PEDIDO devuelto", async () => {
      const fetchMock = vi.fn()
        .mockImplementationOnce(async () => jsonResponse({ id: "order-77", command: { id: "cmd-1" } }))
        .mockImplementationOnce(async () => jsonResponse({ id: "cmd-2" }));
      vi.stubGlobal("fetch", fetchMock);
      const first = await enqueue(open());
      await enqueue(followUp(first.client_operation_id));
      const result = await flushQueue();
      expect(result.synced).toHaveLength(2);
      const urls = (fetchMock.mock.calls as [string, RequestInit][]).map(([url]) => url);
      expect(urls).toEqual(["/api/v1/orders/open-with-command", "/api/v1/orders/order-77/commands"]);
    });

    it("un corte de red reintenta con la misma clave; no existe un estado intermedio con pedido vacío", async () => {
      const fetchMock = vi.fn()
        .mockRejectedValueOnce(new TypeError("Failed to fetch"))
        .mockImplementation(async () => jsonResponse({ id: "order-1" }));
      vi.stubGlobal("fetch", fetchMock);
      const op = await enqueue(open());
      const interrupted = await flushQueue();
      expect(interrupted.networkFailure).toBe(true);
      expect((await listOperations())[0]).toMatchObject({ status: "LOCAL_PENDING", client_operation_id: op.client_operation_id });
      resetBackoff();
      const resumed = await flushQueue();
      expect(resumed.synced).toHaveLength(1);
      const keys = (fetchMock.mock.calls as [string, RequestInit][]).map(([, init]) => (init.headers as Record<string, string>)["Idempotency-Key"]);
      expect(keys).toEqual([op.client_operation_id, op.client_operation_id]);
    });

    it("si otro dispositivo ganó la mesa (409), queda SYNC_ERROR y la comanda encadenada no se envía", async () => {
      const fetchMock = vi.fn().mockImplementation(async () => jsonResponse(
        { error: { code: "TABLE_ALREADY_OPEN", message: "La mesa ya tiene un pedido abierto.", details: {} } }, 409));
      vi.stubGlobal("fetch", fetchMock);
      const first = await enqueue(open());
      const child = await enqueue(followUp(first.client_operation_id));
      const result = await flushQueue();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(result.failed.map((op) => op.client_operation_id).sort()).toEqual([first.client_operation_id, child.client_operation_id].sort());
      const stored = await listOperations();
      expect(stored.every((op) => op.status === "SYNC_ERROR")).toBe(true);
      expect(stored.find((op) => op.client_operation_id === first.client_operation_id)?.last_error).toContain("TABLE_ALREADY_OPEN");
    });
  });
});

describe("sesión expirada durante la sincronización", () => {
  it("conserva la operación pendiente con su mismo UUID en lugar de marcarla como error", async () => {
    useSession.setState({ user: { id: "w1", username: "ana", display_name: "Ana", role: "WAITER", is_active: true, created_at: "" } });
    localStorage.setItem("restaurante.access", "a");
    localStorage.setItem("restaurante.refresh", "r");
    const op = await enqueue({ operation_type: "REGISTER_EXPENSE", path: "/api/v1/expenses", method: "POST", body: {} });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ error: { code: "INVALID_TOKEN", message: "x" } }, 401)));
    const result = await flushQueue();
    expect(result.failed).toHaveLength(0);
    const [stored] = await listOperations();
    expect(stored.client_operation_id).toBe(op.client_operation_id);
    expect(stored.status).toBe("LOCAL_PENDING");
    expect(useSession.getState().user).toBeNull();
  });

  it("sin red para renovar el token la operación sigue pendiente", async () => {
    useSession.setState({ user: { id: "w1", username: "ana", display_name: "Ana", role: "WAITER", is_active: true, created_at: "" } });
    localStorage.setItem("restaurante.access", "a");
    localStorage.setItem("restaurante.refresh", "r");
    await enqueue({ operation_type: "REGISTER_EXPENSE", path: "/api/v1/expenses", method: "POST", body: {} });
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockRejectedValueOnce(new TypeError("Failed to fetch")));
    const result = await flushQueue();
    expect(result.networkFailure).toBe(true);
    const [stored] = await listOperations();
    expect(stored.status).toBe("LOCAL_PENDING");
    expect(localStorage.getItem("restaurante.refresh")).toBe("r");
  });
});
