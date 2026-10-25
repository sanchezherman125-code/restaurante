import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError, NetworkError, OwnerChangedError, apiRequest, getAccessToken, getRefreshToken, isConnectivityError, onSessionExpired, setTokens,
  storedTokenSubject, withRequestOwner,
} from "./client";
import { fakeJwt } from "../test/jwt";

afterEach(async () => {
  // La renovación compartida se libera en el siguiente ciclo: cada prueba parte sin renovación en curso.
  await new Promise((resolve) => setTimeout(resolve, 0));
  vi.unstubAllGlobals();
  localStorage.clear();
});

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

describe("sesión y conectividad", () => {
  it("sin red para renovar conserva los tokens y responde como error de conexión", async () => {
    setTokens("old-access", "refresh");
    const expired = vi.fn();
    const unsubscribe = onSessionExpired(expired);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockRejectedValueOnce(new TypeError("Failed to fetch")));
    await expect(apiRequest("/api/v1/auth/me")).rejects.toBeInstanceOf(NetworkError);
    expect(getAccessToken()).toBe("old-access");
    expect(getRefreshToken()).toBe("refresh");
    expect(expired).not.toHaveBeenCalled();
    unsubscribe();
  });

  it("un servidor caído al renovar no invalida la sesión", async () => {
    setTokens("old-access", "refresh");
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 503 })));
    await expect(apiRequest("/api/v1/auth/me")).rejects.toBeInstanceOf(NetworkError);
    expect(getRefreshToken()).toBe("refresh");
  });

  it("credenciales rechazadas al renovar limpian los tokens y avisan una vez", async () => {
    setTokens("old-access", "refresh");
    const expired = vi.fn();
    const unsubscribe = onSessionExpired(expired);
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(new Response("{}", { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: "INVALID_TOKEN" } }), { status: 401 })));
    await expect(apiRequest("/api/v1/auth/me")).rejects.toMatchObject({ code: "SESSION_EXPIRED" });
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(expired).toHaveBeenCalledTimes(1);
    unsubscribe();
  });

  it("clasifica errores de conectividad y lee el usuario del token guardado", () => {
    expect(isConnectivityError(new NetworkError())).toBe(true);
    expect(isConnectivityError(new ApiError(502, "HTTP_ERROR", "x"))).toBe(true);
    expect(isConnectivityError(new ApiError(401, "SESSION_EXPIRED", "x"))).toBe(false);
    setTokens(fakeJwt("user-7"), "refresh");
    expect(storedTokenSubject()).toBe("user-7");
  });
});

describe("peticiones ligadas a un usuario", () => {
  it("una petición iniciada dentro de withRequestOwner queda ligada a ese usuario aunque el token sea de otro", async () => {
    setTokens(fakeJwt("luis"), "refresh-luis");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(withRequestOwner("ana", () => apiRequest("/api/v1/expenses", { method: "POST" }))).rejects.toBeInstanceOf(OwnerChangedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sin indicar dueño, la petición queda ligada a quien la inició: un 401 tras cambiar de usuario no renueva", async () => {
    setTokens(fakeJwt("ana"), "refresh-ana");
    const fetchMock = vi.fn().mockImplementationOnce(async () => {
      setTokens(fakeJwt("luis"), "refresh-luis");
      return new Response("{}", { status: 401 });
    });
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiRequest("/api/v1/orders/active")).rejects.toBeInstanceOf(OwnerChangedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(getRefreshToken()).toBe("refresh-luis");
  });

  it("no sale si las credenciales guardadas son de otro usuario", async () => {
    setTokens(fakeJwt("luis"), "refresh-luis");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(apiRequest("/api/v1/expenses", { method: "POST", owner: "ana" })).rejects.toBeInstanceOf(OwnerChangedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
