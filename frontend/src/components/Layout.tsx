import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./Icon";
import { toneClass, type Tone } from "../lib/labels";

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="titles">
        <h1>{title}</h1>
        {subtitle ? <div className="sub">{subtitle}</div> : null}
      </div>
      {actions ? <div className="actions">{actions}</div> : null}
    </div>
  );
}

export function EmptyState({ icon = "tables", title, hint, action }: { icon?: IconName; title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="empty">
      <div className="icon"><Icon name={icon} /></div>
      <strong>{title}</strong>
      {hint ? <div className="hint">{hint}</div> : null}
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="center" style={{ padding: 40, gap: 12 }} role="status">
      <div className="spinner" />
      {label ? <span className="hint">{label}</span> : <span className="visually-hidden">Cargando</span>}
    </div>
  );
}

/** Marcador de carga con la forma del contenido: evita saltos de diseño al llegar los datos. */
export function SkeletonList({ rows = 4, height = 64, label }: { rows?: number; height?: number; label?: string }) {
  return (
    <div className="stack" role="status" aria-label={label ?? "Cargando"} style={{ gap: "var(--s2)" }}>
      {Array.from({ length: rows }, (_, index) => <span key={index} className="skeleton" style={{ height }} />)}
    </div>
  );
}

export function Kpi({ label, value, note, tone }: { label: string; value: ReactNode; note?: ReactNode; tone?: "accent" | "neg" }) {
  return (
    <div className={`kpi ${tone ?? ""}`}>
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {note ? <div className="note">{note}</div> : null}
    </div>
  );
}

/** Estado con icono + texto: el color refuerza, nunca es el único canal. */
export function StatusBadge({ label, tone, icon }: { label: string; tone: Tone; icon?: IconName }) {
  return (
    <span className={`chip ${toneClass(tone)}`}>
      {icon ? <Icon name={icon} /> : null}
      {label}
    </span>
  );
}

/** Campo de búsqueda; con `hotkey` la tecla "/" lo enfoca desde cualquier parte (uso con teclado físico). */
export function SearchField({ value, onChange, label, placeholder, hotkey = false }: {
  value: string; onChange: (value: string) => void; label: string; placeholder?: string; hotkey?: boolean;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!hotkey) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      event.preventDefault();
      ref.current?.focus();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [hotkey]);
  const id = useId();
  return (
    <div className="search">
      <label className="visually-hidden" htmlFor={id}>{label}</label>
      <Icon name="search" />
      <input id={id} ref={ref} className="input" type="search" value={value} placeholder={placeholder ?? label}
        onChange={(event) => onChange(event.target.value)} autoComplete="off" />
      {hotkey && !value ? <kbd aria-hidden="true">/</kbd> : null}
    </div>
  );
}
