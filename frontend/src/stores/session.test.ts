import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, NetworkError, OwnerChangedError, getAccessToken, setTokens } from "../api/client";
import { fakeJwt } from "../test/jwt";
import type { User } from "../types/api";
import { useSession } from "./session";

const mocks = vi.hoisted(() => ({ me: vi.fn(), login: vi.fn(), logout: vi.fn() }));
vi.mock("../api/endpoints", () => ({ authApi: { me: mocks.me, login: mocks.login, logout: mocks.logout } }));

const ana: User = { id: "w1", username: "ana", display_name: "Ana", role: "WAITER", is_active: true, created_at: "" };
const luis: User = { id: "w2", username: "luis", display_name: "Luis", role: "WAITER", is_active: true, created_at: "" };

/** Respuesta de /auth/me que llega cuando la prueba lo decide. */
function deferredMe() {
  let resolve: (user: User) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  mocks.me.mockReturnValueOnce(new Promise<User>((ok, fail) => { resolve = ok; reject = fail; }));
  return { resolve, reject };
}

/** Ingreso real de Luis por el store: tokens nuevos y su /auth/me. */
async function loginLuis() {
  mocks.login.mockResolvedValueOnce({ access_token: fakeJwt("w2"), refresh_token: "refresh-luis" });
  mocks.me.mockResolvedValueOnce(luis);
  await useSession.getState().login("luis", "1234");
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("restauración de sesión sin conexión", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.me.mockReset();
    useSession.setState({ user: ana, initialized: false, unverified: false });
  });

  it("sin red conserva la identidad y los tokens del mismo usuario, pendiente de revalidar", async () => {
    setTokens(fakeJwt("w1"), "refresh");
    mocks.me.mockRejectedValue(new NetworkError());
    await useSession.getState().restore();
    expect(useSession.getState()).toMatchObject({ user: ana, initialized: true, unverified: true });
    expect(getAccessToken()).not.toBeNull();
  });

  it("un servidor caído (5xx) tampoco cierra la sesión", async () => {
    setTokens(fakeJwt("w1"), "refresh");
    mocks.me.mockRejectedValue(new ApiError(503, "HTTP_ERROR", "Error 503"));
    await useSession.getState().restore();
    expect(useSession.getState().user?.id).toBe("w1");
  });

  it("nunca entrega la identidad guardada si los tokens pertenecen a otro usuario", async () => {
    setTokens(fakeJwt("otro"), "refresh");
    mocks.me.mockRejectedValue(new NetworkError());
    await useSession.getState().restore();
    expect(useSession.getState()).toMatchObject({ user: null, initialized: true, unverified: false });
  });

  it("sin tokens no hay sesión aunque quede un usuario guardado", async () => {
    await useSession.getState().restore();
    expect(useSession.getState().user).toBeNull();
    expect(mocks.me).not.toHaveBeenCalled();
  });

  it("credenciales rechazadas limpian tokens e identidad (al confirmarse en segundo plano)", async () => {
    setTokens(fakeJwt("w1"), "refresh");
    mocks.me.mockRejectedValue(new ApiError(401, "SESSION_EXPIRED", "La sesión expiró."));
    await useSession.getState().restore();
    await vi.waitFor(() => expect(useSession.getState().user).toBeNull());
    expect(getAccessToken()).toBeNull();
  });

  it("con identidad local, el arranque no espera a una red que no responde", async () => {
    setTokens(fakeJwt("w1"), "refresh");
    mocks.me.mockReturnValue(new Promise(() => undefined)); // /auth/me nunca responde
    await useSession.getState().restore();
    expect(useSession.getState()).toMatchObject({ user: ana, initialized: true, unverified: true });
  });

  it("la confirmación en segundo plano actualiza la identidad y quita la marca de pendiente", async () => {
    setTokens(fakeJwt("w1"), "refresh");
    let answer: (user: User) => void = () => undefined;
    mocks.me.mockReturnValue(new Promise<User>((resolve) => { answer = resolve; }));
    await useSession.getState().restore();
    expect(useSession.getState().unverified).toBe(true);
    answer({ ...ana, display_name: "Ana M." });
    await vi.waitFor(() => expect(useSession.getState()).toMatchObject({ unverified: false, user: { display_name: "Ana M." } }));
  });

  it("sin identidad local utilizable espera al servidor y, sin red, termina en el ingreso conservando los tokens", async () => {
    useSession.setState({ user: null });
    setTokens(fakeJwt("w1"), "refresh");
    mocks.me.mockRejectedValue(new NetworkError());
    await useSession.getState().restore();
    expect(useSession.getState()).toMatchObject({ user: null, initialized: true });
    expect(getAccessToken()).not.toBeNull();
  });

  it("un error inesperado durante la restauración nunca deja la pantalla de carga", async () => {
    setTokens(fakeJwt("w1"), "refresh");
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("almacenamiento bloqueado"); });
    try {
      await useSession.getState().restore();
    } finally {
      getItem.mockRestore();
    }
    expect(useSession.getState().initialized).toBe(true);
  });

  it("si mientras se confirmaba ingresó otro usuario, la confirmación no toca su sesión", async () => {
    setTokens(fakeJwt("w1"), "refresh");
    useSession.setState({ user: ana, initialized: true, unverified: true });
    mocks.me.mockRejectedValue(new OwnerChangedError());
    await useSession.getState().revalidate();
    expect(useSession.getState().user).toEqual(ana);
    expect(getAccessToken()).not.toBeNull();
  });

  it("al reconectar revalida con el servidor; sin red sigue igual", async () => {
    setTokens(fakeJwt("w1"), "refresh");
    useSession.setState({ user: ana, initialized: true, unverified: true });
    mocks.me.mockRejectedValueOnce(new NetworkError());
    await useSession.getState().revalidate();
    expect(useSession.getState()).toMatchObject({ user: ana, unverified: true });

    mocks.me.mockResolvedValueOnce({ ...ana, display_name: "Ana M." });
    await useSession.getState().revalidate();
    expect(useSession.getState()).toMatchObject({ unverified: false, user: { display_name: "Ana M." } });
  });

  it("al reconectar con la sesión revocada vuelve al ingreso", async () => {
    setTokens(fakeJwt("w1"), "refresh");
    useSession.setState({ user: ana, initialized: true, unverified: true });
    mocks.me.mockRejectedValue(new ApiError(403, "USER_INACTIVE", "Usuario inactivo"));
    await useSession.getState().revalidate();
    expect(useSession.getState().user).toBeNull();
    expect(getAccessToken()).toBeNull();
  });
});

describe("respuestas tardías de una sesión anterior", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.me.mockReset();
    mocks.login.mockReset();
    mocks.logout.mockReset();
    setTokens(fakeJwt("w1"), "refresh-ana");
    useSession.setState({ user: ana, initialized: true, unverified: true });
  });

  it("la confirmación tardía de Ana no reemplaza a Luis, que ingresó mientras tanto", async () => {
    const late = deferredMe();
    const revalidation = useSession.getState().revalidate();
    await loginLuis();
    late.resolve(ana);
    await revalidation;
    expect(useSession.getState().user).toEqual(luis);
    expect(useSession.getState().unverified).toBe(false);
  });

  it("el rechazo tardío de la sesión de Ana no borra las credenciales de Luis", async () => {
    const late = deferredMe();
    const revalidation = useSession.getState().revalidate();
    await loginLuis();
    late.reject(new ApiError(403, "USER_INACTIVE", "Usuario inactivo"));
    await revalidation;
    expect(useSession.getState().user).toEqual(luis);
    expect(getAccessToken()).toBe(fakeJwt("w2"));
  });

  it("una confirmación tardía no revierte el cierre de sesión", async () => {
    const late = deferredMe();
    const revalidation = useSession.getState().revalidate();
    await useSession.getState().logout();
    late.resolve(ana);
    await revalidation;
    expect(useSession.getState().user).toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it("si la sesión cambió de dueño durante la confirmación, la respuesta no se aplica", async () => {
    useSession.setState({ user: null, unverified: false });
    const late = deferredMe();
    const revalidation = useSession.getState().revalidate();
    setTokens(fakeJwt("w2"), "refresh-luis");
    late.resolve(ana);
    await revalidation;
    expect(useSession.getState().user).toBeNull();
    expect(getAccessToken()).toBe(fakeJwt("w2"));
  });

  it("la restauración que espera al servidor no pisa a quien ingresó mientras tanto", async () => {
    useSession.setState({ user: null, initialized: false, unverified: false });
    const late = deferredMe();
    const restoring = useSession.getState().restore();
    await loginLuis();
    late.reject(new ApiError(401, "SESSION_EXPIRED", "La sesión expiró."));
    await restoring;
    expect(useSession.getState().user).toEqual(luis);
    expect(getAccessToken()).toBe(fakeJwt("w2"));
  });
});

describe("cierre de sesión sin servidor", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    localStorage.clear();
    mocks.logout.mockReset();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    setTokens(fakeJwt("w1"), "refresh-ana");
    useSession.setState({ user: ana, initialized: true, unverified: false });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sale de inmediato aunque el servidor no responda", async () => {
    fetchMock.mockReturnValue(new Promise(() => undefined));
    mocks.logout.mockReturnValue(new Promise(() => undefined));
    const outcome = await Promise.race([
      useSession.getState().logout().then(() => "salió"),
      new Promise((resolve) => setTimeout(() => resolve("esperando al servidor"), 300)),
    ]);
    expect(outcome).toBe("salió");
    expect(useSession.getState().user).toBeNull();
    expect(getAccessToken()).toBeNull();
  });

  it("revoca en el servidor con las credenciales de quien salió, aunque otro usuario ya haya ingresado", async () => {
    let answer: (response: Response) => void = () => undefined;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { answer = resolve; }));
    await useSession.getState().logout();
    await loginLuis();
    answer(new Response(null, { status: 204 }));
    await settle();
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toMatch(/\/auth\/logout$/);
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${fakeJwt("w1")}`);
    expect(useSession.getState().user).toEqual(luis);
    expect(getAccessToken()).toBe(fakeJwt("w2"));
  });

  it("con el acceso vencido renueva solo para revocar, sin guardar credenciales", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "nuevo", refresh_token: "nuevo-refresh" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    await useSession.getState().logout();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [, refreshInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(refreshInit.body as string)).toEqual({ refresh_token: "refresh-ana" });
    const [, retryInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect((retryInit.headers as Record<string, string>).Authorization).toBe("Bearer nuevo");
    expect(getAccessToken()).toBeNull();
  });
});
