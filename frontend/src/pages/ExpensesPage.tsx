import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client";
import { expensesApi, openReceipt, shiftsApi, uploadReceipt } from "../api/endpoints";
import { Icon } from "../components/Icon";
import { EmptyState, PageHeader, SkeletonList } from "../components/Layout";
import { money } from "../hooks/useElapsed";
import { errorMessage, sendOrQueue } from "../lib/send";
import { useUi } from "../stores/ui";

export function ExpensesPage() {
  const queryClient = useQueryClient();
  const toast = useUi((state) => state.toast);
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [saving, setSaving] = useState(false);

  const expenses = useQuery({ queryKey: ["expenses"], queryFn: () => expensesApi.currentShift(), retry: false });
  const shift = useQuery({ queryKey: ["shifts", "current"], queryFn: shiftsApi.current, retry: false });

  async function submit() {
    const value = Number(amount);
    if (!Number.isFinite(value) || value <= 0) {
      toast("error", "Monto inválido", "Ingrese un monto mayor a 0.");
      return;
    }
    if (!description.trim()) {
      toast("error", "Falta la descripción");
      return;
    }
    // El gasto pertenece al turno en que se registra; si se envía más tarde, el servidor no lo pasa a otro turno.
    const shiftId = shift.data?.status === "OPEN" ? shift.data.id : null;
    if (!shiftId) {
      toast("error", "No hay un turno abierto", "Los gastos se registran dentro de un turno abierto.");
      return;
    }
    setSaving(true);
    try {
      let receiptUrl: string | null = null;
      if (file) {
        const uploaded = await uploadReceipt(file);
        receiptUrl = uploaded.url;
      }
      const payload = { amount: value.toFixed(2), description: description.trim(), receipt_url: receiptUrl, shift_id: shiftId };
      const outcome = await sendOrQueue(
        {
          operation_type: "REGISTER_EXPENSE",
          path: "/api/v1/expenses",
          method: "POST",
          body: payload,
        },
        (operationId) => expensesApi.create(payload, operationId),
      );
      if (!outcome.queued) {
        toast("success", "Gasto registrado");
        void queryClient.invalidateQueries({ queryKey: ["expenses"] });
        void queryClient.invalidateQueries({ queryKey: ["reports"] });
      }
      setAmount("");
      setDescription("");
      setFile(null);
    } catch (error) {
      if (error instanceof ApiError && error.code === "SHIFT_MISMATCH") void queryClient.invalidateQueries({ queryKey: ["shifts"] });
      toast("error", "No se pudo registrar el gasto", errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const total = (expenses.data ?? []).reduce((sum, expense) => sum + Number(expense.amount), 0);

  return (
    <div className="page">
      <PageHeader title="Gastos del turno" subtitle={`${(expenses.data ?? []).length} registrados`}
        actions={<span className="chip danger" aria-label={`Total de gastos ${money(total)}`}>Total {money(total)}</span>} />

      <div className="two-col expenses-layout">
        <form className="card" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
          <div className="section-title"><h2>Nuevo gasto</h2></div>
          <div className="field">
            <label className="label" htmlFor="expense-amount">Monto (S/)</label>
            <input id="expense-amount" className="input" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.00" />
          </div>
          <div className="field">
            <label className="label" htmlFor="expense-desc">Descripción</label>
            <input id="expense-desc" className="input" value={description} onChange={(event) => setDescription(event.target.value)} placeholder="Ej. compra de limón" />
          </div>
          <div className="field">
            <label className="label" htmlFor="expense-file">Comprobante (opcional)</label>
            <input id="expense-file" className="input" type="file" accept="image/*,application/pdf" onChange={(event) => setFile(event.target.files?.[0] ?? null)} />
          </div>
          <button className="btn block" type="submit" disabled={saving}>{saving ? "Guardando…" : "Registrar gasto"}</button>
          <p className="hint" style={{ margin: "var(--s3) 0 0" }}>
            Sin conexión, el gasto queda guardado solo en este dispositivo y se envía al reconectar.
          </p>
        </form>

        <section aria-label="Gastos registrados">
          {expenses.isLoading ? (
            <SkeletonList rows={3} height={56} label="Cargando gastos" />
          ) : expenses.isError ? (
            <EmptyState icon="wifiOff" title="No se pudo cargar el historial de gastos" hint="Verifique la conexión e intente de nuevo." />
          ) : (expenses.data ?? []).length === 0 ? (
            <EmptyState icon="money" title="Aún no hay gastos en este turno" hint="Registre compras o pagos menores para que el resultado neto sea real." />
          ) : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Descripción</th><th className="num-col">Monto</th><th>Comprobante</th></tr></thead>
                <tbody>
                  {(expenses.data ?? []).map((expense) => (
                    <tr key={expense.id}>
                      <td>
                        <div>{expense.description}</div>
                        <div className="hint">
                          {new Date(expense.created_at).toLocaleString("es-PE", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" })}
                          {expense.created_by_name ? ` · ${expense.created_by_name}` : ""}
                        </div>
                      </td>
                      <td className="num-col num">{money(expense.amount)}</td>
                      <td>
                        {expense.receipt_url ? (
                          <button className="chip info" onClick={() => void openReceipt(expense.receipt_url!).catch(
                            (error) => toast("error", "No se pudo abrir el comprobante", errorMessage(error)),
                          )}>
                            <Icon name="receipt" />Ver
                          </button>
                        ) : <span className="hint">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
