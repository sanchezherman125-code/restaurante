import { NetworkError } from "../api/client";
import { enqueue, type NewOperation } from "../offline/queue";
import { deleteOperation } from "../offline/queue-db";
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
  // Persist the operation before its first network attempt. A lost response can
  // then only retry the same idempotency key, never create a second command.
  const queued = await enqueue(op);
  try {
    await exec(queued.client_operation_id);
    await deleteOperation(queued.client_operation_id);
    return { queued: false, operationId: null };
  } catch (error) {
    if (error instanceof NetworkError) {
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
