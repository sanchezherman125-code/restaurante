import { useNavigate } from "react-router-dom";
import { useSession } from "../../stores/session";

const LINKS: { to: string; icon: string; label: string; hint: string }[] = [
  { to: "/turnos", icon: "🗓️", label: "Turnos", hint: "Abrir o cerrar turno" },
  { to: "/historial", icon: "📚", label: "Historial", hint: "Reportes por turno" },
  { to: "/carta", icon: "🍽️", label: "Carta", hint: "Productos, precios y categorías" },
  { to: "/admin/mesas", icon: "🪑", label: "Mesas", hint: "Alta y edición de mesas" },
  { to: "/usuarios", icon: "👥", label: "Usuarios", hint: "Personal, roles y PIN" },
  { to: "/gastos", icon: "💸", label: "Gastos", hint: "Gastos del turno" },
  { to: "/compras", icon: "🛒", label: "Compras", hint: "Lista de compras" },
  { to: "/pedidos", icon: "🧾", label: "Pedidos", hint: "Ver pedidos activos" },
];

export function MorePage() {
  const navigate = useNavigate();
  const logout = useSession((state) => state.logout);

  return (
    <div className="stack">
      <div className="section-title" style={{ marginTop: 0 }}>
        <h2>Más</h2>
      </div>

      {LINKS.map((link) => (
        <button
          key={link.to}
          className="card row"
          style={{ cursor: "pointer", textAlign: "left", width: "100%" }}
          onClick={() => navigate(link.to)}
        >
          <span style={{ fontSize: 24 }}>{link.icon}</span>
          <span className="grow">
            <strong>{link.label}</strong>
            <div className="hint">{link.hint}</div>
          </span>
          <span className="hint">→</span>
        </button>
      ))}

      <button className="btn danger block" onClick={() => void logout()}>
        Cerrar sesión
      </button>
    </div>
  );
}
