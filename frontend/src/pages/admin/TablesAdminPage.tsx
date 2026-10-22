import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { tablesApi } from "../../api/endpoints";
import { Modal } from "../../components/Modal";
import { Icon } from "../../components/Icon";
import { EmptyState, PageHeader, SearchField, SkeletonList } from "../../components/Layout";
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
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"ALL" | "FREE" | "OPEN" | "INACTIVE">("ALL");

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

  const rows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("es-PE");
    return (tables.data ?? [])
      .filter((table) => {
        const state = !table.is_active ? "INACTIVE" : table.status === "OPEN" ? "OPEN" : "FREE";
        return (filter === "ALL" || filter === state) && (!q || `${table.name} ${table.number}`.toLocaleLowerCase("es-PE").includes(q));
      })
      .sort((a, b) => a.number - b.number);
  }, [tables.data, query, filter]);
  const count = (state: string) => (tables.data ?? []).filter((table) => (!table.is_active ? "INACTIVE" : table.status === "OPEN" ? "OPEN" : "FREE") === state).length;

  if (tables.isLoading) return <div className="page"><PageHeader title="Mesas" /><SkeletonList rows={4} height={96} label="Cargando mesas" /></div>;

  return (
    <div className="page">
      <PageHeader
        title="Mesas"
        subtitle={`${tables.data?.length ?? 0} mesas registradas`}
        actions={
          <>
            <SearchField value={query} onChange={setQuery} label="Buscar mesa" placeholder="Buscar mesa" hotkey />
            <button className="btn" onClick={() => setForm({ name: "", number: "", is_active: true })}><Icon name="plus" />Nueva mesa</button>
          </>
        }
      />

      <div className="segmented" role="group" aria-label="Filtrar mesas">
        {([["ALL", "Todas", tables.data?.length ?? 0], ["FREE", "Libres", count("FREE")], ["OPEN", "Ocupadas", count("OPEN")], ["INACTIVE", "Inactivas", count("INACTIVE")]] as const).map(([key, label, n]) => (
          <button key={key} className={filter === key ? "active" : ""} aria-pressed={filter === key} onClick={() => setFilter(key)}>{label}<span className="count">{n}</span></button>
        ))}
      </div>

      {tables.isError ? (
        <EmptyState icon="wifiOff" title="No se pudo cargar las mesas" hint="Verifique la conexión e intente de nuevo." />
      ) : (tables.data ?? []).length === 0 ? (
        <EmptyState icon="chair" title="Aún no hay mesas" hint="Cree la primera mesa para que los meseros puedan abrir pedidos."
          action={<button className="btn" onClick={() => setForm({ name: "", number: "", is_active: true })}><Icon name="plus" />Nueva mesa</button>} />
      ) : rows.length === 0 ? (
        <EmptyState icon="search" title="Ninguna mesa coincide" hint="Pruebe con otro nombre, número o filtro." />
      ) : (
        <div className="admin-table-grid">
          {rows.map((table: RestaurantTable) => (
            <button
              key={table.id}
              className={`admin-table ${!table.is_active ? "inactive" : table.status === "OPEN" ? "open" : ""}`}
              onClick={() => setForm({ id: table.id, name: table.name, number: String(table.number), is_active: table.is_active })}
              aria-label={`Editar ${table.name}, ${!table.is_active ? "inactiva" : table.status === "OPEN" ? "ocupada" : "libre"}`}
            >
              <span className="num admin-table-number">{String(table.number).padStart(2, "0")}</span>
              <span className="grow" style={{ textAlign: "left" }}>
                <strong>{table.name}</strong>
                <span className="hint" style={{ display: "block" }}>Mesa n.º {table.number}</span>
              </span>
              {!table.is_active ? <span className="chip"><Icon name="ban" />Inactiva</span>
                : table.status === "OPEN" ? <span className="chip ember"><Icon name="user" />Ocupada</span>
                : <span className="chip free"><Icon name="chair" />Libre</span>}
              <Icon name="edit" className="edit-hint" />
            </button>
          ))}
        </div>
      )}

      {form ? (
        <Modal
          title={form.id ? "Editar mesa" : "Nueva mesa"}
          onClose={() => setForm(null)}
          footer={
            <>
              <button className="btn secondary grow" onClick={() => setForm(null)}>Cancelar</button>
              <button className="btn grow" onClick={() => void save()} disabled={busy}>{busy ? "Guardando…" : "Guardar"}</button>
            </>
          }
        >
          <form onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <div className="field">
              <label className="label" htmlFor="table-name">Nombre</label>
              <input id="table-name" className="input" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="Mesa 1" autoFocus />
            </div>
            <div className="field">
              <label className="label" htmlFor="table-number">Número</label>
              <input id="table-number" className="input" inputMode="numeric" value={form.number}
                onChange={(event) => setForm({ ...form, number: event.target.value.replace(/\D/g, "") })} placeholder="1" />
              <span className="hint">Debe ser único; ordena las mesas en el salón.</span>
            </div>
            {form.id ? (
              <div className="field">
                <span className="label" id="table-state-label">Estado</span>
                <div className="segmented" role="group" aria-labelledby="table-state-label">
                  <button type="button" className={form.is_active ? "active" : ""} aria-pressed={form.is_active} onClick={() => setForm({ ...form, is_active: true })}>Activa</button>
                  <button type="button" className={!form.is_active ? "active" : ""} aria-pressed={!form.is_active} onClick={() => setForm({ ...form, is_active: false })}>Inactiva</button>
                </div>
                <span className="hint">Una mesa inactiva no aparece disponible para abrir pedidos.</span>
              </div>
            ) : null}
            <button type="submit" className="visually-hidden" tabIndex={-1}>Guardar</button>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
