import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usersApi } from "../../api/endpoints";
import { Icon } from "../../components/Icon";
import { ConfirmDialog, Modal } from "../../components/Modal";
import { EmptyState, PageHeader, SearchField, SkeletonList } from "../../components/Layout";
import { errorMessage } from "../../lib/send";
import { useUi } from "../../stores/ui";
import type { Role, User } from "../../types/api";

const ROLES: { value: Role; label: string; help: string }[] = [
  { value: "WAITER", label: "Mesero", help: "Abre mesas, envía comandas, entrega y cobra sus pedidos." },
  { value: "KITCHEN", label: "Cocina", help: "Ve y actualiza las tareas de cocina; marca productos agotados." },
  { value: "GRILL", label: "Parrilla", help: "Ve y actualiza las tareas de parrilla; marca productos agotados." },
  { value: "ADMIN", label: "Administrador", help: "Acceso total: carta, usuarios, turnos, cobros y reportes." },
];

interface FormState {
  id?: string;
  username: string;
  display_name: string;
  pin: string;
  role: Role;
  is_active: boolean;
}

const EMPTY: FormState = { username: "", display_name: "", pin: "", role: "WAITER", is_active: true };

export function UsersPage() {
  const queryClient = useQueryClient();
  const toast = useUi((state) => state.toast);
  const [form, setForm] = useState<FormState | null>(null);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState("");
  const [toDisable, setToDisable] = useState<User | null>(null);

  const users = useQuery({ queryKey: ["users"], queryFn: usersApi.list, retry: false });

  async function save() {
    if (!form) return;
    if (!form.username.trim() || !form.display_name.trim()) {
      toast("error", "Complete usuario y nombre");
      return;
    }
    setBusy(true);
    try {
      if (form.id) {
        await usersApi.update(form.id, {
          display_name: form.display_name.trim(),
          role: form.role,
          ...(form.pin ? { pin: form.pin } : {}),
          is_active: form.is_active,
        });
        toast("success", "Usuario actualizado");
      } else {
        if (form.pin.length < 4) {
          toast("error", "El PIN debe tener al menos 4 dígitos");
          return;
        }
        await usersApi.create({
          username: form.username.trim(),
          pin: form.pin,
          display_name: form.display_name.trim(),
          role: form.role,
        });
        toast("success", "Usuario creado");
      }
      setForm(null);
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    } catch (error) {
      toast("error", "No se pudo guardar", errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function disable(user: User) {
    try {
      await usersApi.disable(user.id);
      toast("info", `${user.display_name} deshabilitado`);
      void queryClient.invalidateQueries({ queryKey: ["users"] });
    } catch (error) {
      toast("error", "No se pudo deshabilitar", errorMessage(error));
    }
  }

  const rows = useMemo(() => {
    const q = query.trim().toLocaleLowerCase("es-PE");
    return (users.data ?? []).filter((user) => !q || `${user.display_name} ${user.username}`.toLocaleLowerCase("es-PE").includes(q));
  }, [users.data, query]);

  if (users.isLoading) return <div className="page narrow"><PageHeader title="Usuarios" /><SkeletonList rows={4} height={72} label="Cargando usuarios" /></div>;

  const roleHelp = ROLES.find((entry) => entry.value === form?.role)?.help;

  return (
    <div className="page narrow">
      <PageHeader
        title="Usuarios"
        subtitle="Personal con acceso al sistema y su rol"
        actions={
          <>
            <SearchField value={query} onChange={setQuery} label="Buscar usuario" placeholder="Buscar usuario" hotkey />
            <button className="btn" onClick={() => setForm({ ...EMPTY })}><Icon name="plus" />Nuevo usuario</button>
          </>
        }
      />

      {users.isError ? (
        <EmptyState icon="wifiOff" title="No se pudo cargar los usuarios" hint="Verifique la conexión e intente de nuevo." />
      ) : rows.length === 0 ? (
        <EmptyState icon="users" title={query ? "Ningún usuario coincide" : "Aún no hay usuarios"} />
      ) : (
        <ul className="product-rows">
          {rows.map((user) => (
            <li className={`product-row ${user.is_active ? "" : "inactive"}`} key={user.id}>
              <span className="avatar" aria-hidden="true">{user.display_name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase()}</span>
              <div className="grow">
                <div className="product-name">{user.display_name}</div>
                <div className="hint">@{user.username}</div>
              </div>
              <span className="chip ember">{ROLES.find((entry) => entry.value === user.role)?.label ?? user.role}</span>
              <span className={`chip ${user.is_active ? "success" : "danger"}`}><Icon name={user.is_active ? "check" : "ban"} />{user.is_active ? "Activo" : "Inactivo"}</span>
              <button
                className="btn small secondary"
                aria-label={`Editar ${user.display_name}`}
                onClick={() => setForm({ id: user.id, username: user.username, display_name: user.display_name, pin: "", role: user.role, is_active: user.is_active })}
              >
                <Icon name="edit" />Editar
              </button>
              {user.is_active ? (
                <button className="btn ghost small" aria-label={`Deshabilitar a ${user.display_name}`} onClick={() => setToDisable(user)}>Deshabilitar</button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      {toDisable ? (
        <ConfirmDialog
          title="Deshabilitar usuario"
          message={`${toDisable.display_name} no podrá iniciar sesión y sus sesiones abiertas se cerrarán. Sus pedidos y registros se conservan.`}
          confirmLabel="Deshabilitar"
          danger
          onConfirm={() => { void disable(toDisable); setToDisable(null); }}
          onCancel={() => setToDisable(null)}
        />
      ) : null}

      {form ? (
        <Modal
          title={form.id ? "Editar usuario" : "Nuevo usuario"}
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
              <label className="label" htmlFor="user-username">Usuario</label>
              <input id="user-username" className="input" value={form.username} disabled={Boolean(form.id)} autoCapitalize="none"
                onChange={(event) => setForm({ ...form, username: event.target.value })} placeholder="mesero2" autoFocus={!form.id} />
              {form.id ? <span className="hint">El nombre de usuario no se puede cambiar.</span> : null}
            </div>
            <div className="field">
              <label className="label" htmlFor="user-name">Nombre</label>
              <input id="user-name" className="input" value={form.display_name}
                onChange={(event) => setForm({ ...form, display_name: event.target.value })} placeholder="Juan Pérez" />
            </div>
            <div className="field">
              <label className="label" htmlFor="user-pin">{form.id ? "Nuevo PIN (opcional)" : "PIN (4 a 10 dígitos)"}</label>
              <input id="user-pin" className="input" inputMode="numeric" autoComplete="off" value={form.pin}
                onChange={(event) => setForm({ ...form, pin: event.target.value.replace(/\D/g, "") })} placeholder="••••" />
              {form.id ? <span className="hint">Déjelo vacío para conservar el PIN actual.</span> : null}
            </div>
            <div className="field">
              <span className="label" id="user-role-label">Rol</span>
              <div className="segmented" role="group" aria-labelledby="user-role-label">
                {ROLES.map((entry) => (
                  <button type="button" key={entry.value} className={form.role === entry.value ? "active" : ""} aria-pressed={form.role === entry.value}
                    onClick={() => setForm({ ...form, role: entry.value })}>
                    {entry.label}
                  </button>
                ))}
              </div>
              {roleHelp ? <span className="hint">{roleHelp}</span> : null}
            </div>
            {form.id ? (
              <div className="field">
                <span className="label" id="user-state-label">Estado</span>
                <div className="segmented" role="group" aria-labelledby="user-state-label">
                  <button type="button" className={form.is_active ? "active" : ""} aria-pressed={form.is_active} onClick={() => setForm({ ...form, is_active: true })}>Activo</button>
                  <button type="button" className={!form.is_active ? "active" : ""} aria-pressed={!form.is_active} onClick={() => setForm({ ...form, is_active: false })}>Inactivo</button>
                </div>
              </div>
            ) : null}
            <button type="submit" className="visually-hidden" tabIndex={-1}>Guardar</button>
          </form>
        </Modal>
      ) : null}
    </div>
  );
}
