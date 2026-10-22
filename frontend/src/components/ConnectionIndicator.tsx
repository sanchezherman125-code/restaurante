import { useUi } from "../stores/ui";

export function ConnectionIndicator() {
  const connection = useUi((state) => state.connection);
  const label = connection === "online" ? "En línea" : connection === "connecting" ? "Conectando…" : "Sin conexión";
  return (
    <span className={`conn ${connection === "offline" ? "offline" : ""}`} title={label} role="status">
      <span className={`dot ${connection}`} aria-hidden="true" />
      <span className="tool-label">{label}</span>
    </span>
  );
}
