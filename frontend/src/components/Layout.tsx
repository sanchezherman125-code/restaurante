import type { ReactNode } from "react";

export function EmptyState({ icon = "🍽️", title, hint }: { icon?: string; title: string; hint?: string }) {
  return (
    <div className="empty">
      <div className="icon">{icon}</div>
      <div style={{ fontWeight: 700 }}>{title}</div>
      {hint ? <div className="hint">{hint}</div> : null}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="center" style={{ padding: 40, gap: 12 }}>
      <div className="spinner" />
      {label ? <span className="hint">{label}</span> : null}
    </div>
  );
}

export function Kpi({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="kpi">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
    </div>
  );
}
