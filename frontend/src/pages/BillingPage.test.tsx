import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkError } from "../api/client";
import { useSession } from "../stores/session";
import { BillingPage } from "./BillingPage";

const mocks = vi.hoisted(() => ({ payment: vi.fn(), data: {} as Record<string, unknown> }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mocks.data }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../api/endpoints", () => ({ billingApi: { get: vi.fn(), createPayment: mocks.payment } }));

function page() {
  return render(<MemoryRouter initialEntries={["/cobro/order-1"]}>
    <Routes><Route path="/cobro/:orderId" element={<BillingPage />} /></Routes>
  </MemoryRouter>);
}

describe("verificación de pagos con respuesta perdida", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.payment.mockReset();
    useSession.setState({ user: null });
    mocks.data = { table_name: "Mesa 1", status: "DELIVERED", total: "25.00", paid_amount: "0.00",
      pending_amount: "25.00", items: [], splits: [], payments: [] };
  });

  it("conserva UUID y monto al recargar aunque el servidor ya muestre saldo cero", async () => {
    mocks.payment.mockRejectedValueOnce(new NetworkError())
      .mockResolvedValueOnce({ id: "payment-1", became_paid: true });
    const user = userEvent.setup();
    const initial = page();
    await user.click(screen.getByRole("button", { name: /^Cobrar/ }));
    const firstPayload = mocks.payment.mock.calls[0][1];
    expect(await screen.findByRole("button", { name: "Verificar pago pendiente" })).toBeVisible();
    initial.unmount();
    mocks.data = { ...mocks.data, paid_amount: "25.00", pending_amount: "0.00", status: "PAID" };
    page();
    await user.click(screen.getByRole("button", { name: "Verificar pago pendiente" }));
    expect(mocks.payment).toHaveBeenCalledTimes(2);
    expect(mocks.payment.mock.calls[1][1]).toEqual(firstPayload);
    expect(firstPayload.amount).toBe("25.00");
    expect(localStorage.getItem("restaurante.payment..order-1")).toBeNull();
  });
});
