import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { billingApi } from "../api/endpoints";
import { EmptyState, Spinner } from "../components/Layout";
import { money } from "../hooks/useElapsed";
import { ApiError, NetworkError } from "../api/client";
import { errorMessage } from "../lib/send";
import { useUi } from "../stores/ui";
import { useSession } from "../stores/session";
import type { PaymentMethod } from "../types/api";

const METHODS: { value: PaymentMethod; label: string }[] = [
  { value: "CASH", label: "Efectivo" },
  { value: "YAPE", label: "Yape" },
  { value: "PLIN", label: "Plin" },
  { value: "CARD", label: "Tarjeta" },
  { value: "OTHER", label: "Otro" },
];

const STATUS_LABEL: Record<string, string> = {
  OPEN: "Abierto",
  IN_PREPARATION: "En preparación",
  READY: "Listo",
  DELIVERED: "Entregado",
  PAID: "Pagado",
  CLOSED: "Cerrado",
  CANCELLED: "Cancelado",
};

export function BillingPage() {
  const { orderId = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useUi((state) => state.toast);
  const userId = useSession((state) => state.user?.id ?? "");
  const paymentAttemptKey = `restaurante.payment.${userId}.${orderId}`;
  const [uncertainPayment, setUncertainPayment] = useState(() => !!localStorage.getItem(paymentAttemptKey));

  const billing = useQuery({
    queryKey: ["billing", orderId],
    queryFn: () => billingApi.get(orderId),
    enabled: !!orderId,
    refetchInterval: 15000,
    retry: false,
  });

  const [method, setMethod] = useState<PaymentMethod>("CASH");
  const [busy, setBusy] = useState(false);

  const data = billing.data;
  const pending = useMemo(() => (data ? Number(data.total) - Number(data.paid_amount) : 0), [data]);

  async function registerPayment() {
    if (!data) return;
    setBusy(true);
    try {
      const request = JSON.parse(localStorage.getItem(paymentAttemptKey) ?? "null") as Record<string, unknown> | null;
      // El flujo normal cobra siempre el saldo pendiente completo.
      const amount = pending;
      if (!request && (!Number.isFinite(amount) || amount <= 0)) {
        toast("error", "No hay saldo pendiente por cobrar");
        return;
      }
      const payload = request ?? {
        method,
        amount: amount.toFixed(2),
        client_operation_id: crypto.randomUUID(),
      };
      // Preserve the exact operation across a lost response, retry and page reload.
      localStorage.setItem(paymentAttemptKey, JSON.stringify(payload));
      setUncertainPayment(true);
      const result = await billingApi.createPayment(orderId, payload);
      localStorage.removeItem(paymentAttemptKey);
      setUncertainPayment(false);
      toast("success", "Pago registrado", result.became_paid ? "Pedido pagado en su totalidad" : undefined);
      void queryClient.invalidateQueries({ queryKey: ["billing", orderId] });
      void queryClient.invalidateQueries({ queryKey: ["orders"] });
      void queryClient.invalidateQueries({ queryKey: ["tables"] });
    } catch (error) {
      if (error instanceof NetworkError) {
        toast("warning", "Pago por verificar", "La respuesta no llegó. Reintente para verificar el mismo pago sin duplicarlo.");
      } else if (error instanceof ApiError) {
        if (error.status < 500 && error.status !== 401) {
          localStorage.removeItem(paymentAttemptKey);
          setUncertainPayment(false);
        }
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

  const payments = data.payments ?? [];

  return (
    <div className="stack">
      {uncertainPayment ? <div className="card">
        <p>Hay un pago cuya respuesta quedó pendiente. Verifique ese pago antes de registrar otro.</p>
        <button className="btn" disabled={busy} onClick={() => void registerPayment()}>Verificar pago pendiente</button>
      </div> : null}

      <div className="card">
        <div className="row wrap">
          <div className="grow">
            <h2>{data.table_name ?? "Pedido"}</h2>
            <span className="chip info">{STATUS_LABEL[data.status] ?? data.status}</span>
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
            <div className="value" style={{ color: pending > 0.001 ? "var(--warning)" : "var(--success)" }}>
              {money(pending > 0.001 ? pending : 0)}
            </div>
          </div>
        </div>
        <div className="row" style={{ marginTop: 10 }}>
          <span className="grow hint">Pagado</span>
          <strong style={{ color: "var(--success)" }}>{money(data.paid_amount)}</strong>
        </div>
      </div>

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          <h2>Consumo</h2>
        </div>
        {data.items.map((item) => (
          <div className="item-row" key={item.order_item_id}>
            <span className="qty">×{item.quantity}</span>
            <div className="name">
              <div style={{ fontWeight: 700 }}>{item.name}</div>
              <div className="hint">{money(item.unit_price)} c/u</div>
            </div>
            <strong>{money(item.total)}</strong>
          </div>
        ))}
        {data.items.length === 0 ? <div className="hint">Sin productos en la cuenta.</div> : null}
      </div>

      {pending > 0.001 ? (
        <div className="card">
          <div className="section-title" style={{ marginTop: 0 }}>
            <h2>Cobrar</h2>
          </div>
          <div className="segmented" style={{ marginBottom: 12, flexWrap: "wrap" }} role="group" aria-label="Método de pago">
            {METHODS.map((entry) => (
              <button
                key={entry.value}
                className={method === entry.value ? "active" : ""}
                aria-pressed={method === entry.value}
                onClick={() => setMethod(entry.value)}
              >
                {entry.label}
              </button>
            ))}
          </div>
          <button className="btn block success" onClick={() => void registerPayment()} disabled={busy}>
            {busy ? "Registrando…" : `Cobrar ${money(pending)}`}
          </button>
          <p className="hint">El cobro requiere conexión. El pedido queda pagado al cubrir el total.</p>
        </div>
      ) : data.status === "CANCELLED" ? (
        <div className="card center" style={{ flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 40 }}>🚫</div>
          <strong>Pedido cancelado</strong>
          <span className="hint">Todos los productos se cancelaron: no hay nada que cobrar.</span>
        </div>
      ) : (
        <div className="card center" style={{ flexDirection: "column", gap: 8 }}>
          <div style={{ fontSize: 40 }}>✅</div>
          <strong>Pedido pagado</strong>
          <span className="hint">No hay saldo pendiente.</span>
        </div>
      )}

      <div className="card">
        <div className="section-title" style={{ marginTop: 0 }}>
          <h2>Pagos realizados</h2>
        </div>
        {payments.length === 0 ? (
          <div className="hint">Aún no hay pagos registrados.</div>
        ) : (
          payments.map((payment) => (
            <div className="item-row" key={payment.id}>
              <div className="name">
                <div style={{ fontWeight: 700 }}>
                  {METHODS.find((entry) => entry.value === payment.method)?.label ?? payment.method}
                </div>
                <div className="hint">
                  {new Date(payment.paid_at).toLocaleString("es-PE")}
                  {payment.split_id ? " · de una división anterior" : ""}
                </div>
              </div>
              <strong style={{ color: "var(--success)" }}>{money(payment.amount)}</strong>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
