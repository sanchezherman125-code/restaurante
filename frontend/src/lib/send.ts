import { NetworkError } from "../api/client";
import { enqueue, type NewOperation } from "../offline/queue";
import { deleteOperation, putOperation } from "../offline/queue-db";
import { useUi } from "../stores/ui";

export interface SendOutcome {
  queued: boolean;
  operationId: string | null;
}

/**
 * Ejecuta la operación contra la API. Si falla por falta de conexión,
 * la encola en IndexedDB para sincronizarla después (con idempotencia).
 */
export async function sendOrQueue(op: NewOperation, exec: (clientOperationId: string) => Promise<unknown>): Promise<SendOutcome> {
  // Persist as SENDING before the request. A queue flush must never be able to
  // claim this operation while its direct request is in flight.
  const queued = await enqueue(op, "SENDING");
  try {
    await exec(queued.client_operation_id);
    await deleteOperation(queued.client_operation_id);
    return { queued: false, operationId: null };
  } catch (error) {
    if (error instanceof NetworkError) {
      await putOperation({
        ...queued,
        status: "LOCAL_PENDING",
        attempt_count: queued.attempt_count + 1,
        last_attempt_at: Date.now(),
      });
      useUi
        .getState()
        .toast("warning", "Sin conexión", "La operación quedó guardada y se enviará al reconectar.");
      return { queued: true, operationId: queued.client_operation_id };
    }
    await deleteOperation(queued.client_operation_id);
    throw error;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "Ocurrió un error inesperado.";
}
