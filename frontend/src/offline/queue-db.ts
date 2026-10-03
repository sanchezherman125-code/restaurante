import { openDB, type DBSchema, type IDBPDatabase } from "idb";
import type { QueuedOperation } from "../types/api";

interface QueueDB extends DBSchema {
  queue: {
    key: string;
    value: QueuedOperation;
    indexes: { by_status: string; by_created: number };
  };
}

const DB_NAME = "restaurante-offline";
const STORE = "queue";

let dbPromise: Promise<IDBPDatabase<QueueDB>> | null = null;

export function getQueueDB(): Promise<IDBPDatabase<QueueDB>> {
  if (!dbPromise) {
    dbPromise = openDB<QueueDB>(DB_NAME, 1, {
      upgrade(db) {
        const store = db.createObjectStore(STORE, { keyPath: "client_operation_id" });
        store.createIndex("by_status", "status");
        store.createIndex("by_created", "created_at");
      },
    });
  }
  return dbPromise;
}

type Listener = () => void;
const listeners = new Set<Listener>();

export function onQueueChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(): void {
  for (const listener of listeners) listener();
}

export async function listOperations(): Promise<QueuedOperation[]> {
  const db = await getQueueDB();
  const all = await db.getAll(STORE);
  return all.sort((a, b) => a.created_at - b.created_at);
}

export async function getOperation(id: string): Promise<QueuedOperation | undefined> {
  const db = await getQueueDB();
  return db.get(STORE, id);
}

export async function putOperation(op: QueuedOperation): Promise<void> {
  const db = await getQueueDB();
  await db.put(STORE, op);
  notify();
}

export async function deleteOperation(id: string): Promise<void> {
  const db = await getQueueDB();
  await db.delete(STORE, id);
  notify();
}

export async function clearSynced(): Promise<void> {
  const db = await getQueueDB();
  const tx = db.transaction(STORE, "readwrite");
  const synced = await tx.store.index("by_status").getAll("SYNCED");
  for (const op of synced) tx.store.delete(op.client_operation_id);
  await tx.done;
  notify();
}

/** A browser can terminate while a request is in flight. The UUID is retained,
 * so returning it to the queue is safe: the server will replay its stored result. */
export async function recoverInterruptedOperations(): Promise<void> {
  const db = await getQueueDB();
  const tx = db.transaction(STORE, "readwrite");
  const sending = await tx.store.index("by_status").getAll("SENDING");
  for (const op of sending) {
    await tx.store.put({
      ...op,
      status: "LOCAL_PENDING",
      last_error: "Reintento después de cierre o recarga durante el envío.",
    });
  }
  await tx.done;
  if (sending.length) notify();
}
