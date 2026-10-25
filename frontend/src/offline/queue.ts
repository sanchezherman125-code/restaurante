import { ApiError, NetworkError, apiRequest } from "../api/client";
import type { QueuedOperation } from "../types/api";
import { deleteOperation, getOperation, listOperations, putOperation } from "./queue-db";
import { useSession } from "../stores/session";

export type OperationType = QueuedOperation["operation_type"];

export interface NewOperation {
  operation_type: OperationType;
  path: string;
  method: QueuedOperation["method"];
  body: unknown;
  parent_operation_id?: string | null;
}

const BACKOFF_KEY = "restaurante.queueBackoff";
function savedBackoff(): { backoffMs: number; nextAllowedAttempt: number } {
  try {
    const saved = JSON.parse(localStorage.getItem(BACKOFF_KEY) ?? "null");
    if (saved && Number.isFinite(saved.backoffMs) && Number.isFinite(saved.nextAllowedAttempt)) {
      return { backoffMs: Math.min(60000, Math.max(0, saved.backoffMs)),
        nextAllowedAttempt: Math.min(Date.now() + 60000, saved.nextAllowedAttempt) };
    }
  } catch { /* ignore invalid local state */ }
  return { backoffMs: 0, nextAllowedAttempt: 0 };
}
let { backoffMs, nextAllowedAttempt } = savedBackoff();
let activeFlush: Promise<FlushResult> | null = null;

export function getBackoffMs(): number {
  return backoffMs;
}

export function resetBackoff(): void {
  backoffMs = 0;
  nextAllowedAttempt = 0;
  localStorage.removeItem(BACKOFF_KEY);
}

let lastCreatedAt = 0;
/** Marca de tiempo estrictamente creciente: dos operaciones nunca empatan y se reenvían en el orden en que ocurrieron. */
function nextCreatedAt(): number {
  lastCreatedAt = Math.max(Date.now(), lastCreatedAt + 1);
  return lastCreatedAt;
}

export function createOperation(newOp: NewOperation, status: QueuedOperation["status"] = "LOCAL_PENDING"): QueuedOperation {
  return {
    client_operation_id: crypto.randomUUID(),
    owner_user_id: useSession.getState().user?.id ?? null,
    operation_type: newOp.operation_type,
    path: newOp.path,
    method: newOp.method,
    body: newOp.body,
    parent_operation_id: newOp.parent_operation_id ?? null,
    created_at: nextCreatedAt(),
    attempt_count: 0,
    last_attempt_at: null,
    status,
    last_error: null,
  };
}

export async function enqueue(
  newOp: NewOperation,
  status: QueuedOperation["status"] = "LOCAL_PENDING",
): Promise<QueuedOperation> {
  const op = createOperation(newOp, status);
  await putOperation(op);
  return op;
}

function resolvePath(op: QueuedOperation, parent: QueuedOperation | undefined): string {
  if (!op.path.includes("{orderRef}")) return op.path;
  const ref = parent?.server_resource_id ?? null;
  if (!ref) throw new Error("El pedido padre aún no está sincronizado.");
  return op.path.replace("{orderRef}", ref);
}

function withClientId(op: QueuedOperation): Record<string, unknown> {
  const body = (op.body ?? {}) as Record<string, unknown>;
  return { ...body, client_operation_id: op.client_operation_id };
}

export interface FlushResult {
  synced: QueuedOperation[];
  failed: QueuedOperation[];
  deferred: QueuedOperation[];
  networkFailure: boolean;
}

function orderByDependencies(ops: QueuedOperation[]): QueuedOperation[] {
  const byId = new Map(ops.map((op) => [op.client_operation_id, op]));
  const depth = (op: QueuedOperation, seen: Set<string>): number => {
    if (!op.parent_operation_id) return 0;
    if (seen.has(op.client_operation_id)) return 0;
    seen.add(op.client_operation_id);
    const parent = byId.get(op.parent_operation_id);
    if (!parent) return 0;
    return depth(parent, seen) + 1;
  };
  return ops
    .map((op, index) => ({ op, index, depth: depth(op, new Set()) }))
    .sort((a, b) => a.depth - b.depth || a.index - b.index)
    .map((entry) => entry.op);
}

async function flushQueueImpl(): Promise<FlushResult> {
  const result: FlushResult = { synced: [], failed: [], deferred: [], networkFailure: false };

  if (Date.now() < nextAllowedAttempt) {
      result.deferred = await listOperations();
      return result;
    }

    let ops = orderByDependencies(await listOperations());
    const byId = new Map(ops.map((op) => [op.client_operation_id, op]));

    for (const op of ops) {
      if (op.status !== "LOCAL_PENDING") continue;
      if (!op.owner_user_id && useSession.getState().user) {
        const legacy = { ...op, status: "SYNC_ERROR" as const,
          last_error: "Operación antigua sin usuario identificado. Verifique el pedido antes de descartarla." };
        await putOperation(legacy);
        result.failed.push(legacy);
        continue;
      }
      if (op.owner_user_id && op.owner_user_id !== useSession.getState().user?.id) {
        result.deferred.push(op);
        continue;
      }

      if (op.parent_operation_id) {
        const parent = byId.get(op.parent_operation_id);
        if (!parent || parent.status === "LOCAL_PENDING" || parent.status === "SENDING") {
          result.deferred.push(op);
          continue;
        }
        if (parent.status === "SYNC_ERROR") {
          const failedChild: QueuedOperation = {
            ...op,
            status: "SYNC_ERROR",
            last_error: "No se envió porque el pedido que lo originó falló.",
          };
          await putOperation(failedChild);
          byId.set(op.client_operation_id, failedChild);
          result.failed.push(failedChild);
          continue;
        }
      }

      const parent = op.parent_operation_id ? byId.get(op.parent_operation_id) : undefined;

      let path: string;
      try {
        path = resolvePath(op, parent);
      } catch (error) {
        const deferred: QueuedOperation = { ...op, last_error: (error as Error).message };
        await putOperation(deferred);
        byId.set(op.client_operation_id, deferred);
        result.deferred.push(deferred);
        continue;
      }

      const sending: QueuedOperation = {
        ...op,
        status: "SENDING",
        attempt_count: op.attempt_count + 1,
        last_attempt_at: Date.now(),
        path,
      };
      await putOperation(sending);
      byId.set(op.client_operation_id, sending);

      try {
        const response = await apiRequest<Record<string, unknown>>(path, {
          method: sending.method,
          body: withClientId(sending),
          idempotencyKey: sending.client_operation_id,
        });
        const synced: QueuedOperation = {
          ...sending,
          status: "SYNCED",
          last_error: null,
          server_resource_id:
            typeof response?.["id"] === "string" ? (response["id"] as string) : sending.server_resource_id,
        };
        await putOperation(synced);
        byId.set(op.client_operation_id, synced);
        result.synced.push(synced);
        resetBackoff();
      } catch (error) {
        if (error instanceof NetworkError || (error instanceof ApiError && error.status >= 500)) {
          const deferred: QueuedOperation = { ...sending, status: "LOCAL_PENDING" };
          await putOperation(deferred);
          byId.set(op.client_operation_id, deferred);
          result.networkFailure = true;
          backoffMs = backoffMs === 0 ? 1000 : Math.min(backoffMs * 2, 60000);
          nextAllowedAttempt = Date.now() + backoffMs;
          localStorage.setItem(BACKOFF_KEY, JSON.stringify({ backoffMs, nextAllowedAttempt }));
          break;
        }
        if (error instanceof ApiError && error.code === "SESSION_EXPIRED") {
          // Requiere volver a ingresar: la operación se conserva intacta (mismo UUID) para ese momento.
          const waiting: QueuedOperation = { ...sending, status: "LOCAL_PENDING", last_error: "Esperando nuevo ingreso del usuario." };
          await putOperation(waiting);
          byId.set(op.client_operation_id, waiting);
          break;
        }
        if (error instanceof ApiError) {
          const failed: QueuedOperation = {
            ...sending,
            status: "SYNC_ERROR",
            last_error: `${error.code}: ${error.message}`,
          };
          await putOperation(failed);
          byId.set(op.client_operation_id, failed);
          result.failed.push(failed);
          continue;
        }
        const failed: QueuedOperation = {
          ...sending,
          status: "SYNC_ERROR",
          last_error: (error as Error).message,
        };
        await putOperation(failed);
        byId.set(op.client_operation_id, failed);
        result.failed.push(failed);
      }
    }

    ops = await listOperations();
    result.deferred = ops.filter((op) => op.status === "LOCAL_PENDING");
  return result;
}

/** A single in-process flush owns LOCAL_PENDING operations. Operations already
 * being sent directly stay SENDING and are intentionally skipped. */
export function flushQueue(): Promise<FlushResult> {
  if (activeFlush) return activeFlush;
  activeFlush = flushQueueImpl().finally(() => {
    activeFlush = null;
  });
  return activeFlush;
}

export async function retryOperation(id: string): Promise<void> {
  const op = await getOperation(id);
  if (!op) return;
  resetBackoff();
  await putOperation({ ...op, status: "LOCAL_PENDING", last_error: null });
}

export async function discardOperation(id: string): Promise<void> {
  await deleteOperation(id);
}
