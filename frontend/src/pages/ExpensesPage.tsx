import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { expensesApi, uploadReceipt } from "../api/endpoints";
import { Spinner, EmptyState } from "../components/Layout";
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
    setSaving(true);
    try {
      let receiptUrl: string | null = null;
      if (file) {
        const uploaded = await uploadReceipt(file);
        receiptUrl = uploaded.url;
      }
      const payload = { amount: value.toFixed(2), description: description.trim(), receipt_url: receiptUrl };
      const outcome = await sendOrQueue(
        {
          operation_type: "REGISTER_EXPENSE",
          path: "/api/v1/expenses",
          method: "POST",
          body: payload,
        },
        () => expensesApi.create(payload),
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
      toast("error", "No se pudo registrar el gasto", errorMessage(error));
    } finally {
      setSaving(false);
    }
  }

  const total = (expenses.data ?? []).reduce((sum, expense) => sum + Number(expense.amount), 0);

  return (
    <div className="stack">
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2>Gastos del turno</h2>
        <span className="chip danger">{money(total)}</span>
      </div>

      <div className="card">
        <div className="field">
          <label className="label">Monto (S/)</label>
          <input
            className="input"
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="0.00"
          />
        </div>
        <div className="field">
          <label className="label">Descripción</label>
          <input
            className="input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="Ej. compra de limón"
          />
        </div>
        <div className="field">
          <label className="label">Comprobante (opcional)</label>
          <input
            className="input"
            type="file"
            accept="image/*,application/pdf"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
          />
        </div>
        <button className="btn block" onClick={() => void submit()} disabled={saving}>
          {saving ? "Guardando…" : "Registrar gasto"}
        </button>
        <p className="hint" style={{ marginBottom: 0 }}>
          Sin conexión el gasto se guarda localmente y se sincroniza al reconectar.
        </p>
      </div>

      {expenses.isLoading ? (
        <Spinner />
      ) : expenses.isError ? (
        <EmptyState icon="📡" title="No se pudo cargar el historial de gastos" />
      ) : (expenses.data ?? []).length === 0 ? (
        <EmptyState icon="💸" title="Sin gastos en este turno" />
      ) : (
        <div className="card">
          <table className="data">
            <thead>
              <tr>
                <th>Descripción</th>
                <th>Monto</th>
                <th>Comprobante</th>
              </tr>
            </thead>
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
                  <td>{money(expense.amount)}</td>
                  <td>
                    {expense.receipt_url ? (
                      <a className="chip info" href={expense.receipt_url} target="_blank" rel="noreferrer">
                        ver
                      </a>
                    ) : (
                      <span className="hint">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
