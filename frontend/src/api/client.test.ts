import { afterEach, expect, it, vi } from "vitest";
import { apiRequest, setTokens } from "./client";

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });

it("limita la renovación a un intento si el nuevo access token también es rechazado", async () => {
  setTokens("old-access", "refresh");
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(new Response("{}", { status: 401 }))
    .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "new", refresh_token: "new-refresh" })))
    .mockResolvedValueOnce(new Response("{}", { status: 401 }));
  vi.stubGlobal("fetch", fetchMock);
  await expect(apiRequest("/api/v1/auth/me")).rejects.toMatchObject({ code: "SESSION_EXPIRED", status: 401 });
  expect(fetchMock).toHaveBeenCalledTimes(3);
});
