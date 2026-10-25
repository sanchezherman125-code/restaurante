import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { persistQueryCache, purgeQueryCaches, restoreQueryCache, saveQueryCache } from "./queryCache";

function clientWith(entries: [unknown[], unknown][]): QueryClient {
  const client = new QueryClient();
  for (const [key, data] of entries) client.setQueryData(key, data);
  return client;
}

describe("copia local de consultas por usuario", () => {
  beforeEach(() => localStorage.clear());

  it("recupera mesas, carta y pedidos del mismo usuario tras recargar", () => {
    saveQueryCache(clientWith([[["tables"], [{ id: "t1" }]], [["menu"], { items: [] }], [["orders", "active"], [{ id: "o1" }]]]), "w1");
    const reloaded = new QueryClient();
    restoreQueryCache(reloaded, "w1");
    expect(reloaded.getQueryData(["tables"])).toEqual([{ id: "t1" }]);
    expect(reloaded.getQueryData(["orders", "active"])).toEqual([{ id: "o1" }]);
  });

  it("no guarda datos fuera de la operación (reportes, usuarios)", () => {
    saveQueryCache(clientWith([[["reports", "sales"], { total: "1" }], [["users"], []], [["tables"], []]]), "admin");
    const reloaded = new QueryClient();
    restoreQueryCache(reloaded, "admin");
    expect(reloaded.getQueryData(["reports", "sales"])).toBeUndefined();
    expect(reloaded.getQueryData(["users"])).toBeUndefined();
    expect(reloaded.getQueryData(["tables"])).toEqual([]);
  });

  it("un usuario nunca recibe la copia de otro y al cambiar de usuario se borran las ajenas", () => {
    saveQueryCache(clientWith([[["orders", "active"], [{ id: "de-ana" }]]]), "ana");
    const other = new QueryClient();
    restoreQueryCache(other, "luis");
    expect(other.getQueryData(["orders", "active"])).toBeUndefined();

    purgeQueryCaches("luis");
    restoreQueryCache(other, "ana");
    expect(other.getQueryData(["orders", "active"])).toBeUndefined();
  });

  it("al cerrar sesión no queda ninguna copia", () => {
    saveQueryCache(clientWith([[["tables"], []]]), "ana");
    purgeQueryCaches(null);
    expect(Object.keys(localStorage).filter((key) => key.startsWith("restaurante.queryCache."))).toEqual([]);
  });

  it("descarta copias de más de un día", () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-10-20T12:00:00Z"));
      saveQueryCache(clientWith([[["tables"], [{ id: "viejo" }]]]), "ana");
      vi.setSystemTime(new Date("2026-10-22T12:00:00Z"));
      const reloaded = new QueryClient();
      restoreQueryCache(reloaded, "ana");
      expect(reloaded.getQueryData(["tables"])).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("guarda automáticamente solo mientras haya un usuario", async () => {
    vi.useFakeTimers();
    try {
      const client = new QueryClient();
      let user: string | null = "ana";
      const stop = persistQueryCache(client, () => user, 10);
      client.setQueryData(["tables"], [{ id: "t1" }]);
      await vi.advanceTimersByTimeAsync(20);
      expect(localStorage.getItem("restaurante.queryCache.ana")).toContain("t1");
      user = null;
      client.setQueryData(["tables"], [{ id: "t2" }]);
      await vi.advanceTimersByTimeAsync(20);
      expect(localStorage.getItem("restaurante.queryCache.ana")).not.toContain("t2");
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("un error de actualización no borra la última respuesta válida, ni tras varias recargas", async () => {
    let tables: unknown[] = [{ id: "t1" }];
    let failing = false;
    const fetchTables = () => (failing ? Promise.reject(new Error("API caída")) : Promise.resolve(tables));
    const first = new QueryClient();
    await first.fetchQuery({ queryKey: ["tables"], queryFn: fetchTables });
    saveQueryCache(first, "ana");

    for (let reload = 0; reload < 3; reload += 1) {
      // Recarga con la API caída pero navigator.onLine=true: el reintento falla y la consulta queda en error.
      failing = true;
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      restoreQueryCache(client, "ana");
      await client.fetchQuery({ queryKey: ["tables"], queryFn: fetchTables, staleTime: 0 }).catch(() => undefined);
      expect(client.getQueryState(["tables"])?.status).toBe("error");
      expect(client.getQueryData(["tables"])).toEqual([{ id: "t1" }]);
      saveQueryCache(client, "ana");
    }

    const offline = new QueryClient();
    restoreQueryCache(offline, "ana");
    expect(offline.getQueryData(["tables"])).toEqual([{ id: "t1" }]);
    expect(offline.getQueryState(["tables"])?.status).toBe("success");

    // Al reconectar se revalida: la respuesta nueva reemplaza a la guardada.
    failing = false;
    tables = [{ id: "t1" }, { id: "t2" }];
    await offline.fetchQuery({ queryKey: ["tables"], queryFn: fetchTables, staleTime: 0 });
    saveQueryCache(offline, "ana");
    const reconnected = new QueryClient();
    restoreQueryCache(reconnected, "ana");
    expect(reconnected.getQueryData(["tables"])).toEqual([{ id: "t1" }, { id: "t2" }]);
  });

  it("que React Query descarte de memoria una consulta sin uso no la borra de la copia", () => {
    const client = clientWith([[["tables"], [{ id: "t1" }]], [["menu"], { items: ["pollo"] }]]);
    saveQueryCache(client, "ana");
    client.removeQueries({ queryKey: ["menu"] });
    saveQueryCache(client, "ana");
    const reloaded = new QueryClient();
    restoreQueryCache(reloaded, "ana");
    expect(reloaded.getQueryData(["menu"])).toEqual({ items: ["pollo"] });
  });

  it("los datos restaurados quedan vencidos para pedirse otra vez al haber conexión", () => {
    saveQueryCache(clientWith([[["tables"], [{ id: "t1" }]]]), "ana");
    const reloaded = new QueryClient({ defaultOptions: { queries: { staleTime: 5000 } } });
    restoreQueryCache(reloaded, "ana");
    const updatedAt = reloaded.getQueryState(["tables"])!.dataUpdatedAt;
    expect(updatedAt).toBeLessThanOrEqual(Date.now());
    expect(reloaded.getQueryCache().find({ queryKey: ["tables"] })?.isStaleByTime(0)).toBe(true);
  });
});

