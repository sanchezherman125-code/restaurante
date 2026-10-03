import { useUi } from "../stores/ui";

export function ConnectionIndicator() {
  const connection = useUi((state) => state.connection);
  const label = connection === "online" ? "En línea" : connection === "connecting" ? "Conectando…" : "Sin conexión";
  return (
    <span className="conn" title={label}>
      <span className={`dot ${connection}`} />
      {label}
    </span>
  );
}
