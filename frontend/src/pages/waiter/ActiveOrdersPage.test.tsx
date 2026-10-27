import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePendingOrders } from "../../stores/pendingOrders";
import type { Order } from "../../types/api";
import { ActiveOrdersPage } from "./ActiveOrdersPage";

const mocks = vi.hoisted(() => ({ orders: undefined as Order[] | undefined, query: {} as Record<string, unknown> }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mocks.orders, isLoading: false, refetch: vi.fn(), ...mocks.query }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../../api/endpoints", () => ({ ordersApi: { active: vi.fn(), cancelEmpty: vi.fn() } }));

const order = {
  id: "o1", table_id: "t1", table_name: "Mesa 7", order_type: "DINE_IN", persons_count: 2, status: "OPEN",
  total: "30.00", paid_amount: "0.00", opened_at: new Date().toISOString(),
  items: [{ id: "i1", status: "PREPARING" }],
} as unknown as Order;

function page() {
  return render(<MemoryRouter><ActiveOrdersPage /></MemoryRouter>);
}

describe("pedidos activos sin respuesta del servidor", () => {
  beforeEach(() => {
    mocks.orders = undefined;
    mocks.query = {};
    usePendingOrders.setState({ records: [] });
  });

  it("una consulta fallida sin copia local nunca se muestra como «no hay pedidos activos»", () => {
    mocks.query = { isError: true };
    page();
    expect(screen.queryByText("No hay pedidos activos")).toBeNull();
    expect(screen.queryByText("0 abiertos")).toBeNull();
    expect(screen.getByText("No se pudieron cargar los pedidos")).toBeVisible();
    expect(screen.getByText("Sin datos del servidor")).toBeVisible();
  });

  it("sin conexión sigue mostrando las mesas guardadas solo en este dispositivo", () => {
    mocks.query = { isPaused: true };
    usePendingOrders.setState({ records: [{ operation_id: "op1", table_id: "t2", table_name: "Mesa 2", persons_count: 3,
      created_at: 1, server_order_id: null, error: null }] });
    page();
    expect(screen.getByText("Mesa 2")).toBeVisible();
    expect(screen.getByText("No se pudieron cargar los pedidos")).toBeVisible();
  });

  it("con copia local la muestra marcada como no actualizada", () => {
    mocks.orders = [order];
    mocks.query = { isError: true, dataUpdatedAt: new Date(2026, 9, 27, 21, 15).getTime() };
    page();
    expect(screen.getByText("Mesa 7")).toBeVisible();
    expect(screen.getByTestId("stale-notice")).toHaveTextContent(/los pedidos pueden no estar al día.*09:15/);
  });

  it("con la lista confirmada y vacía sí dice que no hay pedidos", () => {
    mocks.orders = [];
    page();
    expect(screen.getByText("No hay pedidos activos")).toBeVisible();
    expect(screen.queryByTestId("stale-notice")).toBeNull();
  });
});
