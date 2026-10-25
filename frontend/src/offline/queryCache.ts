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

export function saveQueryCache(client: QueryClient, userId: string): void {
  const state = dehydrate(client, {
    shouldDehydrateQuery: (query) => query.state.status === "success" && isPersistedQuery(query.queryKey),
  });
  try {
    localStorage.setItem(keyFor(userId), JSON.stringify({ saved_at: Date.now(), state } satisfies Snapshot));
  } catch { /* almacenamiento lleno o bloqueado: la caché es opcional */ }
}

export function restoreQueryCache(client: QueryClient, userId: string): void {
  try {
    const raw = localStorage.getItem(keyFor(userId));
    if (!raw) return;
    const snapshot = JSON.parse(raw) as Snapshot;
    if (!snapshot?.state || Date.now() - snapshot.saved_at > MAX_AGE_MS) {
      localStorage.removeItem(keyFor(userId));
      return;
    }
    hydrate(client, snapshot.state);
  } catch {
    localStorage.removeItem(keyFor(userId));
  }
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
