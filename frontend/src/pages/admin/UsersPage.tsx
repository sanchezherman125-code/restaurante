import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usersApi } from "../../api/endpoints";
import { Modal } from "../../components/Modal";
import { EmptyState, Spinner } from "../../components/Layout";
import { errorMessage } from "../../lib/send";
import { useUi } from "../../stores/ui";
import type { Role, User } from "../../types/api";

const ROLES: { value: Role; label: string }[] = [
  { value: "WAITER", label: "Mesero" },
  { value: "KITCHEN", label: "Cocina" },
  { value: "GRILL", label: "Parrilla" },
  { value: "ADMIN", label: "Administrador" },
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

  if (users.isLoading) return <Spinner label="Cargando usuarios…" />;

  return (
    <div className="stack">
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2>Usuarios</h2>
        <button className="btn small" onClick={() => setForm({ ...EMPTY })}>
          + Nuevo
        </button>
      </div>

      {users.isError ? (
        <EmptyState icon="📡" title="No se pudo cargar" />
      ) : (
        (users.data ?? []).map((user) => (
          <div className="card" key={user.id}>
            <div className="row wrap">
              <div className="grow">
                <strong>{user.display_name}</strong>
                <div className="hint">
                  {user.username} · {ROLES.find((entry) => entry.value === user.role)?.label ?? user.role}
                </div>
              </div>
              <span className={`chip ${user.is_active ? "open" : "danger"}`}>{user.is_active ? "activo" : "inactivo"}</span>
              <button
                className="btn small secondary"
                onClick={() =>
                  setForm({
                    id: user.id,
                    username: user.username,
                    display_name: user.display_name,
                    pin: "",
                    role: user.role,
                    is_active: user.is_active,
                  })
                }
              >
                Editar
              </button>
              {user.is_active ? (
                <button className="btn ghost small" onClick={() => void disable(user)}>
                  Deshabilitar
                </button>
              ) : null}
            </div>
          </div>
        ))
      )}

      {form ? (
        <Modal
          title={form.id ? "Editar usuario" : "Nuevo usuario"}
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
          {!form.id ? (
            <div className="field">
              <label className="label">Usuario</label>
              <input
                className="input"
                value={form.username}
                onChange={(event) => setForm({ ...form, username: event.target.value })}
                placeholder="mesero2"
              />
            </div>
          ) : (
            <div className="field">
              <label className="label">Usuario</label>
              <input className="input" value={form.username} disabled />
            </div>
          )}
          <div className="field">
            <label className="label">Nombre</label>
            <input
              className="input"
              value={form.display_name}
              onChange={(event) => setForm({ ...form, display_name: event.target.value })}
              placeholder="Juan Pérez"
            />
          </div>
          <div className="field">
            <label className="label">{form.id ? "Nuevo PIN (opcional)" : "PIN (4 a 10 dígitos)"}</label>
            <input
              className="input"
              inputMode="numeric"
              value={form.pin}
              onChange={(event) => setForm({ ...form, pin: event.target.value.replace(/\D/g, "") })}
              placeholder="1234"
            />
          </div>
          <div className="field">
            <label className="label">Rol</label>
            <div className="segmented">
              {ROLES.map((entry) => (
                <button
                  key={entry.value}
                  className={form.role === entry.value ? "active" : ""}
                  onClick={() => setForm({ ...form, role: entry.value })}
                >
                  {entry.label}
                </button>
              ))}
            </div>
          </div>
          {form.id ? (
            <div className="field">
              <label className="label">Estado</label>
              <div className="segmented">
                <button className={form.is_active ? "active" : ""} onClick={() => setForm({ ...form, is_active: true })}>
                  Activo
                </button>
                <button className={!form.is_active ? "active" : ""} onClick={() => setForm({ ...form, is_active: false })}>
                  Inactivo
                </button>
              </div>
            </div>
          ) : null}
        </Modal>
      ) : null}
    </div>
  );
}
