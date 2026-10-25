import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePendingOrders } from "../../stores/pendingOrders";
import { useQueue } from "../../stores/queue";
import { useSession } from "../../stores/session";
import { useTableDrafts } from "../../stores/tableDrafts";
import { useUi } from "../../stores/ui";
import type { Order, QueuedOperation, RestaurantTable } from "../../types/api";
import { TableOrderPage } from "./TableOrderPage";
import { TablesPage } from "./TablesPage";

const mocks = vi.hoisted(() => ({
  tables: [] as unknown[],
  orders: [] as unknown[],
  menuSoldOut: false,
  tablesError: false,
  sendOrQueue: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryKey[0] === "tables" ? mocks.tables
      : queryKey[0] === "orders" ? mocks.orders
      : queryKey[0] === "shifts" ? { status: "OPEN", opened_at: "2026-10-22T21:00:00Z" }
      : queryKey[0] === "menu" ? {
        categories: [{ id: "c", name: "Fondos", sort_order: 1, is_active: true }],
        items: [{ id: "pollo", category_id: "c", name: "Pollo a la brasa", description: null, price: "25.00",
          requires_preparation: true, preparation_area: "KITCHEN", expected_prep_minutes: 20, is_available: !mocks.menuSoldOut,
          is_active: true, image_url: null, availability_status: mocks.menuSoldOut ? "SOLD_OUT" : "AVAILABLE", preparation_steps: [] }],
      } : null,
    isLoading: false,
    isFetching: false,
    dataUpdatedAt: Date.now(),
    // Sin conexión React Query conserva los datos anteriores aunque la consulta falle.
    isError: queryKey[0] === "tables" && mocks.tablesError,
  }),
  useQueryClient: () => ({ invalidateQueries: vi.fn(), setQueryData: vi.fn() }),
}));
vi.mock("../../api/endpoints", () => ({
  ordersApi: { openWithCommand: vi.fn(), active: vi.fn(), setItemStatus: vi.fn(), cancelItem: vi.fn(), cancelEmpty: vi.fn(), createCommand: vi.fn() },
  menuApi: { get: vi.fn() },
  tablesApi: { list: vi.fn() },
  shiftsApi: { current: vi.fn() },
}));
vi.mock("../../lib/send", () => ({ errorMessage: () => "error", sendOrQueue: mocks.sendOrQueue }));

function table(overrides: Partial<RestaurantTable>): RestaurantTable {
  return { id: "t1", name: "Mesa 1", number: 1, is_active: true, status: "FREE", order_id: null, ...overrides } as RestaurantTable;
}

function queued(overrides: Partial<QueuedOperation>): QueuedOperation {
  return {
    client_operation_id: "open-1", owner_user_id: "w1", operation_type: "OPEN_TABLE_WITH_COMMAND",
    path: "/api/v1/orders/open-with-command", method: "POST",
    body: { table_id: "t1", persons_count: 2, items: [{ menu_item_id: "pollo", quantity: 2, notes: "sin sal" }] },
    parent_operation_id: null, created_at: 1, attempt_count: 1, last_attempt_at: 1, status: "LOCAL_PENDING", last_error: null,
    ...overrides,
  };
}

function order(overrides: Partial<Order>): Order {
  return {
    id: "order-1", table_id: "t1", table_name: "Mesa 1", table_number: 1, order_type: "DINE_IN", persons_count: 2,
    status: "OPEN", total: "25.00", paid_amount: "0.00", opened_at: new Date().toISOString(),
    commands: [{ id: "c1", sequence_number: 1, items: [{ id: "i1" }] }],
    items: [{ id: "i1", command_id: "c1", menu_item_name_snapshot: "Pollo a la brasa", unit_price_snapshot: "25.00", quantity: 1,
      status: "PENDING", requires_preparation: true, tasks: [], created_at: new Date().toISOString(), notes: null }],
    ...overrides,
  } as unknown as Order;
}

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

const pendingRecord = {
  operation_id: "open-1", table_id: "t1", table_name: "Mesa 1", persons_count: 2, created_at: 1, server_order_id: null, error: null,
};

// El cambio de usuario relee la cola de IndexedDB en segundo plano: se espera antes de preparar el estado.
async function settleSession() {
  useSession.setState({ user: { id: "w1", username: "ana", display_name: "Ana", role: "WAITER", is_active: true, created_at: "" } });
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("mesas con comandas guardadas en el dispositivo", () => {
  beforeEach(async () => {
    await settleSession();
    sessionStorage.clear();
    localStorage.clear();
    mocks.tables = [table({})];
    mocks.orders = [];
    mocks.menuSoldOut = false;
    mocks.tablesError = false;
    mocks.sendOrQueue.mockReset();
    useSession.setState({ user: { id: "w1", username: "ana", display_name: "Ana", role: "WAITER", is_active: true, created_at: "" } });
    useTableDrafts.setState({ drafts: {} });
    usePendingOrders.setState({ records: [] });
    useQueue.setState({ operations: [], loaded: false, snapshotAt: 0 });
    useUi.setState({ toasts: [] });
  });

  it("se puede volver a una mesa con comanda pendiente y ver lo que falta enviar", async () => {
    usePendingOrders.setState({ records: [pendingRecord] });
    useQueue.setState({ operations: [queued({})], loaded: true, snapshotAt: 0 });
    const user = userEvent.setup();
    app("/mesas");

    const tile = screen.getByRole("button", { name: /Mesa 1, libre, sincronización pendiente/ });
    expect(tile).toBeEnabled();
    expect(within(tile).getByText("Sin enviar")).toBeVisible();
    await user.click(tile);

    expect(screen.getByRole("heading", { name: "Mesa 1" })).toBeVisible();
    expect(screen.getByText(/aún no llegó al servidor/)).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Pedido" }));
    const line = screen.getByTestId("local-command-line");
    expect(line).toHaveTextContent("×2");
    expect(line).toHaveTextContent("Pollo a la brasa");
    expect(line).toHaveTextContent("Pendiente de sincronización");
    // No se ofrece abrir la mesa otra vez: no hay diálogo de personas ni pedido duplicado.
    expect(screen.queryByRole("button", { name: "Abrir mesa" })).toBeNull();
  });

  it("una primera comanda rechazada se distingue y permite reintentar o descartar", async () => {
    usePendingOrders.setState({ records: [{ ...pendingRecord, error: "ITEM_SOLD_OUT: agotado" }] });
    useQueue.setState({ operations: [queued({ status: "SYNC_ERROR", last_error: "ITEM_SOLD_OUT: agotado" })], loaded: true, snapshotAt: 0 });
    const user = userEvent.setup();
    app("/mesas");
    const tile = screen.getByRole("button", { name: /error de sincronización/ });
    expect(within(tile).getByText("No enviada")).toBeVisible();
    await user.click(tile);
    expect(screen.getByTestId("local-order-error")).toHaveTextContent("ITEM_SOLD_OUT: agotado");
    expect(screen.getByRole("button", { name: "Reintentar" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Descartar" })).toBeVisible();
    expect(screen.getByTestId("local-command-line")).toHaveTextContent("No enviada al servidor");
  });

  it("sin conexión el salón sigue visible con la última copia conocida", () => {
    mocks.tablesError = true;
    app("/mesas");
    expect(screen.getByRole("button", { name: /Mesa 1, libre/ })).toBeVisible();
    expect(screen.queryByText("No se pudo cargar el salón")).toBeNull();
  });

  it("una mesa desactivada con pedido vivo sigue accesible", () => {
    mocks.tables = [table({ is_active: false, status: "OPEN", order_id: "order-1" })];
    mocks.orders = [order({})];
    app("/mesas");
    expect(screen.getByRole("button", { name: /Mesa 1, ocupada/ })).toBeEnabled();
  });

  it("una mesa desactivada y libre no se puede abrir", () => {
    mocks.tables = [table({ is_active: false })];
    app("/mesas");
    expect(screen.getByRole("button", { name: /Mesa 1, inactiva/ })).toBeDisabled();
  });

  it("la mesa de otro mesero no se presenta como libre ni editable", () => {
    mocks.tables = [table({ status: "OPEN", order_id: "ajeno" })];
    app("/mesas/t1");
    expect(screen.getByText("Otro mesero atiende esta mesa")).toBeVisible();
  });
});

describe("pedido pagado y operaciones pendientes", () => {
  beforeEach(async () => {
    await settleSession();
    mocks.tables = [table({ status: "OPEN", order_id: "order-1" })];
    mocks.menuSoldOut = false;
    mocks.sendOrQueue.mockReset();
    useSession.setState({ user: { id: "w1", username: "ana", display_name: "Ana", role: "WAITER", is_active: true, created_at: "" } });
    usePendingOrders.setState({ records: [] });
    useQueue.setState({ operations: [], loaded: true, snapshotAt: 0 });
    useUi.setState({ toasts: [] });
  });

  it("un pedido pagado permite entregar pero no ofrece nuevas comandas ni cancelaciones", async () => {
    mocks.orders = [order({ status: "PAID", paid_amount: "31.00", total: "31.00", items: [
      { id: "i1", command_id: "c1", menu_item_name_snapshot: "Pollo a la brasa", unit_price_snapshot: "25.00", quantity: 1,
        status: "READY", requires_preparation: true, tasks: [], created_at: new Date().toISOString(), notes: null },
      { id: "i2", command_id: "c1", menu_item_name_snapshot: "Inca Kola", unit_price_snapshot: "6.00", quantity: 1,
        status: "PENDING", requires_preparation: false, tasks: [], created_at: new Date().toISOString(), notes: null },
    ] as unknown as Order["items"] })];
    app("/mesas/t1");
    expect(screen.getByTestId("paid-order-notice")).toBeVisible();
    expect(screen.getAllByRole("button", { name: /Entregado/ })).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull();
    expect(screen.queryByRole("button", { name: /Agregar/ })).toBeNull();
    expect(screen.getByRole("button", { name: /Ver pago/ })).toBeVisible();
  });

  it("una cancelación en cola se muestra pendiente y no se anuncia como hecha", async () => {
    mocks.orders = [order({})];
    mocks.sendOrQueue.mockResolvedValue({ queued: true, operationId: "cancel-1" });
    const user = userEvent.setup();
    app("/mesas/t1");
    await user.click(screen.getByRole("button", { name: "Pedido" }));
    await user.click(screen.getByRole("button", { name: "Cancelar" }));
    await user.click(screen.getByRole("button", { name: "Cancelar producto" }));
    await waitFor(() => expect(mocks.sendOrQueue).toHaveBeenCalledTimes(1));
    expect(useUi.getState().toasts.map((toast) => toast.title)).not.toContain("Producto cancelado");

    useQueue.setState({ operations: [queued({
      client_operation_id: "cancel-1", operation_type: "CANCEL_ORDER_ITEM", path: "/api/v1/orders/order-1/items/i1/cancel", body: {},
    })] });
    expect(await screen.findByTestId("local-item-state")).toHaveTextContent("Cancelación pendiente de envío");
    expect(screen.queryByRole("button", { name: "Cancelar" })).toBeNull();
  });

  it("un aviso local atrasado no contradice el estado confirmado por el servidor", () => {
    mocks.orders = [order({ items: [
      { id: "i1", command_id: "c1", menu_item_name_snapshot: "Pollo a la brasa", unit_price_snapshot: "25.00", quantity: 1,
        status: "CANCELLED", requires_preparation: true, tasks: [], created_at: new Date().toISOString(), notes: null },
    ] as unknown as Order["items"] })];
    useQueue.setState({ operations: [queued({
      client_operation_id: "cancel-1", operation_type: "CANCEL_ORDER_ITEM", path: "/api/v1/orders/order-1/items/i1/cancel", body: {},
    })] });
    app("/mesas/t1");
    expect(screen.queryByTestId("local-item-state")).toBeNull();
  });

  it("un producto que se agota mientras se arma la comanda bloquea el envío", async () => {
    mocks.orders = [order({})];
    const user = userEvent.setup();
    const view = app("/mesas/t1");
    await user.click(within(document.querySelector(".order-tabs") as HTMLElement).getByRole("button", { name: "Carta" }));
    await user.click(screen.getByRole("button", { name: "Agregar Pollo a la brasa" }));
    mocks.menuSoldOut = true;
    view.rerender(
      <MemoryRouter initialEntries={["/mesas/t1"]}>
        <Routes><Route path="/mesas/:tableId" element={<TableOrderPage />} /></Routes>
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: /Ver comanda/ }));
    expect(screen.getByText("Ya no disponible")).toBeVisible();
    expect(screen.getByTestId("send-command")).toBeDisabled();
  });
});
