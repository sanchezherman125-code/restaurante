import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Menu, MenuItem } from "../../types/api";
import { describeSteps, MenuAdminPage, validateSteps } from "./MenuAdminPage";

const mocks = vi.hoisted(() => ({
  menu: {} as unknown,
  createItem: vi.fn(),
  updateItem: vi.fn(),
  toast: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mocks.menu, isLoading: false }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../../api/endpoints", () => ({
  menuApi: {
    get: vi.fn(), createItem: mocks.createItem, updateItem: mocks.updateItem,
    createCategory: vi.fn(), updateCategory: vi.fn(), setAvailability: vi.fn(),
  },
}));
vi.mock("../../stores/ui", () => ({
  useUi: (selector: (state: { toast: typeof mocks.toast }) => unknown) => selector({ toast: mocks.toast }),
}));

function menuItem(overrides: Partial<MenuItem>): MenuItem {
  return {
    id: "m1", category_id: "c1", name: "Alitas con papas", description: null, price: "25.00",
    requires_preparation: true, preparation_area: "GRILL", expected_prep_minutes: 12, is_available: true,
    is_active: true, image_url: null, availability_status: "AVAILABLE",
    preparation_steps: [
      { id: "s1", name: "Preparar alitas", area: "GRILL", expected_minutes: 12, sort_order: 0, is_active: true },
      { id: "s2", name: "Preparar papas", area: "KITCHEN", expected_minutes: 7, sort_order: 1, is_active: true },
    ],
    ...overrides,
  };
}

function setMenu(items: MenuItem[]) {
  mocks.menu = { categories: [{ id: "c1", name: "Fondos", sort_order: 0, is_active: true }], items } satisfies Menu;
}

describe("validateSteps", () => {
  const step = (over = {}) => ({ key: "k", name: "Freír", area: "KITCHEN" as const, minutes: "5", is_active: true, ...over });

  it("exige al menos una tarea activa con nombre y tiempo razonable", () => {
    expect(validateSteps("Plato", [])).toMatch(/al menos una tarea/);
    expect(validateSteps("Plato", [step({ is_active: false })])).toMatch(/activa/);
    expect(validateSteps("Plato", [step({ name: " " }), step({ key: "b" })])).toMatch(/nombre/);
    expect(validateSteps("Plato", [step({ minutes: "601" })])).toMatch(/600/);
    expect(validateSteps("Plato", Array.from({ length: 13 }, (_, i) => step({ key: String(i) })))).toMatch(/Máximo/);
  });

  it("acepta una única tarea sin nombre usando el del producto, y varias tareas en la misma área", () => {
    expect(validateSteps("Sopa", [step({ name: "" })])).toBeNull();
    expect(validateSteps("Combo", [step(), step({ key: "b", name: "Armar", minutes: "" })])).toBeNull();
  });
});

describe("describeSteps", () => {
  it("resume una receta compartida con sus áreas y tiempos", () => {
    expect(describeSteps(menuItem({}))).toBe("Preparar alitas (parrilla 12 min) + Preparar papas (cocina 7 min)");
    expect(describeSteps(menuItem({ requires_preparation: false, preparation_steps: [] }))).toBe("entrega directa");
    expect(describeSteps(menuItem({ preparation_steps: [], preparation_area: "KITCHEN", expected_prep_minutes: 9 }))).toBe("cocina · 9 min");
  });
});

describe("Preparación del producto", () => {
  beforeEach(() => {
    mocks.createItem.mockReset().mockResolvedValue({});
    mocks.updateItem.mockReset().mockResolvedValue({});
    mocks.toast.mockReset();
    setMenu([menuItem({})]);
  });

  it("edita un plato compartido: cambia el orden y elimina una tarea sin tocar el precio", async () => {
    const user = userEvent.setup();
    render(<MenuAdminPage />);
    await user.click(screen.getByRole("button", { name: "Editar" }));
    const steps = screen.getByTestId("prep-steps");
    expect(within(steps).getAllByTestId("prep-step")).toHaveLength(2);
    await user.click(within(steps).getByRole("button", { name: "Bajar tarea 1" }));
    expect(within(steps).getByLabelText("Nombre de la tarea 1")).toHaveValue("Preparar papas");
    await user.click(within(steps).getByRole("button", { name: "Eliminar tarea 2" }));
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(mocks.updateItem).toHaveBeenCalledTimes(1);
    const [id, payload] = mocks.updateItem.mock.calls[0];
    expect(id).toBe("m1");
    expect(payload.price).toBe("25.00");
    expect(payload.preparation_steps).toEqual([
      { id: "s2", name: "Preparar papas", area: "KITCHEN", expected_minutes: 7, is_active: true },
    ]);
  });

  it("crea el ejemplo Alitas con papas con dos áreas y un único precio", async () => {
    setMenu([]);
    const user = userEvent.setup();
    render(<MenuAdminPage />);
    await user.click(screen.getByRole("button", { name: "+ Producto" }));
    await user.type(screen.getAllByRole("textbox")[0], "Alitas con papas");
    await user.type(screen.getByRole("textbox", { name: "Nombre de la tarea 1" }), "Preparar alitas");
    await user.click(screen.getByRole("button", { name: "Parrilla" }));
    await user.type(screen.getByRole("textbox", { name: "Tiempo de la tarea 1 (min)" }), "12");
    await user.click(screen.getByRole("button", { name: "+ Agregar tarea" }));
    await user.type(screen.getByRole("textbox", { name: "Nombre de la tarea 2" }), "Preparar papas");
    await user.type(screen.getByRole("textbox", { name: "Tiempo de la tarea 2 (min)" }), "7");
    const priceInput = screen.getByText("Precio (S/)").closest(".field")!.querySelector("input")!;
    await user.type(priceInput, "25");
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(mocks.toast.mock.calls).toEqual([["success", "Producto guardado"]]);
    expect(mocks.createItem).toHaveBeenCalledTimes(1);
    const payload = mocks.createItem.mock.calls[0][0];
    expect(payload).toMatchObject({ name: "Alitas con papas", price: "25.00", requires_preparation: true });
    expect(payload.preparation_steps).toEqual([
      { name: "Preparar alitas", area: "GRILL", expected_minutes: 12, is_active: true },
      { name: "Preparar papas", area: "KITCHEN", expected_minutes: 7, is_active: true },
    ]);
    expect(payload).not.toHaveProperty("preparation_area");
  });

  it("no guarda una receta inválida y avisa por qué", async () => {
    const user = userEvent.setup();
    render(<MenuAdminPage />);
    await user.click(screen.getByRole("button", { name: "Editar" }));
    await user.clear(screen.getByRole("textbox", { name: "Nombre de la tarea 2" }));
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    expect(mocks.updateItem).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("error", "Revise la preparación", "Cada tarea necesita un nombre.");
  });

  it("un producto de entrega directa no envía tareas", async () => {
    setMenu([menuItem({ name: "Gaseosa", requires_preparation: false, preparation_area: null, preparation_steps: [] })]);
    const user = userEvent.setup();
    render(<MenuAdminPage />);
    await user.click(screen.getByRole("button", { name: "Editar" }));
    expect(screen.queryByTestId("prep-steps")).toBeNull();
    await user.click(screen.getByRole("button", { name: "Guardar" }));
    const payload = mocks.updateItem.mock.calls[0][1];
    expect(payload).not.toHaveProperty("preparation_steps");
    expect(payload).toMatchObject({ requires_preparation: false, preparation_area: null });
  });
});
