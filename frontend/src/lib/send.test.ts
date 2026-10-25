import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, NetworkError, setTokens } from "../api/client";
import { flushQueue, resetBackoff } from "../offline/queue";
import { deleteOperation, listOperations } from "../offline/queue-db";
import { useSession } from "../stores/session";
import { fakeJwt } from "../test/jwt";
import { expensesApi } from "../api/endpoints";
import { sendOrQueue } from "./send";

beforeEach(async () => {
  // La cola solo sincroniza en nombre del usuario en sesión, con un token que le pertenezca.
  useSession.setState({ user: { id: "w1", username: "ana", display_name: "Ana", role: "WAITER", is_active: true, created_at: "" } });
  setTokens(fakeJwt("w1"), "refresh");
  resetBackoff();
  vi.restoreAllMocks();
  for (const op of await listOperations()) await deleteOperation(op.client_operation_id);
});

describe("sendOrQueue", () => {
  it("conserva una operación cuando un error 5xx deja el resultado incierto", async () => {
    const outcome = await sendOrQueue({ operation_type: "REGISTER_EXPENSE", path: "/api/v1/expenses",
      method: "POST", body: { amount: "5.00", description: "Hielo" } }, async () => {
      throw new ApiError(502, "HTTP_ERROR", "Gateway error");
    });
    expect(outcome.queued).toBe(true);
    expect((await listOperations())[0].client_operation_id).toBe(outcome.operationId);
  });
  it("reintenta una respuesta perdida con el UUID del primer intento", async () => {
    let processed = 0;
    let firstOperationId = "";
    const outcome = await sendOrQueue(
      {
        operation_type: "CREATE_COMMAND",
        path: "/api/v1/orders/order-1/commands",
        method: "POST",
        body: { items: [{ menu_item_id: "menu-1", quantity: 1 }] },
      },
      async (operationId) => {
        firstOperationId = operationId;
        processed += 1; // el servidor ya confirmó la comanda
        throw new NetworkError(); // la respuesta no llegó al navegador
      },
    );

    expect(outcome).toMatchObject({ queued: true, operationId: firstOperationId });
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: "command-1" }), { status: 201 }));
    vi.stubGlobal("fetch", fetchMock);
    await flushQueue();

    expect(processed).toBe(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe(firstOperationId);
    expect(JSON.parse(String(init.body)).client_operation_id).toBe(firstOperationId);
  });

  it("no deja que flushQueue reenvíe una operación directa que sigue en vuelo", async () => {
    let releaseRequest: () => void = () => undefined;
    let requestStarted: () => void = () => undefined;
    const requestInFlight = new Promise<void>((resolve) => {
      requestStarted = resolve;
    });
    const directRequest = vi.fn(async () => {
      requestStarted();
      await new Promise<void>((resolve) => {
        releaseRequest = resolve;
      });
    });
    const queuedRequest = vi.fn();
    vi.stubGlobal("fetch", queuedRequest);

    const direct = sendOrQueue(
      {
        operation_type: "UPDATE_ORDER_ITEM_STATUS",
        path: "/api/v1/orders/order-1/items/item-1/status",
        method: "POST",
        body: { status: "READY" },
      },
      directRequest,
    );

    await requestInFlight;
    expect((await listOperations())[0]?.status).toBe("SENDING");

    await flushQueue();
    expect(directRequest).toHaveBeenCalledTimes(1);
    expect(queuedRequest).not.toHaveBeenCalled();

    releaseRequest();
    await direct;
    expect(await listOperations()).toHaveLength(0);
  });

  it("devuelve a LOCAL_PENDING una petición directa que falla por red", async () => {
    const outcome = await sendOrQueue(
      {
        operation_type: "UPDATE_ORDER_ITEM_STATUS",
        path: "/api/v1/orders/order-1/items/item-1/status",
        method: "POST",
        body: { status: "READY" },
      },
      async () => {
        throw new NetworkError();
      },
    );

    expect(outcome.queued).toBe(true);
    expect((await listOperations())[0]).toMatchObject({ status: "LOCAL_PENDING", attempt_count: 1 });
  });
});

describe("envío inmediato ligado a quien lo inicia (sin pasar por la cola)", () => {
  const json = (body: unknown, status = 201) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const switchToAdmin = () => {
    useSession.setState({ user: { id: "admin", username: "admin", display_name: "Dueño", role: "ADMIN", is_active: true, created_at: "" } });
    setTokens(fakeJwt("admin"), "refresh-admin");
  };
  const registerExpense = () => sendOrQueue(
    { operation_type: "REGISTER_EXPENSE", path: "/api/v1/expenses", method: "POST", body: { amount: "0.01", description: "x", shift_id: "s1" } },
    (operationId) => expensesApi.create({ amount: "0.01", description: "x", shift_id: "s1" }, operationId),
  );

  it("cambio de A a B antes del 401: sin renovación ni reintento, operación pendiente de A y sesión de B intacta", async () => {
    const fetchMock = vi.fn().mockImplementationOnce(async () => {
      switchToAdmin();
      return json({ error: { code: "INVALID_TOKEN", message: "Sesión revocada" } }, 401);
    });
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await registerExpense();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(outcome.queued).toBe(true);
    const [stored] = await listOperations();
    expect(stored).toMatchObject({ client_operation_id: outcome.operationId, owner_user_id: "w1", status: "LOCAL_PENDING" });
    const sentKey = ((fetchMock.mock.calls[0][1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"];
    expect(sentKey).toBe(outcome.operationId);
    expect(localStorage.getItem("restaurante.refresh")).toBe("refresh-admin");
    expect(useSession.getState().user?.id).toBe("admin");
  });

  it("cambio de A a B durante la renovación: no se reemplazan los tokens de B ni se reintenta", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({}, 401))
      .mockImplementationOnce(async () => {
        switchToAdmin();
        return json({ access_token: fakeJwt("w1"), refresh_token: "refresh-w1-nuevo" }, 200);
      });
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await registerExpense();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(outcome.queued).toBe(true);
    expect(localStorage.getItem("restaurante.refresh")).toBe("refresh-admin");
    expect((await listOperations())[0]).toMatchObject({ client_operation_id: outcome.operationId, owner_user_id: "w1", status: "LOCAL_PENDING" });
  });

  it("si A conserva la sesión, renueva y reintenta con el mismo UUID y la operación local se cierra", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({}, 401))
      .mockResolvedValueOnce(json({ access_token: fakeJwt("w1"), refresh_token: "refresh-w1-nuevo" }, 200))
      .mockResolvedValueOnce(json({ id: "expense-1" }));
    vi.stubGlobal("fetch", fetchMock);
    const outcome = await registerExpense();

    expect(outcome.queued).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const keys = [0, 2].map((call) => ((fetchMock.mock.calls[call][1] as RequestInit).headers as Record<string, string>)["Idempotency-Key"]);
    expect(keys[0]).toBe(keys[1]);
    expect(localStorage.getItem("restaurante.refresh")).toBe("refresh-w1-nuevo");
    expect(await listOperations()).toEqual([]);
  });

  it("cambio de A a B durante la escritura inicial en IndexedDB: cero peticiones y operación pendiente de A", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const sending = registerExpense();   // la operación de A se crea y empieza a guardarse
    switchToAdmin();                       // B ingresa antes de que termine la escritura
    const outcome = await sending;

    expect(fetchMock).not.toHaveBeenCalled();
    expect(outcome.queued).toBe(true);
    expect(await listOperations()).toEqual([
      expect.objectContaining({ client_operation_id: outcome.operationId, owner_user_id: "w1", status: "LOCAL_PENDING" }),
    ]);
    expect(localStorage.getItem("restaurante.refresh")).toBe("refresh-admin");
    expect(useSession.getState().user?.id).toBe("admin");
  });

  it("solo cambian las credenciales guardadas (la sesión en memoria sigue siendo A): tampoco se envía", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const sending = registerExpense();
    setTokens(fakeJwt("admin"), "refresh-admin");
    const outcome = await sending;
    expect(fetchMock).not.toHaveBeenCalled();
    expect((await listOperations())[0]).toMatchObject({ client_operation_id: outcome.operationId, owner_user_id: "w1", status: "LOCAL_PENDING" });
  });
});

