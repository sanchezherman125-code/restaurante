import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { usePendingOrders } from "../../stores/pendingOrders";
import { TableOrderPage } from "./TableOrderPage";

const mocks = vi.hoisted(() => ({
  sendOrQueue: vi.fn(),
  invalidateQueries: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: ({ queryKey }: { queryKey: string[] }) => {
    if (queryKey[0] === "menu") {
      return {
        data: {
          categories: [{ id: "starters", name: "Piqueos", sort_order: 1, is_active: true }],
          items: [{
            id: "causa",
            category_id: "starters",
            name: "Causa limeña",
            description: "Pollo y palta",
            price: "18.00",
            requires_preparation: true,
            preparation_area: "KITCHEN",
            is_available: true,
            is_active: true,
            image_url: null,
            availability_status: "AVAILABLE",
          }],
        },
        isLoading: false,
        isError: false,
      };
    }
    return {
      data: [{
        id: "order-1",
        table_id: "table-1",
        table_name: "Mesa 1",
        table_number: 1,
        order_type: "DINE_IN",
        persons_count: 2,
        status: "OPEN",
        items: [],
        commands: [],
        total: "0.00",
      }],
      isLoading: false,
      isError: false,
    };
  },
  useQueryClient: () => ({ invalidateQueries: mocks.invalidateQueries }),
}));

vi.mock("../../api/endpoints", () => ({
  menuApi: { get: vi.fn() },
  ordersApi: { active: vi.fn(), createCommand: vi.fn(), setItemStatus: vi.fn(), cancelItem: vi.fn() },
}));

vi.mock("../../lib/send", () => ({
  errorMessage: (error: unknown) => (error instanceof Error ? error.message : "error"),
  sendOrQueue: mocks.sendOrQueue,
}));

describe("TableOrderPage", () => {
  beforeEach(() => {
    mocks.sendOrQueue.mockReset();
    mocks.invalidateQueries.mockReset();
    usePendingOrders.setState({ records: [] });
  });

  it("mantiene el carrito hasta que el mesero confirma el envío y muestra el subtotal", async () => {
    const user = userEvent.setup();
    mocks.sendOrQueue.mockResolvedValue({ queued: true, operationId: "queued-command" });

    render(
      <MemoryRouter initialEntries={["/mesas/table-1"]}>
        <Routes><Route path="/mesas/:tableId" element={<TableOrderPage />} /></Routes>
      </MemoryRouter>,
    );

    await user.click(screen.getByRole("button", { name: "Agregar Causa limeña" }));
    expect(screen.getByRole("button", { name: /Ver comanda.*1 unidad/ })).toHaveTextContent("S/ 18.00");

    await user.click(screen.getByRole("button", { name: /Ver comanda.*1 unidad/ }));
    expect(screen.getByRole("heading", { name: "Nueva comanda" })).toBeInTheDocument();
    expect(screen.getByText("Subtotal")).toBeInTheDocument();
    expect(screen.getAllByText("S/ 18.00").length).toBeGreaterThan(0);

    await user.click(screen.getByTestId("send-command"));
    expect(screen.getByRole("dialog")).toHaveTextContent("1× Causa limeña");
    expect(screen.getByRole("dialog")).toHaveTextContent("S/ 18.00");
    expect(mocks.sendOrQueue).not.toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Confirmar envío" }));
    await waitFor(() => expect(mocks.sendOrQueue).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Ver comanda/ })).not.toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Carta" })).toBeInTheDocument();
  });
});
