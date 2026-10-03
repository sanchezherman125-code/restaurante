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
    { to: "/mesas", icon: "🟩", label: "Mesas" },
    { to: "/pedidos", icon: "🧾", label: "Pedidos" },
    { to: "/gastos", icon: "💸", label: "Gastos" },
  ],
  KITCHEN: [
    { to: "/comandas", icon: "👨‍🍳", label: "Comandas" },
    { to: "/gastos", icon: "💸", label: "Gastos" },
    { to: "/compras", icon: "🛒", label: "Compras" },
  ],
  GRILL: [
    { to: "/comandas", icon: "🔥", label: "Parrilla" },
    { to: "/gastos", icon: "💸", label: "Gastos" },
    { to: "/compras", icon: "🛒", label: "Compras" },
  ],
  ADMIN: [
    { to: "/panel", icon: "📊", label: "Panel" },
    { to: "/mesas", icon: "🟩", label: "Mesas" },
    { to: "/comandas", icon: "🍳", label: "Cocina" },
    { to: "/reportes", icon: "📈", label: "Reportes" },
    { to: "/mas", icon: "⋯", label: "Más" },
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
        <span className="brand">🍽️ Restaurante</span>
        <span className="chip info">{user?.display_name}</span>
        <span className="spacer" />
        <ConnectionIndicator />
        <SyncIndicator />
        <button className="btn ghost small" onClick={toggleSound} title="Sonido de notificaciones">
          {soundEnabled ? "🔔" : "🔕"}
        </button>
        <button
          className="btn ghost small"
          onClick={async () => {
            await logout();
            navigate("/login");
          }}
          title="Cerrar sesión"
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
            <span className="nav-icon">{item.icon}</span>
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
