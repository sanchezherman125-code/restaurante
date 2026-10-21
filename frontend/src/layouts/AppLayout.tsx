import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { ConnectionIndicator } from "../components/ConnectionIndicator";
import { SyncIndicator } from "../components/SyncIndicator";
import { useSession } from "../stores/session";
import { useUi } from "../stores/ui";
import type { ReactNode } from "react";

interface NavItem {
  to: string;
  icon: "tables" | "orders" | "money" | "kitchen" | "purchases" | "dashboard" | "reports" | "more";
  label: string;
}

function LineIcon({ name, className }: { name: NavItem["icon"] | "bell" | "logout"; className?: string }) {
  const paths: Record<typeof name, ReactNode> = {
    tables: <><rect x="3.5" y="3.5" width="7" height="7" rx="1" /><rect x="13.5" y="3.5" width="7" height="7" rx="1" /><rect x="3.5" y="13.5" width="7" height="7" rx="1" /><rect x="13.5" y="13.5" width="7" height="7" rx="1" /></>,
    orders: <><path d="M7 4.5h10a2 2 0 0 1 2 2v14H5v-14a2 2 0 0 1 2-2Z" /><path d="M9 3h6v3H9zM8.5 11h7M8.5 15h7" /></>,
    money: <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3 9h18M16 14h2" /></>,
    kitchen: <><path d="M4 12h16l-1.5 8h-13L4 12Z" /><path d="M7 9V5m5 4V3m5 6V5" /></>,
    purchases: <><path d="M5 4h14v17H5zM8 8h8M8 12h8M8 16h5" /></>,
    dashboard: <><rect x="3.5" y="3.5" width="7" height="7" rx="1" /><rect x="13.5" y="3.5" width="7" height="7" rx="1" /><rect x="3.5" y="13.5" width="7" height="7" rx="1" /><rect x="13.5" y="13.5" width="7" height="7" rx="1" /></>,
    reports: <><path d="M4 19V5M4 19h17" /><path d="m7 15 4-4 3 2 5-6" /></>,
    more: <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>,
    bell: <><path d="M18 9a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" /></>,
    logout: <><path d="M10 17l5-5-5-5M15 12H3" /><path d="M12 3h7a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-7" /></>,
  };

  return <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

function RestaurantFlame() {
  return (
    <svg className="restaurant-flame" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M12.1 22c4.1 0 7.1-2.8 7.1-6.8 0-3.1-1.6-5.4-4.7-8.5-.2 2.4-1.1 3.7-2.8 4.8C11.4 8.2 9.4 5.1 8 2.5 7.8 6.8 4.8 9.5 4.8 15.2 4.8 19.2 7.6 22 12.1 22Z" stroke="currentColor" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M12 19.1c1.8 0 3-1.2 3-2.8 0-1.3-.8-2.1-1.9-3.2-.2 1-.6 1.6-1.4 2.1-.4-.9-.9-1.5-1.4-2.2-.2 1.8-1.2 2.5-1.2 3.7 0 1.5 1.1 2.4 2.9 2.4Z" fill="currentColor" />
    </svg>
  );
}

function initials(name: string | undefined): string {
  return (name ?? "R")
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0]?.toLocaleUpperCase("es-PE") ?? "")
    .join("");
}

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
    { to: "/comandas", icon: "kitchen", label: "Parrilla" },
    { to: "/gastos", icon: "money", label: "Gastos" },
    { to: "/compras", icon: "purchases", label: "Compras" },
  ],
  ADMIN: [
    { to: "/panel", icon: "dashboard", label: "Panel" },
    { to: "/mesas", icon: "tables", label: "Mesas" },
    { to: "/comandas", icon: "kitchen", label: "Cocina" },
    { to: "/reportes", icon: "reports", label: "Reportes" },
    { to: "/mas", icon: "more", label: "Más" },
  ],
};

export function AppLayout() {
  const user = useSession((state) => state.user);
  const logout = useSession((state) => state.logout);
  const soundEnabled = useUi((state) => state.soundEnabled);
  const toggleSound = useUi((state) => state.toggleSound);
  const navigate = useNavigate();

  const nav = NAV_BY_ROLE[user?.role ?? ""] ?? [];

  return (
    <div className={`app-shell ${user?.role === "WAITER" ? "role-waiter" : ""}`}>
      <header className="app-header">
        <span className="brand">
          <span className="brand-mark-wrap"><RestaurantFlame /></span>
          <span className="brand-copy"><strong>RESTAURANTE</strong><small>{user?.role === "WAITER" ? "Panel del mesero" : user?.display_name ?? "Operación"}</small></span>
        </span>
        <span className="spacer" />
        <ConnectionIndicator />
        <SyncIndicator />
        <button className="header-icon-button sound-button" onClick={toggleSound} title={soundEnabled ? "Desactivar sonido de notificaciones" : "Activar sonido de notificaciones"} aria-label={soundEnabled ? "Desactivar sonido de notificaciones" : "Activar sonido de notificaciones"}>
          <LineIcon name="bell" />
          {soundEnabled ? <span className="notification-dot" /> : null}
        </button>
        <button
          className="header-user-button"
          onClick={async () => {
            await logout();
            if (!useSession.getState().user) navigate("/login");
          }}
          title={`Cerrar sesión${user?.display_name ? ` de ${user.display_name}` : ""}`}
          aria-label="Cerrar sesión"
        >
          {initials(user?.display_name)}
        </button>
      </header>

      <main className="app-main">
        <Outlet />
      </main>

      <nav className="bottom-nav">
        {nav.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? "active" : "")}>
            <LineIcon name={item.icon} className="nav-icon" />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
