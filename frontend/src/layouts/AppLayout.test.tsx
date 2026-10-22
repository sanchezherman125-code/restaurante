import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "../stores/session";
import { AppLayout } from "./AppLayout";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { status: "OPEN", opened_at: "2026-10-22T21:06:00Z" }, isLoading: false, isError: false }),
}));
vi.mock("../api/endpoints", () => ({ shiftsApi: { current: vi.fn() } }));
vi.mock("../notifications/push", () => ({ hasPushSubscription: () => Promise.resolve(false), supportsWebPush: () => false }));

function renderAs(role: "ADMIN" | "WAITER" | "KITCHEN", name = "Ana Mesera") {
  useSession.setState({ user: { id: "u1", username: "ana", display_name: name, role, is_active: true, created_at: "" } });
  return render(
    <MemoryRouter initialEntries={["/panel"]}>
      <Routes><Route path="/" element={<AppLayout />}><Route path="panel" element={<div>contenido</div>} /></Route></Routes>
    </MemoryRouter>,
  );
}

describe("AppLayout", () => {
  beforeEach(() => useSession.setState({ user: null }));

  it("el administrador ve toda la administración agrupada en la barra lateral", () => {
    renderAs("ADMIN", "Dueño");
    const sidebar = screen.getByRole("complementary", { name: "Navegación principal" });
    for (const label of ["Panel", "Salón", "Pedidos", "Cocina y parrilla", "Carta", "Mesas", "Usuarios", "Turnos", "Reportes", "Historial", "Gastos", "Compras"]) {
      expect(within(sidebar).getByRole("link", { name: label })).toBeInTheDocument();
    }
    expect(within(sidebar).getByText("Dinero")).toBeInTheDocument();
  });

  it("el mesero y la cocina solo ven sus destinos, sin administración", () => {
    renderAs("WAITER");
    const sidebar = screen.getByRole("complementary", { name: "Navegación principal" });
    expect(within(sidebar).getAllByRole("link").map((link) => link.textContent)).toEqual(["Mesas", "Pedidos", "Gastos"]);
    expect(within(sidebar).queryByRole("link", { name: "Usuarios" })).toBeNull();
  });

  it("la cocina conserva su navegación y muestra el estado del turno", () => {
    renderAs("KITCHEN", "Cocina");
    expect(screen.getAllByRole("link", { name: "Comandas" }).length).toBeGreaterThan(0);
    expect(screen.getByText(/Turno abierto desde/)).toBeVisible();
  });

  it("incluye un enlace para saltar al contenido y el contenido principal enfocable", () => {
    renderAs("ADMIN", "Dueño");
    expect(screen.getByRole("link", { name: "Saltar al contenido" })).toHaveAttribute("href", "#contenido");
    expect(screen.getByRole("main")).toHaveAttribute("id", "contenido");
  });

  it("cerrar sesión pide abrir el menú de cuenta: nunca ocurre con un solo toque accidental", async () => {
    const logout = vi.fn().mockResolvedValue(undefined);
    useSession.setState({ logout });
    const user = userEvent.setup();
    renderAs("WAITER");
    await user.click(screen.getByRole("button", { name: /Cuenta de Ana Mesera/ }));
    expect(logout).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog");
    await user.click(within(dialog).getByRole("button", { name: /Cerrar sesión/ }));
    expect(logout).toHaveBeenCalledTimes(1);
  });
});
