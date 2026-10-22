import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePendingOrders } from "../../stores/pendingOrders";
import { useSession } from "../../stores/session";
import { TablesPage } from "./TablesPage";

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: queryKey[0] === "tables" ? [
      { id: "table-1", name: "Mesa 1", number: 1, is_active: true, status: "OPEN", order_id: "order-1" },
      { id: "table-2", name: "Mesa 2", number: 2, is_active: true, status: "FREE", order_id: null },
    ] : queryKey[0] === "orders" ? [] : null,
    isLoading: false,
    isError: false,
  }),
}));

vi.mock("../../api/endpoints", () => ({
  ordersApi: { create: vi.fn() },
  tablesApi: { list: vi.fn() },
  shiftsApi: { current: vi.fn() },
}));

vi.mock("../../lib/send", () => ({
  errorMessage: () => "error",
  sendOrQueue: vi.fn(),
}));

describe("TablesPage", () => {
  beforeEach(() => {
    usePendingOrders.setState({ records: [] });
    useSession.setState({
      user: { id: "waiter", username: "ana", display_name: "Ana Mesero", role: "WAITER", is_active: true, created_at: "" },
    });
  });

  it("filtra las mesas con datos ya cargados sin crear solicitudes adicionales", async () => {
    const user = userEvent.setup();
    render(<MemoryRouter><TablesPage /></MemoryRouter>);

    expect(screen.getAllByText("Ocupadas").length).toBeGreaterThan(0);
    await user.type(screen.getByLabelText("Buscar mesa"), "2");
    expect(screen.getByRole("button", { name: "Mesa 2, libre" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mesa 1, ocupada" })).not.toBeInTheDocument();

    await user.clear(screen.getByLabelText("Buscar mesa"));
    const filterRow = document.querySelector(".table-filter-row")!;
    await user.click(within(filterRow as HTMLElement).getByRole("button", { name: /Ocupadas/ }));
    expect(screen.getByRole("button", { name: "Mesa 1, ocupada" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Mesa 2, libre" })).not.toBeInTheDocument();
  });
});
