import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, NetworkError, OwnerChangedError, getAccessToken, setTokens } from "../api/client";
import { fakeJwt } from "../test/jwt";
import type { User } from "../types/api";
import { useSession } from "./session";

const mocks = vi.hoisted(() => ({ me: vi.fn() }));
vi.mock("../api/endpoints", () => ({ authApi: { me: mocks.me, login: vi.fn(), logout: vi.fn() } }));

const ana: User = { id: "w1", username: "ana", display_name: "Ana", role: "WAITER", is_active: true, created_at: "" };

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
