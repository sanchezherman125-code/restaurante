import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NetworkError } from "../api/client";
import { useSession } from "../stores/session";
import { BillingPage } from "./BillingPage";

const mocks = vi.hoisted(() => ({
  payment: vi.fn(), data: {} as Record<string, unknown> | undefined, createSplit: vi.fn(), query: {} as Record<string, unknown>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mocks.data, refetch: vi.fn(), ...mocks.query }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("../api/endpoints", () => ({ billingApi: { get: vi.fn(), createPayment: mocks.payment, createSplit: mocks.createSplit } }));

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

describe("cobro simplificado sin división de cuentas", () => {
  const items = [
    { order_item_id: "i1", name: "Alitas con papas", quantity: 2, unit_price: "25.00", total: "50.00", status: "DELIVERED" },
    { order_item_id: "i2", name: "Inca Kola", quantity: 1, unit_price: "6.00", total: "6.00", status: "DELIVERED" },
  ];

  beforeEach(() => {
    localStorage.clear();
    mocks.payment.mockReset();
    useSession.setState({ user: null });
    mocks.data = { table_name: "Mesa 4", status: "DELIVERED", total: "56.00", paid_amount: "0.00",
      pending_amount: "56.00", items, legacy_splits: [], payments: [] };
  });

  it("muestra consumo, total, pagado y pendiente, y ninguna opción de dividir", () => {
    page();
    expect(screen.getByText("Alitas con papas")).toBeVisible();
    expect(screen.getByText("×2")).toBeVisible();
    expect(screen.getAllByText("S/ 56.00").length).toBeGreaterThan(0);
    expect(screen.queryByText(/dividir/i)).toBeNull();
    expect(screen.queryByText(/por monto|por productos/i)).toBeNull();
    expect(screen.queryByLabelText(/etiqueta/i)).toBeNull();
    expect(screen.queryByText(/divisi/i)).toBeNull();
  });

  it.each([["Yape", "YAPE"], ["Plin", "PLIN"], ["Tarjeta", "CARD"], ["Efectivo", "CASH"], ["Otro", "OTHER"]])(
    "cobra el saldo completo con %s", async (label, method) => {
      mocks.payment.mockResolvedValue({ id: "p1", became_paid: true });
      const user = userEvent.setup();
      page();
      await user.click(screen.getByRole("button", { name: label }));
      await user.click(screen.getByRole("button", { name: "Cobrar S/ 56.00" }));
      expect(mocks.payment).toHaveBeenCalledTimes(1);
      expect(mocks.payment.mock.calls[0][1]).toMatchObject({ method, amount: "56.00" });
      expect(mocks.payment.mock.calls[0][1]).not.toHaveProperty("split_id");
      expect(mocks.createSplit).not.toHaveBeenCalled();
    },
  );

  it("no ofrece pago parcial ni campo de monto: el flujo cobra siempre el saldo completo", () => {
    page();
    expect(screen.queryByText(/parcial/i)).toBeNull();
    expect(screen.queryByLabelText(/monto/i)).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.getAllByRole("button", { name: /^Cobrar/ })).toHaveLength(1);
  });

  it("tras pagos parciales históricos cobra exactamente el saldo pendiente restante", async () => {
    mocks.payment.mockResolvedValue({ id: "p2", became_paid: true });
    mocks.data = { ...mocks.data, paid_amount: "30.00", pending_amount: "26.00", payments: [
      { id: "a", order_id: "o", split_id: null, method: "CASH", amount: "30.00", paid_at: "2026-10-01T12:00:00Z" },
    ] };
    const user = userEvent.setup();
    page();
    await user.click(screen.getByRole("button", { name: "Cobrar S/ 26.00" }));
    expect(mocks.payment.mock.calls[0][1]).toMatchObject({ method: "CASH", amount: "26.00" });
    expect(mocks.payment.mock.calls[0][1].client_operation_id).toMatch(/^[0-9a-f-]{36}$/i);
  });

  it("lista el historial de pagos con su método, incluido un pago de una división antigua", () => {
    mocks.data = { ...mocks.data, paid_amount: "30.00", pending_amount: "26.00", payments: [
      { id: "a", order_id: "o", split_id: "old", method: "YAPE", amount: "10.00", paid_at: "2026-10-01T12:00:00Z" },
      { id: "b", order_id: "o", split_id: null, method: "CASH", amount: "20.00", paid_at: "2026-10-01T12:05:00Z" },
    ] };
    page();
    expect(screen.getByText("Pagos realizados")).toBeVisible();
    const history = screen.getByText("Pagos realizados").closest(".card") as HTMLElement;
    expect(within(history).getByText("Yape")).toBeVisible();
    expect(within(history).getByText("Efectivo")).toBeVisible();
    expect(screen.getByText(/de una división anterior/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Cobrar S/ 26.00" })).toBeVisible();
  });

  it("con saldo cero muestra el pedido pagado y no ofrece cobrar", () => {
    mocks.data = { ...mocks.data, status: "PAID", paid_amount: "56.00", pending_amount: "0.00" };
    page();
    expect(screen.getByText("Pedido pagado")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Cobrar/ })).toBeNull();
  });

  it("un pedido totalmente cancelado no se presenta como pagado ni ofrece cobrar", () => {
    mocks.data = { ...mocks.data, status: "CANCELLED", total: "0.00", paid_amount: "0.00", pending_amount: "0.00", items: [] };
    page();
    expect(screen.getByText("Pedido cancelado")).toBeVisible();
    expect(screen.queryByText("Pedido pagado")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Cobrar/ })).toBeNull();
  });
});

describe("cuenta sin respuesta del servidor", () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.payment.mockReset();
    useSession.setState({ user: null });
    mocks.data = { table_name: "Mesa 3", status: "DELIVERED", total: "40.00", paid_amount: "0.00",
      pending_amount: "40.00", items: [{ order_item_id: "i1", name: "Lomo saltado", quantity: 1, unit_price: "40.00", total: "40.00", status: "DELIVERED" }],
      payments: [] };
    mocks.query = {};
  });

  it("si la actualización falla conserva la cuenta visible, avisa y bloquea el cobro", async () => {
    mocks.query = { isError: true, dataUpdatedAt: new Date(2026, 9, 27, 20, 40).getTime() };
    const user = userEvent.setup();
    page();
    expect(screen.getByText("Lomo saltado")).toBeVisible();
    expect(screen.getByTestId("stale-notice")).toHaveTextContent(/no se pueden registrar cobros nuevos.*08:40/);
    const charge = screen.getByRole("button", { name: "Cobro bloqueado sin conexión" });
    expect(charge).toBeDisabled();
    await user.click(charge);
    expect(mocks.payment).not.toHaveBeenCalled();
  });

  it("sin conexión (consulta en pausa) también bloquea el cobro", () => {
    mocks.query = { isPaused: true, dataUpdatedAt: Date.now() };
    page();
    expect(screen.getByText("Lomo saltado")).toBeVisible();
    expect(screen.getByRole("button", { name: "Cobro bloqueado sin conexión" })).toBeDisabled();
  });

  it("sin cuenta guardada explica que no se pudo cargar", () => {
    mocks.data = undefined;
    mocks.query = { isError: true };
    page();
    expect(screen.getByText("No se pudo cargar la cuenta")).toBeVisible();
    expect(screen.queryByRole("button", { name: /^Cobrar/ })).toBeNull();
  });

  it("al volver la conexión el cobro se habilita", () => {
    page();
    expect(screen.queryByTestId("stale-notice")).toBeNull();
    expect(screen.getByRole("button", { name: "Cobrar S/ 40.00" })).toBeEnabled();
  });
});
