import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoginPage } from "./LoginPage";
import { useSession } from "../stores/session";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("LoginPage", () => {
  beforeEach(() => {
    localStorage.clear();
    useSession.setState({ user: null, initialized: false });
  });

  it("ingresa con usuario y PIN usando el teclado numérico", async () => {
    const fetchMock = vi.fn(async (url: RequestInfo | URL) => {
      const target = String(url);
      if (target.endsWith("/api/v1/auth/login")) {
        return jsonResponse({ access_token: "access", refresh_token: "refresh", token_type: "bearer" });
      }
      if (target.endsWith("/api/v1/auth/me")) {
        return jsonResponse({
          id: "u1",
          username: "mesero1",
          display_name: "Ana Mesero",
          role: "WAITER",
          is_active: true,
          created_at: new Date().toISOString(),
        });
      }
      return jsonResponse({ error: { code: "NOT_FOUND", message: "no", details: {} } }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>HOME</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText("Usuario"), "mesero1");
    for (const key of ["1", "2", "3", "4"]) {
      await user.click(screen.getByRole("button", { name: key }));
    }
    await user.click(screen.getByRole("button", { name: "Ingresar" }));

    expect(await screen.findByText("HOME")).toBeInTheDocument();
    expect(useSession.getState().user?.role).toBe("WAITER");

    const loginCall = (fetchMock.mock.calls as unknown as [string, RequestInit][]).find(([url]) =>
      String(url).endsWith("/auth/login"),
    );
    expect(loginCall).toBeTruthy();
    expect(JSON.parse(String(loginCall![1].body))).toMatchObject({ username: "mesero1", pin: "1234" });
  });

  it("muestra error con PIN incorrecto", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({ error: { code: "INVALID_CREDENTIALS", message: "Usuario o PIN incorrectos.", details: {} } }, 401),
      ),
    );

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={["/login"]}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/" element={<div>HOME</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await user.type(screen.getByLabelText("Usuario"), "mesero1");
    for (const key of ["1", "2", "3", "4"]) {
      await user.click(screen.getByRole("button", { name: key }));
    }
    await user.click(screen.getByRole("button", { name: "Ingresar" }));

    expect(await screen.findByText("Usuario o PIN incorrectos.")).toBeInTheDocument();
    expect(screen.queryByText("HOME")).not.toBeInTheDocument();
  });
});
