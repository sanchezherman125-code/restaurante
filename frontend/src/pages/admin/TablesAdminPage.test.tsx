import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../api/client";
import { useUi } from "../../stores/ui";
import { TablesAdminPage } from "./TablesAdminPage";

const mocks = vi.hoisted(() => ({ tables: [] as unknown[], update: vi.fn(), invalidate: vi.fn() }));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mocks.tables, isLoading: false, isError: false }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
}));
vi.mock("../../api/endpoints", () => ({ tablesApi: { list: vi.fn(), update: mocks.update, create: vi.fn() } }));

describe("desactivar mesas", () => {
  beforeEach(() => {
    mocks.update.mockReset();
    mocks.invalidate.mockReset();
    useUi.setState({ toasts: [] });
  });

  it("una mesa ocupada no ofrece desactivarse", async () => {
    mocks.tables = [{ id: "t1", name: "Mesa 1", number: 1, is_active: true, status: "OPEN", order_id: "o1" }];
    const user = userEvent.setup();
    render(<TablesAdminPage />);
    await user.click(screen.getByRole("button", { name: /Editar Mesa 1, ocupada/ }));
    expect(screen.getByRole("button", { name: "Inactiva" })).toBeDisabled();
    expect(screen.getByText(/Tiene un pedido activo/)).toBeVisible();
  });

  it("si el servidor la rechaza por ocupada (otro dispositivo), lo explica y refresca", async () => {
    mocks.tables = [{ id: "t2", name: "Mesa 2", number: 2, is_active: true, status: "FREE", order_id: null }];
    mocks.update.mockRejectedValue(new ApiError(409, "TABLE_OCCUPIED", "Mesa 2 tiene un pedido activo."));
    const user = userEvent.setup();
    render(<TablesAdminPage />);
    await user.click(screen.getByRole("button", { name: /Editar Mesa 2, libre/ }));
    await user.click(screen.getByRole("button", { name: "Inactiva" }));
    await user.click(screen.getAllByRole("button", { name: "Guardar" })[0]);
    expect(useUi.getState().toasts.at(-1)).toMatchObject({ title: "No se puede desactivar la mesa" });
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["tables"] });
    expect(screen.getByRole("button", { name: "Inactiva" })).toBeDisabled();
  });

  it("una mesa inactiva con pedido vivo figura como ocupada", () => {
    mocks.tables = [{ id: "t3", name: "Mesa 3", number: 3, is_active: false, status: "OPEN", order_id: "o3" }];
    render(<TablesAdminPage />);
    expect(screen.getByRole("button", { name: /Editar Mesa 3, ocupada/ })).toHaveTextContent("Ocupada · inactiva");
  });
});
