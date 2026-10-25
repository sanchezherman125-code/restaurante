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
});
