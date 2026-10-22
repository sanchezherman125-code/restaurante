import { useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { billingApi } from "../api/endpoints";
import { Icon } from "../components/Icon";
import { EmptyState, PageHeader, SkeletonList, StatusBadge } from "../components/Layout";
import { ORDER_STATUS } from "../lib/labels";
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

  if (billing.isLoading) return <div className="page narrow"><PageHeader title="Cobro" /><SkeletonList rows={3} height={90} label="Cargando cuenta" /></div>;
  if (billing.isError || !data) {
    return (
      <div className="page narrow">
        <EmptyState icon="wifiOff" title="No se pudo cargar la cuenta" hint="Verifique la conexión e intente de nuevo."
          action={<button className="btn secondary" onClick={() => navigate(-1)}><Icon name="arrowLeft" />Volver</button>} />
      </div>
    );
  }

  const payments = data.payments ?? [];
  const orderStatus = ORDER_STATUS[data.status as keyof typeof ORDER_STATUS];
  const settled = pending <= 0.001;

  return (
    <div className="page">
      <PageHeader
        title={data.table_name ?? "Pedido"}
        subtitle={orderStatus ? <StatusBadge label={orderStatus.label} tone={orderStatus.tone} icon={orderStatus.icon} /> : data.status}
        actions={<button className="btn ghost" onClick={() => navigate(-1)}><Icon name="arrowLeft" />Volver</button>}
      />

      {uncertainPayment ? (
        <div className="offline-banner" role="alert">
          <Icon name="alert" />
          <span className="grow">Hay un cobro cuya respuesta no llegó. Verifíquelo antes de registrar otro: se reenvía el mismo cobro, sin duplicarlo.</span>
          <button className="btn small" disabled={busy} onClick={() => void registerPayment()}>Verificar pago pendiente</button>
        </div>
      ) : null}

      <div className="billing-layout">
        <div className="stack">
          <section className="card" aria-labelledby="consumo-title">
            <div className="section-title"><h2 id="consumo-title">Consumo</h2></div>
            {data.items.map((item) => (
              <div className="item-row" key={item.order_item_id}>
                <span className="qty">×{item.quantity}</span>
                <div className="name">
                  <div style={{ fontWeight: 650 }}>{item.name}</div>
                  <div className="hint">{money(item.unit_price)} c/u</div>
                </div>
                <strong className="num">{money(item.total)}</strong>
              </div>
            ))}
            {data.items.length === 0 ? <div className="hint">Sin productos en la cuenta.</div> : null}
          </section>

          <section className="card" aria-labelledby="pagos-title">
            <div className="section-title"><h2 id="pagos-title">Pagos realizados</h2></div>
            {payments.length === 0 ? (
              <div className="hint">Aún no hay pagos registrados.</div>
            ) : (
              payments.map((payment) => (
                <div className="item-row" key={payment.id}>
                  <div className="name">
                    <div style={{ fontWeight: 650 }}>{METHODS.find((entry) => entry.value === payment.method)?.label ?? payment.method}</div>
                    <div className="hint">
                      {new Date(payment.paid_at).toLocaleString("es-PE")}
                      {payment.split_id ? " · de una división anterior" : ""}
                    </div>
                  </div>
                  <strong className="num" style={{ color: "var(--ok)" }}>{money(payment.amount)}</strong>
                </div>
              ))
            )}
          </section>
        </div>

        <aside className="stack billing-side">
          <section className="card totals" aria-label="Resumen de la cuenta">
            <div className="total-line"><span>Total</span><strong className="num">{money(data.total)}</strong></div>
            <div className="total-line"><span>Pagado</span><strong className="num" style={{ color: "var(--ok)" }}>{money(data.paid_amount)}</strong></div>
            <div className="total-line due"><span>Pendiente</span>
              <strong className="num" style={{ color: settled ? "var(--ok)" : "var(--wait)" }}>{money(settled ? 0 : pending)}</strong>
            </div>
          </section>

          {!settled ? (
            <section className="card" aria-labelledby="cobrar-title">
              <div className="section-title"><h2 id="cobrar-title">Cobrar</h2></div>
              <div className="method-grid" role="group" aria-label="Método de pago">
                {METHODS.map((entry) => (
                  <button key={entry.value} className={method === entry.value ? "active" : ""} aria-pressed={method === entry.value} onClick={() => setMethod(entry.value)}>
                    {entry.label}
                  </button>
                ))}
              </div>
              <button className="btn block large success" onClick={() => void registerPayment()} disabled={busy}>
                {busy ? "Registrando…" : `Cobrar ${money(pending)}`}
              </button>
              <p className="hint" style={{ margin: "var(--s3) 0 0" }}>El cobro requiere conexión. El pedido queda pagado al cubrir el total.</p>
            </section>
          ) : data.status === "CANCELLED" ? (
            <section className="card result">
              <span className="result-icon bad"><Icon name="ban" /></span>
              <strong>Pedido cancelado</strong>
              <span className="hint">Todos los productos se cancelaron: no hay nada que cobrar.</span>
            </section>
          ) : (
            <section className="card result">
              <span className="result-icon"><Icon name="check" /></span>
              <strong>Pedido pagado</strong>
              <span className="hint">No hay saldo pendiente.</span>
            </section>
          )}
        </aside>
      </div>
    </div>
  );
}
