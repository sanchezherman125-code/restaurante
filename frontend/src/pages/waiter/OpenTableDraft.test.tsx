import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePendingOrders } from "../../stores/pendingOrders";
import { useSession } from "../../stores/session";
import { useTableDrafts } from "../../stores/tableDrafts";
import { useUi } from "../../stores/ui";
import { TableOrderPage } from "./TableOrderPage";
import { TablesPage } from "./TablesPage";

const mocks = vi.hoisted(() => ({
  shift: { status: "OPEN", opened_at: "2026-10-22T21:00:00Z" } as unknown,
  activeOrders: [] as unknown[],
  sendOrQueue: vi.fn(),
  enqueue: vi.fn(),
  create: vi.fn(),
  createCommand: vi.fn(),
  setQueryData: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryKey[0] === "tables" ? [{ id: "table-2", name: "Mesa 2", number: 2, is_active: true, status: "FREE", order_id: null }]
      : queryKey[0] === "orders" ? mocks.activeOrders
      : queryKey[0] === "shifts" ? mocks.shift
      : queryKey[0] === "menu" ? {
        categories: [{ id: "c", name: "Fondos", sort_order: 1, is_active: true }],
        items: [{ id: "pollo", category_id: "c", name: "Pollo a la brasa", description: null, price: "25.00",
          requires_preparation: true, preparation_area: "KITCHEN", expected_prep_minutes: 20, is_available: true,
          is_active: true, image_url: null, availability_status: "AVAILABLE", preparation_steps: [] }],
      } : null,
    isLoading: false,
    isError: false,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: mocks.setQueryData }),
}));
vi.mock("../../api/endpoints", () => ({
  ordersApi: { create: mocks.create, createCommand: mocks.createCommand, active: vi.fn(), setItemStatus: vi.fn(), cancelItem: vi.fn(), cancelEmpty: vi.fn() },
  menuApi: { get: vi.fn() },
  tablesApi: { list: vi.fn() },
  shiftsApi: { current: vi.fn() },
}));
vi.mock("../../lib/send", () => ({ errorMessage: () => "error", sendOrQueue: mocks.sendOrQueue }));
vi.mock("../../offline/queue", async (importOriginal) => ({ ...(await importOriginal<object>()), enqueue: mocks.enqueue }));

function app(initial: string) {
  return render(
    <MemoryRouter initialEntries={[initial]}>
      <Routes>
        <Route path="/mesas" element={<TablesPage />} />
        <Route path="/mesas/:tableId" element={<TableOrderPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

async function sendFirstCommand(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: "Agregar Pollo a la brasa" }));
  await user.click(screen.getByTestId("send-command"));
  await user.click(screen.getByRole("button", { name: "Confirmar envío" }));
}

describe("abrir una mesa no crea un pedido hasta enviar la primera comanda", () => {
  beforeEach(() => {
    sessionStorage.clear();
    localStorage.clear();
    for (const mock of [mocks.sendOrQueue, mocks.enqueue, mocks.create, mocks.createCommand, mocks.setQueryData]) mock.mockReset();
    mocks.shift = { status: "OPEN", opened_at: "2026-10-22T21:00:00Z" };
    mocks.activeOrders = [];
    useSession.setState({ user: { id: "w1", username: "ana", display_name: "Ana", role: "WAITER", is_active: true, created_at: "" } });
    useTableDrafts.setState({ drafts: {} });
    usePendingOrders.setState({ records: [] });
    useUi.setState({ toasts: [] });
  });

  it("abrir la mesa solo la abre en este dispositivo: ninguna llamada al servidor", async () => {
    const user = userEvent.setup();
    app("/mesas");
    await user.click(screen.getByRole("button", { name: /Mesa 2, libre/ }));
    await user.click(screen.getByRole("button", { name: "Aumentar personas" }));
    await user.click(screen.getByRole("button", { name: "Abrir mesa" }));
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.sendOrQueue).not.toHaveBeenCalled();
    expect(useTableDrafts.getState().drafts["table-2"]).toMatchObject({ table_name: "Mesa 2", persons_count: 3 });
    expect(await screen.findByText(/el pedido se crea al enviar la primera comanda/)).toBeVisible();
  });

  it("cerrar la mesa sin pedir la deja libre y no toca el servidor", async () => {
    useTableDrafts.getState().open({ table_id: "table-2", table_name: "Mesa 2", persons_count: 2, created_at: Date.now() });
    const user = userEvent.setup();
    app("/mesas/table-2");
    await user.click(screen.getByRole("button", { name: "Cerrar mesa" }));
    expect(useTableDrafts.getState().drafts["table-2"]).toBeUndefined();
    expect(mocks.create).not.toHaveBeenCalled();
    expect(await screen.findByRole("button", { name: /Mesa 2, libre/ })).toBeVisible();
  });

  it("sin turno abierto no deja abrir la mesa", async () => {
    mocks.shift = null;
    const user = userEvent.setup();
    app("/mesas");
    await user.click(screen.getByRole("button", { name: /Mesa 2, libre/ }));
    expect(screen.queryByRole("button", { name: "Abrir mesa" })).toBeNull();
    expect(useUi.getState().toasts.map((toast) => toast.title)).toContain("No hay un turno abierto");
  });

  it("con conexión, la primera comanda crea el pedido y luego envía la comanda a ese pedido", async () => {
    useTableDrafts.getState().open({ table_id: "table-2", table_name: "Mesa 2", persons_count: 4, created_at: Date.now() });
    mocks.sendOrQueue.mockImplementation(async (_op, exec) => { await exec("op-1"); return { queued: false, operationId: null }; });
    mocks.create.mockResolvedValue({ id: "order-9", table_id: "table-2", items: [], commands: [] });
    mocks.createCommand.mockResolvedValue({ order: { id: "order-9", table_id: "table-2", items: [], commands: [] } });
    const user = userEvent.setup();
    app("/mesas/table-2");
    await sendFirstCommand(user);
    await waitFor(() => expect(mocks.createCommand).toHaveBeenCalledTimes(1));
    expect(mocks.sendOrQueue.mock.calls.map(([op]) => op.operation_type)).toEqual(["CREATE_ORDER", "CREATE_COMMAND"]);
    expect(mocks.create.mock.calls[0][0]).toMatchObject({ order_type: "DINE_IN", table_id: "table-2", persons_count: 4 });
    expect(mocks.createCommand.mock.calls[0][0]).toBe("order-9");
    expect(mocks.setQueryData).toHaveBeenCalled();
    expect(useTableDrafts.getState().drafts["table-2"]).toBeUndefined();
  });

  it("sin conexión, el pedido y la comanda quedan en la cola, encadenados", async () => {
    useTableDrafts.getState().open({ table_id: "table-2", table_name: "Mesa 2", persons_count: 2, created_at: Date.now() });
    mocks.sendOrQueue.mockResolvedValue({ queued: true, operationId: "queued-order" });
    const user = userEvent.setup();
    app("/mesas/table-2");
    await sendFirstCommand(user);
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    expect(mocks.enqueue.mock.calls[0][0]).toMatchObject({
      operation_type: "CREATE_COMMAND", path: "/api/v1/orders/{orderRef}/commands", parent_operation_id: "queued-order",
    });
    expect(usePendingOrders.getState().records).toEqual([expect.objectContaining({ operation_id: "queued-order", table_id: "table-2" })]);
    expect(mocks.createCommand).not.toHaveBeenCalled();
  });

  it("si el servidor rechaza crear el pedido, la mesa y el carrito se conservan", async () => {
    useTableDrafts.getState().open({ table_id: "table-2", table_name: "Mesa 2", persons_count: 2, created_at: Date.now() });
    mocks.sendOrQueue.mockRejectedValue(new Error("La mesa ya tiene un pedido abierto."));
    const user = userEvent.setup();
    app("/mesas/table-2");
    await sendFirstCommand(user);
    await waitFor(() => expect(useUi.getState().toasts.map((toast) => toast.title)).toContain("No se pudo enviar la comanda"));
    expect(useTableDrafts.getState().drafts["table-2"]).toBeDefined();
    expect(screen.getByTestId("send-command")).toBeInTheDocument();
  });
});
