import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { shiftsApi } from "../api/endpoints";
import { ConnectionIndicator } from "../components/ConnectionIndicator";
import { Icon, type IconName } from "../components/Icon";
import { Modal } from "../components/Modal";
import { NotificationSettings } from "../components/NotificationSettings";
import { hasPushSubscription } from "../notifications/push";
import { SyncIndicator } from "../components/SyncIndicator";
import { ROLE_LABEL } from "../lib/labels";
import { useSession } from "../stores/session";
import { useUi } from "../stores/ui";

interface NavItem {
  to: string;
  icon: IconName;
  label: string;
}

function initials(name: string | undefined): string {
  return (name ?? "R")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("es-PE") ?? "")
    .join("");
}

function BrandMark() {
  return <span className="brand-mark"><Icon name="flame" /></span>;
}

/** Navegación inferior (móvil). */
export const NAV_BY_ROLE: Record<string, NavItem[]> = {
  WAITER: [
    { to: "/mesas", icon: "tables", label: "Mesas" },
    { to: "/pedidos", icon: "orders", label: "Pedidos" },
    { to: "/gastos", icon: "money", label: "Gastos" },
  ],
  KITCHEN: [
    { to: "/comandas", icon: "kitchen", label: "Comandas" },
    { to: "/gastos", icon: "money", label: "Gastos" },
    { to: "/compras", icon: "purchases", label: "Compras" },
  ],
  GRILL: [
    { to: "/comandas", icon: "flame", label: "Parrilla" },
    { to: "/gastos", icon: "money", label: "Gastos" },
    { to: "/compras", icon: "purchases", label: "Compras" },
  ],
  ADMIN: [
    { to: "/panel", icon: "dashboard", label: "Panel" },
    { to: "/mesas", icon: "tables", label: "Salón" },
    { to: "/comandas", icon: "kitchen", label: "Cocina" },
    { to: "/reportes", icon: "reports", label: "Reportes" },
    { to: "/mas", icon: "more", label: "Más" },
  ],
};

/** Barra lateral (escritorio y tablet): todo el producto a un clic, agrupado por tarea. */
const SIDEBAR_BY_ROLE: Record<string, { title?: string; items: NavItem[] }[]> = {
  WAITER: [{ items: NAV_BY_ROLE.WAITER }],
  KITCHEN: [{ items: NAV_BY_ROLE.KITCHEN }],
  GRILL: [{ items: NAV_BY_ROLE.GRILL }],
  ADMIN: [
    { title: "Operación", items: [
      { to: "/panel", icon: "dashboard", label: "Panel" },
      { to: "/mesas", icon: "tables", label: "Salón" },
      { to: "/pedidos", icon: "orders", label: "Pedidos" },
      { to: "/comandas", icon: "kitchen", label: "Cocina y parrilla" },
    ] },
    { title: "Carta y local", items: [
      { to: "/carta", icon: "menu", label: "Carta" },
      { to: "/admin/mesas", icon: "chair", label: "Mesas" },
      { to: "/usuarios", icon: "users", label: "Usuarios" },
    ] },
    { title: "Dinero", items: [
      { to: "/turnos", icon: "shift", label: "Turnos" },
      { to: "/reportes", icon: "reports", label: "Reportes" },
      { to: "/historial", icon: "history", label: "Historial" },
      { to: "/gastos", icon: "money", label: "Gastos" },
      { to: "/compras", icon: "purchases", label: "Compras" },
    ] },
  ],
};

function ShiftPill() {
  const shift = useQuery({ queryKey: ["shifts", "current"], queryFn: shiftsApi.current, retry: false, staleTime: 30_000 });
  const open = shift.data && shift.data.status === "OPEN" ? shift.data : null;
  if (shift.isLoading || shift.isError) return <span className="shift-pill" />;
  return (
    <span className="shift-pill" role="status">
      <span className={`status-dot ${open ? "on" : ""}`} aria-hidden="true" />
      {open ? (
        <span>Turno abierto desde <strong>{new Date(open.opened_at).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" })}</strong></span>
      ) : <span>Sin turno abierto</span>}
    </span>
  );
}

export function AppLayout() {
  const user = useSession((state) => state.user);
  const logout = useSession((state) => state.logout);
  const soundEnabled = useUi((state) => state.soundEnabled);
  const loadPreferences = useUi((state) => state.loadPreferences);
  const updatePreferences = useUi((state) => state.updatePreferences);
  const [notificationsOpen, setNotificationsOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (!user?.id) return;
    loadPreferences(user.id);
    let active = true;
    void hasPushSubscription().then((enabled) => {
      if (active) updatePreferences(user.id, { pushEnabled: enabled });
    });
    return () => { active = false; };
  }, [user?.id, loadPreferences, updatePreferences]);

  const role = user?.role ?? "";
  const nav = NAV_BY_ROLE[role] ?? [];
  const groups = SIDEBAR_BY_ROLE[role] ?? [];
  const roleLabel = ROLE_LABEL[role as keyof typeof ROLE_LABEL] ?? "";

  async function signOut() {
    await logout();
    if (!useSession.getState().user) navigate("/login");
  }

  return (
    <div className={`app-shell role-${role.toLowerCase()}`}>
      <a className="skip-link" href="#contenido">Saltar al contenido</a>

      <aside className="sidebar" aria-label="Navegación principal">
        <div className="brand">
          <BrandMark />
          <span className="brand-copy"><strong>Restaurante</strong><small>{roleLabel}</small></span>
        </div>
        <nav className="stack" style={{ gap: "var(--s3)" }}>
          {groups.map((group, index) => (
            <div className="nav-group" key={group.title ?? index}>
              {group.title ? <div className="nav-group-title">{group.title}</div> : null}
              {group.items.map((item) => (
                <NavLink key={item.to} to={item.to} className={({ isActive }) => `nav-link ${isActive ? "active" : ""}`} title={item.label}>
                  <Icon name={item.icon} className="nav-icon" />
                  <span>{item.label}</span>
                </NavLink>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <div className="user-chip">
            <span className="avatar" aria-hidden="true">{initials(user?.display_name)}</span>
            <span className="who"><strong>{user?.display_name}</strong><small>{roleLabel}</small></span>
          </div>
          <button className="nav-link" style={{ background: "transparent", border: 0, width: "100%" }} onClick={() => void signOut()} title="Cerrar sesión">
            <Icon name="logout" className="nav-icon" /><span>Cerrar sesión</span>
          </button>
        </div>
      </aside>

      <header className="topbar">
        <span className="brand"><BrandMark /><span className="brand-copy"><strong>Restaurante</strong><small>{roleLabel}</small></span></span>
        <ShiftPill />
        <div className="topbar-tools">
          <ConnectionIndicator />
          <SyncIndicator />
          <button className="icon-btn" onClick={() => setNotificationsOpen(true)} title="Ajustes de notificaciones" aria-label="Ajustes de notificaciones" aria-haspopup="dialog">
            <Icon name="bell" />
            {soundEnabled ? <span className="dot" aria-hidden="true" /> : null}
          </button>
          <button className="icon-btn account-btn" onClick={() => setAccountOpen(true)} title={user?.display_name} aria-label={`Cuenta de ${user?.display_name ?? "usuario"}`} aria-haspopup="dialog">
            <span className="avatar" style={{ border: 0, background: "transparent" }}>{initials(user?.display_name)}</span>
          </button>
        </div>
      </header>

      <main className="app-main" id="contenido" tabIndex={-1}>
        <Outlet />
      </main>

      <nav className="bottom-nav" aria-label="Navegación principal">
        {nav.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? "active" : "")}>
            <Icon name={item.icon} className="nav-icon" />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
      {notificationsOpen && user ? <NotificationSettings userId={user.id} onClose={() => setNotificationsOpen(false)} /> : null}
      {accountOpen ? (
        <Modal title={user?.display_name ?? "Cuenta"} onClose={() => setAccountOpen(false)}
          footer={<button className="btn danger block" onClick={() => void signOut()}><Icon name="logout" />Cerrar sesión</button>}>
          <p className="hint">{roleLabel} · @{user?.username}</p>
        </Modal>
      ) : null}
    </div>
  );
}
