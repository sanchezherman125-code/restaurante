import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardPage } from "./DashboardPage";

const mocks = vi.hoisted(() => ({ data: {} as Record<string, unknown>, query: {} as Record<string, Record<string, unknown>> }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    const key = queryKey.join("/");
    return { data: mocks.data[key], isLoading: false, refetch: vi.fn(), dataUpdatedAt: 0, ...mocks.query[key] };
  },
}));
vi.mock("../../api/endpoints", () => ({
  ordersApi: { active: vi.fn() }, preparationApi: { kitchen: vi.fn(), grill: vi.fn() },
  reportsApi: { currentShift: vi.fn() }, shiftsApi: { current: vi.fn() }, tablesApi: { list: vi.fn() },
}));

const KEYS = ["shifts/current", "reports/current-shift", "orders/active", "tables", "preparation/kitchen", "preparation/grill"];
const sales = {
  total_sales: "120.00", total_expenses: "20.00", net_result: "100.00", orders_count: 3, tables_served: 3,
  persons_served: 8, sales_by_payment_method: { CASH: "120.00" }, sales_by_waiter: { Ana: "120.00" },
};

function page() {
  return render(<MemoryRouter><DashboardPage /></MemoryRouter>);
}

describe("panel sin respuesta del servidor", () => {
  beforeEach(() => {
    mocks.data = {};
    mocks.query = {};
  });

  it("si todas las consultas fallan sin copia local, ninguna cifra aparece como cero confirmado", () => {
    for (const key of KEYS) mocks.query[key] = { isError: true };
    page();
    expect(screen.queryByText("S/ 0.00")).toBeNull();
    expect(screen.queryByText("0 pedidos")).toBeNull();
    expect(screen.queryByText("0/0")).toBeNull();
    expect(screen.queryByText("Sin turno abierto")).toBeNull();
    expect(screen.getByText("Turno sin confirmar")).toBeVisible();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(8);
    expect(screen.getByTestId("stale-notice")).toHaveTextContent("no están disponibles");
  });

  it("con copia de las ventas pero sin pedidos, muestra la copia con su hora y marca lo que falta", () => {
    mocks.data["reports/current-shift"] = sales;
    mocks.data["shifts/current"] = { status: "OPEN", opened_at: new Date(2026, 9, 27, 18, 0).toISOString() };
    mocks.query["reports/current-shift"] = { isError: true, dataUpdatedAt: new Date(2026, 9, 27, 22, 30).getTime() };
    mocks.query["orders/active"] = { isPaused: true };
    page();
    expect(screen.getAllByText("S/ 120.00").length).toBeGreaterThan(0);
    expect(screen.getByTestId("stale-notice")).toHaveTextContent(/marcadas «—» no están disponibles.*10:30/);
  });

  it("con todo confirmado muestra las cifras sin avisos", () => {
    mocks.data = {
      "shifts/current": { status: "OPEN", opened_at: new Date().toISOString() }, "reports/current-shift": sales,
      "orders/active": [], tables: [], "preparation/kitchen": [], "preparation/grill": [],
    };
    page();
    expect(screen.queryByTestId("stale-notice")).toBeNull();
    expect(screen.queryByText("—")).toBeNull();
  });
});
