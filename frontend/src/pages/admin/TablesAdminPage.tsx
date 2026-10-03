import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { tablesApi } from "../../api/endpoints";
import { Modal } from "../../components/Modal";
import { EmptyState, Spinner } from "../../components/Layout";
import { errorMessage } from "../../lib/send";
import { useUi } from "../../stores/ui";
import type { RestaurantTable } from "../../types/api";

interface FormState {
  id?: string;
  name: string;
  number: string;
  is_active: boolean;
}

export function TablesAdminPage() {
  const queryClient = useQueryClient();
  const toast = useUi((state) => state.toast);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);

  const tables = useQuery({ queryKey: ["tables"], queryFn: tablesApi.list, retry: false });

  async function save() {
    if (!form) return;
    const number = Number(form.number);
    if (!form.name.trim() || !Number.isInteger(number) || number < 1) {
      toast("error", "Complete nombre y número de mesa");
      return;
    }
    setBusy(true);
    try {
      if (form.id) {
        await tablesApi.update(form.id, { name: form.name.trim(), number, is_active: form.is_active });
        toast("success", "Mesa actualizada");
      } else {
        await tablesApi.create({ name: form.name.trim(), number });
        toast("success", "Mesa creada");
      }
      setForm(null);
      void queryClient.invalidateQueries({ queryKey: ["tables"] });
    } catch (error) {
      toast("error", "No se pudo guardar", errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  if (tables.isLoading) return <Spinner label="Cargando mesas…" />;

  return (
    <div className="stack">
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2>Mesas</h2>
        <button className="btn small" onClick={() => setForm({ name: "", number: "", is_active: true })}>
          + Nueva
        </button>
      </div>

      {tables.isError ? (
        <EmptyState icon="📡" title="No se pudo cargar" />
      ) : (tables.data ?? []).length === 0 ? (
        <EmptyState icon="🪑" title="Sin mesas" hint="Cree la primera mesa." />
      ) : (
        (tables.data ?? []).map((table: RestaurantTable) => (
          <div className="card" key={table.id}>
            <div className="row wrap">
              <div className="grow">
                <strong>{table.name}</strong>
                <div className="hint">N° {table.number}</div>
              </div>
              <span className={`chip ${table.status === "OPEN" ? "open" : table.is_active ? "free" : "danger"}`}>
                {table.status === "OPEN" ? "ocupada" : table.is_active ? "libre" : "inactiva"}
              </span>
              <button
                className="btn small secondary"
                onClick={() =>
                  setForm({
                    id: table.id,
                    name: table.name,
                    number: String(table.number),
                    is_active: table.is_active,
                  })
                }
              >
                Editar
              </button>
            </div>
          </div>
        ))
      )}

      {form ? (
        <Modal
          title={form.id ? "Editar mesa" : "Nueva mesa"}
          onClose={() => setForm(null)}
          footer={
            <>
              <button className="btn secondary grow" onClick={() => setForm(null)}>
                Cancelar
              </button>
              <button className="btn grow" onClick={() => void save()} disabled={busy}>
                {busy ? "Guardando…" : "Guardar"}
              </button>
            </>
          }
        >
          <div className="field">
            <label className="label">Nombre</label>
            <input
              className="input"
              value={form.name}
              onChange={(event) => setForm({ ...form, name: event.target.value })}
              placeholder="Mesa 1"
            />
          </div>
          <div className="field">
            <label className="label">Número</label>
            <input
              className="input"
              inputMode="numeric"
              value={form.number}
              onChange={(event) => setForm({ ...form, number: event.target.value.replace(/\D/g, "") })}
              placeholder="1"
            />
          </div>
          {form.id ? (
            <div className="field">
              <label className="label">Estado</label>
              <div className="segmented">
                <button className={form.is_active ? "active" : ""} onClick={() => setForm({ ...form, is_active: true })}>
                  Activa
                </button>
                <button className={!form.is_active ? "active" : ""} onClick={() => setForm({ ...form, is_active: false })}>
                  Inactiva
                </button>
              </div>
            </div>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
