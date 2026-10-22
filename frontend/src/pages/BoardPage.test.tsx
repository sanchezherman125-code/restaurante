import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useSession } from "../stores/session";
import type { BoardTask, ItemGroup } from "../types/api";
import { BoardPage } from "./BoardPage";

const mocks = vi.hoisted(() => ({
  groups: [] as unknown[],
  sendOrQueue: vi.fn(),
  setTaskStatus: vi.fn(),
  kitchen: vi.fn(),
  grill: vi.fn(),
  cancelItem: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryKey[0] === "preparation" ? mocks.groups : { items: [], categories: [] },
    isLoading: false,
    refetch: vi.fn(),
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../api/endpoints", () => ({
  menuApi: { get: vi.fn(), setAvailability: vi.fn() },
  ordersApi: { cancelItem: mocks.cancelItem },
  preparationApi: { kitchen: mocks.kitchen, grill: mocks.grill, setTaskStatus: mocks.setTaskStatus },
}));
vi.mock("../lib/send", () => ({
  errorMessage: () => "error",
  sendOrQueue: mocks.sendOrQueue,
}));

function task(overrides: Partial<BoardTask>): BoardTask {
  return {
    id: "task-papas", order_item_id: "item-1", order_id: "order-1", command_id: "cmd-1", name: "Preparar papas",
    item_name: "Alitas con papas", quantity: 1, notes: null, replacement_description: null, area: "KITCHEN",
    status: "PENDING", expected_minutes: 7, started_at: null, ready_at: null, created_at: new Date().toISOString(),
    item_status: "PENDING",
    other_tasks: [{ id: "task-alitas", name: "Preparar alitas", area: "GRILL", status: "PENDING" }],
    ...overrides,
  };
}

function group(tasks: BoardTask[], otherAreas: Record<string, string> = { GRILL: "PENDING" }): ItemGroup {
  return {
    order_id: "order-1", command_id: "cmd-1", sequence_number: 1, table_name: "Mesa 5", table_number: 5,
    order_type: "DINE_IN", persons_count: 2, notes: null, command_notes: null, created_at: new Date().toISOString(),
    waiter_name: "Ana", tasks, other_areas: otherAreas, order_general_status: "OPEN", elapsed_seconds: 0,
  };
}

function setRole(role: "KITCHEN" | "GRILL" | "ADMIN") {
  useSession.setState({ user: { id: "u", username: "u", display_name: "U", role, is_active: true, created_at: "" } });
}

describe("tablero de preparación por tareas", () => {
  beforeEach(() => {
    mocks.sendOrQueue.mockReset();
    mocks.sendOrQueue.mockImplementation(async (_op, exec) => { await exec("op-1"); return { queued: false }; });
    mocks.setTaskStatus.mockReset().mockResolvedValue({});
    mocks.cancelItem.mockReset().mockResolvedValue({});
  });

  it("cocina muestra solo su tarea del plato compartido y el estado de parrilla", () => {
    setRole("KITCHEN");
    mocks.groups = [group([task({})])];
    render(<BoardPage />);
    const card = screen.getByTestId("prep-card");
    expect(within(card).getByText("Preparar papas")).toBeVisible();
    expect(within(card).getByText("Alitas con papas")).toBeVisible();
    expect(within(card).queryByText("Preparar alitas")).toBeNull();
    expect(within(card).getAllByText(/Parrilla: pendiente/).length).toBeGreaterThan(0);
    expect(within(card).getByText(/de 7 min/)).toBeVisible();
  });

  it("parrilla muestra solo su tarea y que cocina ya terminó", () => {
    setRole("GRILL");
    mocks.groups = [group(
      [task({ id: "task-alitas", name: "Preparar alitas", area: "GRILL", expected_minutes: 12,
        other_tasks: [{ id: "task-papas", name: "Preparar papas", area: "KITCHEN", status: "READY" }] })],
      { KITCHEN: "READY" },
    )];
    render(<BoardPage />);
    const card = screen.getByTestId("prep-card");
    expect(within(card).getByText("Preparar alitas")).toBeVisible();
    expect(within(card).queryByText("Preparar papas")).toBeNull();
    expect(within(card).getAllByText(/Cocina: listo/).length).toBeGreaterThan(0);
  });

  it("empezar y terminar usan el endpoint de tareas con su propio id, encolable sin conexión", async () => {
    setRole("KITCHEN");
    mocks.groups = [group([task({})])];
    const user = userEvent.setup();
    render(<BoardPage />);
    await user.click(screen.getByRole("button", { name: /Empezar/ }));
    expect(mocks.sendOrQueue).toHaveBeenCalledTimes(1);
    expect(mocks.sendOrQueue.mock.calls[0][0]).toMatchObject({
      operation_type: "UPDATE_PREPARATION_TASK",
      path: "/api/v1/orders/order-1/items/item-1/tasks/task-papas/status",
      method: "POST",
      body: { status: "PREPARING" },
    });
    expect(mocks.setTaskStatus).toHaveBeenCalledWith("order-1", "item-1", "task-papas", "PREPARING", "op-1");
  });

  it("una tarea terminada espera a la otra área y ya no ofrece botones de avance", () => {
    setRole("KITCHEN");
    mocks.groups = [group([task({ status: "READY", item_status: "PREPARING" })])];
    render(<BoardPage />);
    expect(screen.getByText(/Esperando a Parrilla/)).toBeVisible();
    expect(screen.queryByRole("button", { name: /Empezar|Listo/ })).toBeNull();
  });

  it("cancelar pide confirmación y cancela el plato completo, no la tarea", async () => {
    setRole("KITCHEN");
    mocks.groups = [group([task({ status: "PREPARING", item_status: "PREPARING" })])];
    const user = userEvent.setup();
    render(<BoardPage />);
    await user.click(screen.getByRole("button", { name: "Cancelar plato" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText(/Se cancela el plato completo/)).toBeVisible();
    expect(mocks.sendOrQueue).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole("button", { name: "Cancelar plato" }));
    expect(mocks.sendOrQueue.mock.calls[0][0]).toMatchObject({
      operation_type: "CANCEL_ORDER_ITEM",
      path: "/api/v1/orders/order-1/items/item-1/cancel",
    });
  });

  it("un plato ya listo o entregado no se puede cancelar desde el tablero", () => {
    setRole("KITCHEN");
    mocks.groups = [group([task({ status: "READY", item_status: "READY" })])];
    render(<BoardPage />);
    expect(screen.queryByRole("button", { name: "Cancelar plato" })).toBeNull();
  });

  it("el administrador puede alternar entre ambos tableros", async () => {
    setRole("ADMIN");
    mocks.groups = [group([task({})])];
    const user = userEvent.setup();
    render(<BoardPage />);
    expect(screen.getByRole("button", { name: /Cocina/ })).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Parrilla/ }));
    expect(screen.getByRole("heading", { name: /Parrilla · comandas/ })).toBeVisible();
  });

  it("ordena por urgencia: la comanda atrasada va primero aunque llegara después", () => {
    setRole("KITCHEN");
    const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();
    const fresh = group([task({ id: "t-fresh", created_at: minutesAgo(1), expected_minutes: 20 })]);
    fresh.command_id = "cmd-fresh"; fresh.table_name = "Mesa 2"; fresh.created_at = minutesAgo(1);
    const late = group([task({ id: "t-late", status: "PREPARING", started_at: minutesAgo(30), created_at: minutesAgo(31), expected_minutes: 10, item_status: "PREPARING" })]);
    late.command_id = "cmd-late"; late.table_name = "Mesa 9"; late.created_at = minutesAgo(31);
    mocks.groups = [fresh, late];
    render(<BoardPage />);
    const cards = screen.getAllByTestId("prep-card");
    expect(cards.map((card) => card.getAttribute("data-table"))).toEqual(["Mesa 9", "Mesa 2"]);
    expect(cards[0]).toHaveAttribute("data-tone", "late");
    expect(within(cards[0]).getByText(/atrasado/)).toBeVisible();
  });

  it("muestra el total de tareas por estado en el encabezado", () => {
    setRole("GRILL");
    mocks.groups = [group([task({ status: "PENDING" }), task({ id: "b", status: "PREPARING" }), task({ id: "c", status: "READY" })])];
    render(<BoardPage />);
    const totals = screen.getByRole("status");
    expect(totals).toHaveTextContent("1 pendiente");
    expect(totals).toHaveTextContent("1 preparando");
    expect(totals).toHaveTextContent("1 lista");
  });
});
