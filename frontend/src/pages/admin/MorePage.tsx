import { useNavigate } from "react-router-dom";
import { Icon, type IconName } from "../../components/Icon";
import { PageHeader } from "../../components/Layout";
import { useSession } from "../../stores/session";

const GROUPS: { title: string; links: { to: string; icon: IconName; label: string; hint: string }[] }[] = [
  { title: "Operación", links: [
    { to: "/pedidos", icon: "orders", label: "Pedidos", hint: "Pedidos activos y cobros" },
    { to: "/compras", icon: "purchases", label: "Compras", hint: "Lista de compras del equipo" },
    { to: "/gastos", icon: "money", label: "Gastos", hint: "Gastos del turno" },
  ] },
  { title: "Carta y local", links: [
    { to: "/carta", icon: "menu", label: "Carta", hint: "Productos, precios y preparación" },
    { to: "/admin/mesas", icon: "chair", label: "Mesas", hint: "Alta y edición de mesas" },
    { to: "/usuarios", icon: "users", label: "Usuarios", hint: "Personal, roles y PIN" },
  ] },
  { title: "Dinero", links: [
    { to: "/turnos", icon: "shift", label: "Turnos", hint: "Abrir o cerrar el turno" },
    { to: "/historial", icon: "history", label: "Historial", hint: "Reportes de turnos cerrados" },
  ] },
];

export function MorePage() {
  const navigate = useNavigate();
  const logout = useSession((state) => state.logout);

  return (
    <div className="page narrow">
      <PageHeader title="Más" subtitle="Todo lo demás de la administración" />
      {GROUPS.map((group) => (
        <section key={group.title} className="stack" style={{ gap: "var(--s2)" }}>
          <h2 className="group-title">{group.title}</h2>
          {group.links.map((link) => (
            <button key={link.to} className="card interactive row" onClick={() => navigate(link.to)}>
              <span className="more-icon"><Icon name={link.icon} /></span>
              <span className="grow">
                <strong>{link.label}</strong>
                <div className="hint">{link.hint}</div>
              </span>
              <Icon name="chevronRight" />
            </button>
          ))}
        </section>
      ))}
      <button className="btn danger block" onClick={() => void logout()}><Icon name="logout" />Cerrar sesión</button>
    </div>
  );
}
