import { ApiError, NetworkError, apiRequest } from "../api/client";
import type { QueuedOperation } from "../types/api";
import { deleteOperation, getOperation, listOperations, putOperation } from "./queue-db";

export type OperationType = QueuedOperation["operation_type"];

export interface NewOperation {
  operation_type: OperationType;
  path: string;
  method: QueuedOperation["method"];
  body: unknown;
  parent_operation_id?: string | null;
}

let backoffMs = 0;
let nextAllowedAttempt = 0;
let flushing = false;
const pendingFlush: (() => void)[] = [];

export function getBackoffMs(): number {
  return backoffMs;
}

export function resetBackoff(): void {
  backoffMs = 0;
  nextAllowedAttempt = 0;
}

export function createOperation(newOp: NewOperation): QueuedOperation {
  return {
    client_operation_id: crypto.randomUUID(),
    operation_type: newOp.operation_type,
    path: newOp.path,
    method: newOp.method,
    body: newOp.body,
    parent_operation_id: newOp.parent_operation_id ?? null,
    created_at: Date.now(),
    attempt_count: 0,
    last_attempt_at: null,
    status: "LOCAL_PENDING",
    last_error: null,
  };
}

export async function enqueue(newOp: NewOperation): Promise<QueuedOperation> {
  const op = createOperation(newOp);
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

export async function flushQueue(): Promise<FlushResult> {
  if (flushing) {
    await new Promise<void>((resolve) => pendingFlush.push(resolve));
  }
  flushing = true;
  const result: FlushResult = { synced: [], failed: [], deferred: [], networkFailure: false };

  try {
    if (Date.now() < nextAllowedAttempt) {
      result.deferred = await listOperations();
      return result;
    }

    let ops = orderByDependencies(await listOperations());
    const byId = new Map(ops.map((op) => [op.client_operation_id, op]));

    for (const op of ops) {
      if (op.status !== "LOCAL_PENDING") continue;

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
        if (error instanceof NetworkError) {
          const deferred: QueuedOperation = { ...sending, status: "LOCAL_PENDING" };
          await putOperation(deferred);
          byId.set(op.client_operation_id, deferred);
          result.networkFailure = true;
          backoffMs = backoffMs === 0 ? 1000 : Math.min(backoffMs * 2, 60000);
          nextAllowedAttempt = Date.now() + backoffMs;
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
  } finally {
    flushing = false;
    const waiting = pendingFlush.splice(0, pendingFlush.length);
    for (const resolve of waiting) resolve();
  }
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
