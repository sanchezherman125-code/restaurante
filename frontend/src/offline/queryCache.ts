import { dehydrate, hydrate, type QueryClient, type QueryKey } from "@tanstack/react-query";

/**
 * Copia local de las consultas operativas (mesas, carta, pedidos activos, turno, tableros) por usuario,
 * para que la PWA muestre el salón al recargarse sin conexión. Nunca guarda credenciales y se borra al
 * cerrar sesión o cambiar de usuario: un usuario del dispositivo no ve los datos de otro.
 */
const PREFIX = "restaurante.queryCache.";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const PERSISTED_ROOTS = new Set(["tables", "menu", "orders", "shifts", "preparation", "expenses"]);

interface Snapshot {
  saved_at: number;
  state: ReturnType<typeof dehydrate>;
}

export function isPersistedQuery(queryKey: QueryKey): boolean {
  return typeof queryKey[0] === "string" && PERSISTED_ROOTS.has(queryKey[0]);
}

function keyFor(userId: string): string {
  return `${PREFIX}${userId}`;
}

type DehydratedQuery = Snapshot["state"]["queries"][number];

function readSnapshot(userId: string): Snapshot | null {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    const snapshot = raw ? (JSON.parse(raw) as Snapshot) : null;
    return snapshot?.state?.queries ? snapshot : null;
  } catch {
    return null;
  }
}

/** Una respuesta válida sigue siéndolo aunque la última actualización haya fallado: se guarda como éxito. */
function asLastGoodResponse(query: DehydratedQuery): DehydratedQuery {
  return {
    ...query,
    state: { ...query.state, status: "success", error: null, fetchStatus: "idle", fetchFailureCount: 0, fetchFailureReason: null },
  };
}

export function saveQueryCache(client: QueryClient, userId: string): void {
  // Cualquier consulta con datos, aunque su último intento haya fallado (status "error").
  const current = dehydrate(client, {
    shouldDehydrateQuery: (query) => query.state.data !== undefined && isPersistedQuery(query.queryKey),
  }).queries.map(asLastGoodResponse);
  // Lo ya guardado se conserva salvo que haya una respuesta más reciente: ni un error ni que React Query
  // descarte de memoria una consulta sin uso borran la última copia válida.
  const merged = new Map<string, DehydratedQuery>();
  for (const query of readSnapshot(userId)?.state.queries ?? []) merged.set(query.queryHash, query);
  for (const query of current) {
    const saved = merged.get(query.queryHash);
    if (!saved || query.state.dataUpdatedAt >= saved.state.dataUpdatedAt) merged.set(query.queryHash, query);
  }
  const state = { mutations: [], queries: [...merged.values()] };
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify({ saved_at: Date.now(), state } satisfies Snapshot));
  } catch { /* almacenamiento lleno o bloqueado: la caché es opcional */ }
}

export function restoreQueryCache(client: QueryClient, userId: string): void {
  const snapshot = readSnapshot(userId);
  if (!snapshot) {
    localStorage.removeItem(keyFor(userId));
    return;
  }
  // La vigencia es por respuesta: lo que no se pudo actualizar en un día deja de mostrarse.
  const fresh = snapshot.state.queries.filter((query) => Date.now() - query.state.dataUpdatedAt <= MAX_AGE_MS);
  if (fresh.length === 0) {
    localStorage.removeItem(keyFor(userId));
    return;
  }
  // Los datos llegan como ya vencidos (dataUpdatedAt original): al haber conexión se vuelven a pedir.
  hydrate(client, { ...snapshot.state, queries: fresh });
}

/** Elimina la caché de todos los usuarios salvo ``keepUserId`` (o de todos si es null). */
export function purgeQueryCaches(keepUserId: string | null): void {
  try {
    const keys = Array.from({ length: localStorage.length }, (_, index) => localStorage.key(index));
    for (const key of keys) {
      if (key?.startsWith(PREFIX) && key !== (keepUserId ? keyFor(keepUserId) : null)) localStorage.removeItem(key);
    }
  } catch { /* almacenamiento no disponible */ }
}

/** Guarda la caché (con pausa) mientras ``currentUserId`` devuelva un usuario. Devuelve la función de baja. */
export function persistQueryCache(client: QueryClient, currentUserId: () => string | null, delayMs = 500): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = client.getQueryCache().subscribe((event) => {
    if (!isPersistedQuery(event.query.queryKey) || timer) return;
    timer = setTimeout(() => {
      timer = null;
      const userId = currentUserId();
      if (userId) saveQueryCache(client, userId);
    }, delayMs);
  });
  return () => {
    if (timer) clearTimeout(timer);
    unsubscribe();
  };
}
