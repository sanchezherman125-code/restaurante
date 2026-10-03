import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { ConnectionIndicator } from "../components/ConnectionIndicator";
import { SyncIndicator } from "../components/SyncIndicator";
import { useSession } from "../stores/session";
import { useUi } from "../stores/ui";

interface NavItem {
  to: string;
  icon: string;
  label: string;
}

export const NAV_BY_ROLE: Record<string, NavItem[]> = {
  WAITER: [
    { to: "/mesas", icon: "/icons/tables.png", label: "Mesas" },
    { to: "/pedidos", icon: "/icons/checklist.png", label: "Pedidos" },
    { to: "/gastos", icon: "/icons/payments.png", label: "Gastos" },
  ],
  KITCHEN: [
    { to: "/comandas", icon: "/icons/kitchen.png", label: "Comandas" },
    { to: "/gastos", icon: "/icons/payments.png", label: "Gastos" },
    { to: "/compras", icon: "/icons/checklist.png", label: "Compras" },
  ],
  GRILL: [
    { to: "/comandas", icon: "/icons/kitchen.png", label: "Parrilla" },
    { to: "/gastos", icon: "/icons/payments.png", label: "Gastos" },
    { to: "/compras", icon: "/icons/checklist.png", label: "Compras" },
  ],
  ADMIN: [
    { to: "/panel", icon: "/icons/dashboard.png", label: "Panel" },
    { to: "/mesas", icon: "/icons/tables.png", label: "Mesas" },
    { to: "/comandas", icon: "/icons/kitchen.png", label: "Cocina" },
    { to: "/reportes", icon: "/icons/reports.png", label: "Reportes" },
    { to: "/mas", icon: "/icons/checklist.png", label: "Más" },
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
    <div className="app-shell">
      <header className="app-header">
        <span className="brand"><img className="brand-mark" src="/favicon.png" alt="" />Restaurante</span>
        <span className="chip info">{user?.display_name}</span>
        <span className="spacer" />
        <ConnectionIndicator />
        <SyncIndicator />
        <button className="btn ghost small" onClick={toggleSound} title="Sonido de notificaciones" aria-label="Sonido de notificaciones">
          {soundEnabled ? "🔔" : "🔕"}
        </button>
        <button
          className="btn ghost small"
          onClick={async () => {
            await logout();
            navigate("/login");
          }}
          title="Cerrar sesión"
          aria-label="Cerrar sesión"
        >
          ⎋
        </button>
      </header>

      <main className="app-main">
        <Outlet />
      </main>

      <nav className="bottom-nav">
        {nav.map((item) => (
          <NavLink key={item.to} to={item.to} className={({ isActive }) => (isActive ? "active" : "")}>
            <img className="nav-icon" src={item.icon} alt="" aria-hidden="true" />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
