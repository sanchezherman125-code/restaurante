import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { billingApi } from "../api/endpoints";
import { EmptyState, Spinner } from "../components/Layout";
import { money } from "../hooks/useElapsed";
import { ApiError, NetworkError } from "../api/client";
import { errorMessage } from "../lib/send";
import { useUi } from "../stores/ui";
import type { PaymentMethod, SplitType } from "../types/api";

const METHODS: { value: PaymentMethod; label: string }[] = [
  { value: "CASH", label: "Efectivo" },
  { value: "YAPE", label: "Yape" },
  { value: "PLIN", label: "Plin" },
  { value: "CARD", label: "Tarjeta" },
  { value: "OTHER", label: "Otro" },
];

export function BillingPage() {
  const { orderId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useUi((state) => state.toast);

  const billing = useQuery({
    queryKey: ["billing", orderId],
    queryFn: () => billingApi.get(orderId),
    enabled: !!orderId,
    retry: false,
  });

  const [splitType, setSplitType] = useState<SplitType>("BY_AMOUNT");
  const [splitAmount, setSplitAmount] = useState("");
  const [splitLabel, setSplitLabel] = useState("");
  const [itemQuantities, setItemQuantities] = useState<Record<string, number>>({});
  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [payAmount, setPayAmount] = useState("");
  const [busy, setBusy] = useState(false);

  const data = billing.data;
  const pending = useMemo(() => (data ? Number(data.total) - Number(data.paid_amount) : 0), [data]);

  async function createSplit() {
    if (!data) return;
    setBusy(true);
    try {
      if (splitType === "BY_AMOUNT") {
        const amount = Number(splitAmount);
        if (!Number.isFinite(amount) || amount <= 0) {
          toast("error", "Ingrese un monto válido");
          return;
        }
        await billingApi.createSplit(orderId, {
          split_type: "BY_AMOUNT",
          amount: amount.toFixed(2),
          label: splitLabel.trim() || null,
        });
      } else {
        const items = Object.entries(itemQuantities)
          .filter(([, qty]) => qty > 0)
          .map(([id, qty]) => ({ order_item_id: id, quantity: qty }));
        if (items.length === 0) {
          toast("error", "Seleccione al menos un producto");
          return;
        }
        await billingApi.createSplit(orderId, {
          split_type: "BY_ITEMS",
          label: splitLabel.trim() || null,
          items,
        });
      }
      toast("success", "División registrada");
      setSplitAmount("");
      setSplitLabel("");
      setItemQuantities({});
      void queryClient.invalidateQueries({ queryKey: ["billing", orderId] });
    } catch (error) {
      toast("error", "No se pudo dividir la cuenta", errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function registerPayment() {
    if (!data) return;
    setBusy(true);
    try {
      const amount = Number(payAmount || pending.toFixed(2));
      if (!Number.isFinite(amount) || amount <= 0) {
        toast("error", "Ingrese un monto válido");
        return;
      }
      const result = await billingApi.createPayment(orderId, {
        method,
        amount: amount.toFixed(2),
        client_operation_id: crypto.randomUUID(),
      });
      toast("success", "Pago registrado", result.became_paid ? "Pedido pagado en su totalidad" : undefined);
      setPayAmount("");
      void queryClient.invalidateQueries({ queryKey: ["billing", orderId] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: ["tables"] });
    } catch (error) {
      if (error instanceof NetworkError) {
        toast("error", "Sin conexión", "Los pagos requieren conexión al servidor. Intente de nuevo.");
      } else if (error instanceof ApiError) {
        toast("error", "Pago rechazado", error.message);
      } else {
        toast("error", "No se pudo registrar el pago", errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }

  if (billing.isLoading) return <Spinner label="Cargando cuenta…" />;
  if (billing.isError || !data) {
    return (
      <div className="stack">
        <EmptyState icon="📡" title="No se pudo cargar la cuenta" />
        <button className="btn secondary" onClick={() => navigate(-1)}>
          ← Volver
        </button>
      </div>
    );
  }

  return (
    <div className="stack">
      <div className="card">
        <div className="row wrap">
          <div className="grow">
            <h2>{data.table_name ?? "Pedido"}</h2>
            <span className="chip info">{data.status}</span>
          </div>
          <button className="btn ghost small" onClick={() => navigate(-1)}>
            ← Volver
          </button>
        </div>
        <div className="grid-2" style={{ marginTop: 12 }}>
          <div className="kpi">
            <div className="label">Total</div>
            <div className="value">{money(data.total)}</div>
          </div>
          <div className="kpi">
            <div className="label">Pendiente</div>
            <div className="value" style={{ color: pending > 0 ? "var(--warning)" : "var(--success)" }}>
              {money(pending)}
            </div>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          <h2>Detalle</h2>
        </div>
        <table className="data">
          <thead>
            <tr>
              <th>Producto</th>
              <th>Cant.</th>
              <th>Importe</th>
            </tr>
          </thead>
          <tbody>
            {data.items.map((item) => (
              <tr key={item.order_item_id}>
                <td>
                  {item.name}
                  {item.split_quantity > 0 ? <span className="chip info" style={{ marginLeft: 6 }}>div. {item.split_quantity}</span> : null}
                </td>
                <td>{item.quantity}</td>
                <td>{money(item.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="row" style={{ marginTop: 10 }}>
          <span className="grow hint">Pagado</span>
          <strong style={{ color: "var(--success)" }}>{money(data.paid_amount)}</strong>
        </div>
      </div>

      {pending > 0.001 ? (
        <>
          <div className="card">
            <div className="section-title" style={{ marginTop: 0 }}>
              <h2>Dividir cuenta</h2>
            </div>
            <div className="segmented" style={{ marginBottom: 12 }}>
              <button className={splitType === "BY_AMOUNT" ? "active" : ""} onClick={() => setSplitType("BY_AMOUNT")}>
                Por monto
              </button>
              <button className={splitType === "BY_ITEMS" ? "active" : ""} onClick={() => setSplitType("BY_ITEMS")}>
                Por productos
              </button>
            </div>

            <div className="field">
              <label className="label" htmlFor="split-label">Etiqueta (opcional)</label>
              <input
                id="split-label"
                className="input"
                value={splitLabel}
                onChange={(event) => setSplitLabel(event.target.value)}
                placeholder="Ej. Mesa 3 — Juan"
              />
            </div>

            {splitType === "BY_AMOUNT" ? (
              <div className="field">
                <label className="label" htmlFor="split-amount">Monto a dividir (S/)</label>
                <input
                  id="split-amount"
                  className="input"
                  inputMode="decimal"
                  value={splitAmount}
                  onChange={(event) => setSplitAmount(event.target.value)}
                  placeholder={pending.toFixed(2)}
                />
              </div>
            ) : (
              <div className="stack" style={{ marginBottom: 12 }}>
                {data.items.map((item) => {
                  const available = item.quantity - item.split_quantity;
                  const selected = itemQuantities[item.order_item_id] ?? 0;
                  return (
                    <div className="row" key={item.order_item_id}>
                      <div className="grow">
                        <div>{item.name}</div>
                        <div className="hint">
                          {money(item.unit_price)} c/u · disponibles {available}
                        </div>
                      </div>
                      <div className="qty-stepper">
                        <button
                          onClick={() =>
                            setItemQuantities((state) => ({
                              ...state,
                              [item.order_item_id]: Math.max(0, selected - 1),
                            }))
                          }
                        >
                          −
                        </button>
                        <span className="value">{selected}</span>
                        <button
                          disabled={selected >= available}
                          onClick={() =>
                            setItemQuantities((state) => ({
                              ...state,
                              [item.order_item_id]: Math.min(available, selected + 1),
                            }))
                          }
                        >
                          +
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}

            <button className="btn block secondary" onClick={() => void createSplit()} disabled={busy}>
              Dividir
            </button>
          </div>

          <div className="card">
            <div className="section-title" style={{ marginTop: 0 }}>
              <h2>Registrar pago</h2>
            </div>
            <div className="segmented" style={{ marginBottom: 12, flexWrap: "wrap" }}>
              {METHODS.map((entry) => (
                <button
                  key={entry.value}
                  className={method === entry.value ? "active" : ""}
                  onClick={() => setMethod(entry.value)}
                >
                  {entry.label}
                </button>
              ))}
            </div>
            <div className="field">
              <label className="label" htmlFor="pay-amount">Monto (S/)</label>
              <input
                id="pay-amount"
                className="input"
                inputMode="decimal"
                value={payAmount}
                onChange={(event) => setPayAmount(event.target.value)}
                placeholder={pending.toFixed(2)}
              />
            </div>
            <button className="btn block success" onClick={() => void registerPayment()} disabled={busy}>
              {busy ? "Registrando…" : `Cobrar ${money(payAmount || pending.toFixed(2))}`}
            </button>
            <p className="hint">El cobro requiere conexión. Se marca el pedido como pagado al cubrir el total.</p>
          </div>
        </>
      ) : (
        <div className="card center" style={{ flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 40 }}>✅</div>
          <strong>Pedido pagado</strong>
          <span className="hint">No hay saldo pendiente.</span>
        </div>
      )}

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          <h2>Divisiones y pagos</h2>
        </div>
        {data.splits.length === 0 && data.payments.length === 0 ? (
          <div className="hint">Sin divisiones ni pagos registrados.</div>
        ) : (
          <>
            {data.splits.map((split) => (
              <div className="item-row" key={split.id}>
                <div className="name">
                  <div style={{ fontWeight: 700 }}>{split.split_type === "BY_AMOUNT" ? "Por monto" : "Por productos"}</div>
                  {split.label ? <div className="hint">{split.label}</div> : null}
                </div>
                <strong>{money(split.amount)}</strong>
              </div>
            ))}
            {data.payments.map((payment) => (
              <div className="item-row" key={payment.id}>
                <div className="name">
                  <div style={{ fontWeight: 700 }}>
                    Pago {METHODS.find((entry) => entry.value === payment.method)?.label ?? payment.method}
                  </div>
                  <div className="hint">{new Date(payment.paid_at).toLocaleString("es-PE")}</div>
                </div>
                <strong style={{ color: "var(--success)" }}>{money(payment.amount)}</strong>
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
