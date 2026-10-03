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
});
