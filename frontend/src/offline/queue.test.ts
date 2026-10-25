import { beforeEach, describe, expect, it, vi } from "vitest";
import { enqueue, flushQueue, getBackoffMs, resetBackoff, retryOperation } from "./queue";
import { deleteOperation, listOperations, onQueueChange, putOperation, recoverInterruptedOperations } from "./queue-db";
import { setTokens } from "../api/client";
import { useSession } from "../stores/session";
import { fakeJwt } from "../test/jwt";

function jsonResponse(body: unknown, status = 201): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(async () => {
  // La cola solo envía en nombre del usuario en sesión, con un token que le pertenezca.
  useSession.setState({ user: { id: "w1", username: "ana", display_name: "Ana", role: "WAITER", is_active: true, created_at: "" } });
  resetBackoff();
  vi.restoreAllMocks();
  localStorage.clear();
  setTokens(fakeJwt("w1"), "refresh");
  for (const op of await listOperations()) {
    await deleteOperation(op.client_operation_id);
  }
});

describe("cola offline", () => {
  it("no sincroniza operaciones de otro usuario en un dispositivo compartido", async () => {
    const op = await enqueue({ operation_type: "REGISTER_EXPENSE", path: "/api/v1/expenses", method: "POST", body: { shift_id: "shift-A" } });
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
      body: { shift_id: "shift-A", amount: "10.00", description: "limón" },
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
      body: { shift_id: "shift-A", order_type: "DINE_IN" },
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
      body: { shift_id: "shift-A" },
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
      body: { shift_id: "shift-A", order_type: "DINE_IN" },
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
      body: { shift_id: "shift-A" },
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
      body: { table_id: "t2", persons_count: 2, shift_id: "shift-A", items: [{ menu_item_id: "m1", quantity: 1 }] },
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
    setTokens(fakeJwt("w1"), "r");
    const op = await enqueue({ operation_type: "REGISTER_EXPENSE", path: "/api/v1/expenses", method: "POST", body: { shift_id: "shift-A" } });
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
    setTokens(fakeJwt("w1"), "r");
    await enqueue({ operation_type: "REGISTER_EXPENSE", path: "/api/v1/expenses", method: "POST", body: { shift_id: "shift-A" } });
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

describe("la sincronización usa exclusivamente al propietario de cada operación", () => {
  it("si la sesión cambia a otro usuario durante el envío, las operaciones restantes no salen", async () => {
    const first = await enqueue({ operation_type: "REGISTER_EXPENSE", path: "/api/v1/expenses", method: "POST", body: { shift_id: "shift-A", n: 1 } });
    const second = await enqueue({ operation_type: "REGISTER_EXPENSE", path: "/api/v1/expenses", method: "POST", body: { shift_id: "shift-A", n: 2 } });
    const fetchMock = vi.fn().mockImplementation(async () => {
      // Mientras viaja la primera, la sesión pasa a Luis (con su propio token).
      useSession.setState({ user: { id: "luis", username: "luis", display_name: "Luis", role: "WAITER", is_active: true, created_at: "" } });
      setTokens(fakeJwt("luis"), "refresh-luis");
      return jsonResponse({ id: "expense-1" });
    });
    vi.stubGlobal("fetch", fetchMock);
    await flushQueue();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const stored = new Map((await listOperations()).map((op) => [op.client_operation_id, op]));
    expect(stored.get(first.client_operation_id)?.status).toBe("SYNCED");
    expect(stored.get(second.client_operation_id)).toMatchObject({ status: "LOCAL_PENDING", owner_user_id: "w1", attempt_count: 0 });
  });

  it("no envía si el token guardado pertenece a otro usuario", async () => {
    await enqueue({ operation_type: "REGISTER_EXPENSE", path: "/api/v1/expenses", method: "POST", body: { shift_id: "shift-A" } });
    setTokens(fakeJwt("otro"), "refresh");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await flushQueue();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await listOperations())[0].status).toBe("LOCAL_PENDING");
  });
});

describe("renovación y reintento tras 401 en nombre del dueño", () => {
  const luis = { id: "luis", username: "luis", display_name: "Luis", role: "ADMIN" as const, is_active: true, created_at: "" };
  const switchToLuis = () => {
    useSession.setState({ user: luis });
    setTokens(fakeJwt("luis"), "refresh-luis");
  };

  it("petición de A, cambio a B y 401 de A: no se renueva ni reintenta con B y nada queda a nombre de B", async () => {
    const op = await enqueue({ operation_type: "REGISTER_EXPENSE", path: "/api/v1/expenses", method: "POST", body: { shift_id: "shift-A", amount: "80.00" } });
    const fetchMock = vi.fn().mockImplementationOnce(async () => {
      switchToLuis(); // la sesión de A se revoca y B ingresa mientras viaja la petición
      return jsonResponse({ error: { code: "INVALID_TOKEN", message: "Sesión revocada" } }, 401);
    });
    vi.stubGlobal("fetch", fetchMock);
    await flushQueue();

    expect(fetchMock).toHaveBeenCalledTimes(1); // sin /auth/refresh con la sesión de B y sin reenvío
    const [stored] = await listOperations();
    expect(stored).toMatchObject({ client_operation_id: op.client_operation_id, owner_user_id: "w1", status: "LOCAL_PENDING", attempt_count: 0 });
    expect(localStorage.getItem("restaurante.refresh")).toBe("refresh-luis"); // la sesión de B sigue válida
    expect(useSession.getState().user?.id).toBe("luis");
  });

  it("si B ingresa durante la renovación de A, los tokens de B no se reemplazan y no hay reintento", async () => {
    const op = await enqueue({ operation_type: "REGISTER_EXPENSE", path: "/api/v1/expenses", method: "POST", body: { shift_id: "shift-A" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockImplementationOnce(async () => {
        switchToLuis();
        return jsonResponse({ access_token: fakeJwt("w1"), refresh_token: "refresh-w1-nuevo" }, 200);
      });
    vi.stubGlobal("fetch", fetchMock);
    await flushQueue();

    expect(fetchMock).toHaveBeenCalledTimes(2); // envío original + renovación; ningún reintento
    expect(localStorage.getItem("restaurante.refresh")).toBe("refresh-luis");
    const [stored] = await listOperations();
    expect(stored).toMatchObject({ client_operation_id: op.client_operation_id, owner_user_id: "w1", status: "LOCAL_PENDING" });
  });

  it("sin cambio de usuario, A renueva y reintenta con el mismo UUID", async () => {
    const op = await enqueue({ operation_type: "REGISTER_EXPENSE", path: "/api/v1/expenses", method: "POST", body: { shift_id: "shift-A" } });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({}, 401))
      .mockResolvedValueOnce(jsonResponse({ access_token: fakeJwt("w1"), refresh_token: "refresh-w1-nuevo" }, 200))
      .mockResolvedValueOnce(jsonResponse({ id: "expense-1" }));
    vi.stubGlobal("fetch", fetchMock);
    await flushQueue();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const retry = fetchMock.mock.calls[2][1] as RequestInit;
    expect((retry.headers as Record<string, string>)["Idempotency-Key"]).toBe(op.client_operation_id);
    expect((await listOperations())[0].status).toBe("SYNCED");
  });
});

describe("cola guardada por una versión anterior (sin turno de origen)", () => {
  // Formato exacto de 4321dd2: el cuerpo no trae shift_id.
  const legacyExpense = { operation_type: "REGISTER_EXPENSE" as const, path: "/api/v1/expenses", method: "POST" as const,
    body: { amount: "80.00", description: "Carbón", receipt_url: null } };
  const legacyOpen = { operation_type: "OPEN_TABLE_WITH_COMMAND" as const, path: "/api/v1/orders/open-with-command", method: "POST" as const,
    body: { table_id: "t2", persons_count: 2, items: [{ menu_item_id: "m1", quantity: 1 }], notes: null, order_notes: null } };

  it("gasto y primera comanda quedan conservados y señalados para conciliación, sin enviarse", async () => {
    const expense = await enqueue(legacyExpense);
    const open = await enqueue(legacyOpen);
    const chained = await enqueue({ operation_type: "CREATE_COMMAND", path: "/api/v1/orders/{orderRef}/commands", method: "POST",
      body: { items: [{ menu_item_id: "m2", quantity: 1 }] }, parent_operation_id: open.client_operation_id });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await flushQueue();
    expect(fetchMock).not.toHaveBeenCalled();
    const stored = new Map((await listOperations()).map((op) => [op.client_operation_id, op]));
    for (const op of [expense, open]) {
      expect(stored.get(op.client_operation_id)).toMatchObject({ status: "SYNC_ERROR", owner_user_id: "w1", body: op.body });
      expect(stored.get(op.client_operation_id)?.last_error).toMatch(/^LEGACY_WITHOUT_SHIFT/);
    }
    expect(stored.get(chained.client_operation_id)?.status).toBe("SYNC_ERROR");

    // Reintentar no la envía: no hay forma segura de saber su turno.
    await retryOperation(expense.client_operation_id);
    await flushQueue();
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await listOperations()).find((op) => op.client_operation_id === expense.client_operation_id)?.status).toBe("SYNC_ERROR");
  });

  it("una comanda heredada sobre un pedido existente sí se envía: el servidor valida el turno del pedido", async () => {
    await enqueue({ operation_type: "CREATE_COMMAND", path: "/api/v1/orders/o1/commands", method: "POST",
      body: { items: [{ menu_item_id: "m2", quantity: 1 }] } });
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ id: "cmd-1" }));
    vi.stubGlobal("fetch", fetchMock);
    await flushQueue();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
