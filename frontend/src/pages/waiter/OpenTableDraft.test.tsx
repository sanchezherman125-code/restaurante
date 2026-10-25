import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { usePendingOrders } from "../../stores/pendingOrders";
import { useQueue } from "../../stores/queue";
import { useSession } from "../../stores/session";
import { useTableDrafts } from "../../stores/tableDrafts";
import { useUi } from "../../stores/ui";
import { TableOrderPage } from "./TableOrderPage";
import { TablesPage } from "./TablesPage";

const mocks = vi.hoisted(() => ({
  shift: { id: "shift-A", status: "OPEN", opened_at: "2026-10-22T21:00:00Z" } as unknown,
  activeOrders: [] as unknown[],
  sendOrQueue: vi.fn(),
  enqueue: vi.fn(),
  openWithCommand: vi.fn(),
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
  ordersApi: { openWithCommand: mocks.openWithCommand, active: vi.fn(), setItemStatus: vi.fn(), cancelItem: vi.fn(), cancelEmpty: vi.fn() },
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
    for (const mock of [mocks.sendOrQueue, mocks.enqueue, mocks.openWithCommand, mocks.setQueryData]) mock.mockReset();
    mocks.shift = { id: "shift-A", status: "OPEN", opened_at: "2026-10-22T21:00:00Z" };
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
    expect(mocks.openWithCommand).not.toHaveBeenCalled();
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
    expect(mocks.openWithCommand).not.toHaveBeenCalled();
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

  it("con conexión, la primera comanda crea pedido y comanda en UNA sola solicitud", async () => {
    useTableDrafts.getState().open({ table_id: "table-2", table_name: "Mesa 2", persons_count: 4, created_at: Date.now() });
    mocks.sendOrQueue.mockImplementation(async (_op, exec) => { await exec("op-1"); return { queued: false, operationId: null }; });
    mocks.openWithCommand.mockResolvedValue({ id: "order-9", table_id: "table-2", items: [], commands: [], command: { id: "cmd-1" } });
    const user = userEvent.setup();
    app("/mesas/table-2");
    await sendFirstCommand(user);
    await waitFor(() => expect(mocks.openWithCommand).toHaveBeenCalledTimes(1));
    expect(mocks.sendOrQueue).toHaveBeenCalledTimes(1);
    expect(mocks.sendOrQueue.mock.calls[0][0]).toMatchObject({ operation_type: "OPEN_TABLE_WITH_COMMAND", path: "/api/v1/orders/open-with-command" });
    const [payload, operationId] = mocks.openWithCommand.mock.calls[0];
    expect(payload).toMatchObject({ table_id: "table-2", persons_count: 4, items: [{ menu_item_id: "pollo", quantity: 1 }], shift_id: "shift-A" });
    expect(mocks.sendOrQueue.mock.calls[0][0].body).toMatchObject({ shift_id: "shift-A" });
    expect(operationId).toBe("op-1");
    expect(mocks.setQueryData).toHaveBeenCalled();
    expect(useTableDrafts.getState().drafts["table-2"]).toBeUndefined();
  });

  it("sin conexión, queda UNA operación en la cola y las siguientes comandas se encadenan a ella", async () => {
    useTableDrafts.getState().open({ table_id: "table-2", table_name: "Mesa 2", persons_count: 2, created_at: Date.now() });
    mocks.sendOrQueue.mockResolvedValue({ queued: true, operationId: "queued-open" });
    const user = userEvent.setup();
    app("/mesas/table-2");
    await sendFirstCommand(user);
    await waitFor(() => expect(usePendingOrders.getState().records).toHaveLength(1));
    expect(mocks.sendOrQueue).toHaveBeenCalledTimes(1);
    expect(mocks.enqueue).not.toHaveBeenCalled(); // ya no hay una segunda operación suelta que pueda quedar sola
    expect(usePendingOrders.getState().records[0]).toMatchObject({ operation_id: "queued-open", table_id: "table-2" });
    expect(useTableDrafts.getState().drafts["table-2"]).toBeUndefined();
    // Una segunda comanda mientras sigue sin conexión se encadena a la operación de apertura.
    await user.click(screen.getByRole("button", { name: "Agregar Pollo a la brasa" }));
    await user.click(screen.getByTestId("send-command"));
    await user.click(screen.getByRole("button", { name: "Confirmar envío" }));
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    expect(mocks.enqueue.mock.calls[0][0]).toMatchObject({
      operation_type: "CREATE_COMMAND", path: "/api/v1/orders/{orderRef}/commands", parent_operation_id: "queued-open",
      body: { shift_id: "shift-A" },
    });
  });

  it("una comanda encadenada hereda el turno de la primera aunque ya se conozca otro turno", async () => {
    usePendingOrders.setState({ records: [{ operation_id: "queued-open", table_id: "table-2", table_name: "Mesa 2",
      persons_count: 2, created_at: 1, server_order_id: null, error: null }] });
    useQueue.setState({ operations: [{ client_operation_id: "queued-open", owner_user_id: "w1", operation_type: "OPEN_TABLE_WITH_COMMAND",
      path: "/api/v1/orders/open-with-command", method: "POST", body: { table_id: "table-2", shift_id: "shift-ANTERIOR", items: [] },
      parent_operation_id: null, created_at: 1, attempt_count: 1, last_attempt_at: 1, status: "LOCAL_PENDING", last_error: null }],
    loaded: true, ownerId: "w1", snapshotAt: 0 });
    const user = userEvent.setup();
    app("/mesas/table-2");
    await user.click(screen.getAllByRole("button", { name: "Carta" })[0]); // pestaña de la carta
    await sendFirstCommand(user);
    await waitFor(() => expect(mocks.enqueue).toHaveBeenCalledTimes(1));
    expect(mocks.enqueue.mock.calls[0][0].body).toMatchObject({ shift_id: "shift-ANTERIOR" });
  });

  it("sin turno abierto conocido no se genera la primera comanda", async () => {
    mocks.shift = null;
    useTableDrafts.getState().open({ table_id: "table-2", table_name: "Mesa 2", persons_count: 2, created_at: Date.now() });
    const user = userEvent.setup();
    app("/mesas/table-2");
    await sendFirstCommand(user);
    expect(mocks.sendOrQueue).not.toHaveBeenCalled();
    expect(useUi.getState().toasts.map((toast) => toast.title)).toContain("No hay un turno abierto");
  });

  it("si otro mesero ya abrió la mesa: conflicto claro, el carrito y el borrador se conservan", async () => {
    useTableDrafts.getState().open({ table_id: "table-2", table_name: "Mesa 2", persons_count: 2, created_at: Date.now() });
    mocks.sendOrQueue.mockRejectedValue(new ApiError(409, "TABLE_ALREADY_OPEN", "La mesa ya tiene un pedido abierto."));
    const user = userEvent.setup();
    app("/mesas/table-2");
    await sendFirstCommand(user);
    await waitFor(() => expect(useUi.getState().toasts.map((toast) => toast.title)).toContain("Esta mesa ya fue abierta por otro mesero"));
    expect(useTableDrafts.getState().drafts["table-2"]).toBeDefined();
    expect(screen.getByTestId("send-command")).toBeInTheDocument();
    expect(screen.getAllByText(/1 unidad/).length).toBeGreaterThan(0);
    expect(usePendingOrders.getState().records).toHaveLength(0);
  });

  it("un fallo genérico del servidor también conserva mesa y carrito", async () => {
    useTableDrafts.getState().open({ table_id: "table-2", table_name: "Mesa 2", persons_count: 2, created_at: Date.now() });
    mocks.sendOrQueue.mockRejectedValue(new Error("boom"));
    const user = userEvent.setup();
    app("/mesas/table-2");
    await sendFirstCommand(user);
    await waitFor(() => expect(useUi.getState().toasts.map((toast) => toast.title)).toContain("No se pudo enviar la comanda"));
    expect(useTableDrafts.getState().drafts["table-2"]).toBeDefined();
    expect(screen.getByTestId("send-command")).toBeInTheDocument();
  });
});
