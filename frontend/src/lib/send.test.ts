import { beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkError } from "../api/client";
import { flushQueue, resetBackoff } from "../offline/queue";
import { deleteOperation, listOperations } from "../offline/queue-db";
import { sendOrQueue } from "./send";

beforeEach(async () => {
  resetBackoff();
  vi.restoreAllMocks();
  for (const op of await listOperations()) await deleteOperation(op.client_operation_id);
});

describe("sendOrQueue", () => {
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
