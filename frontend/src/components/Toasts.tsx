import { useUi } from "../stores/ui";

export function Toasts() {
  const toasts = useUi((state) => state.toasts);
  const dismiss = useUi((state) => state.dismiss);

  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((toast) => (
        <div key={toast.id} className={`toast ${toast.kind}`}>
          <div>
            <strong>{toast.title}</strong>
            {toast.message ? <div className="hint">{toast.message}</div> : null}
          </div>
          <button className="close" onClick={() => dismiss(toast.id)} aria-label="Cerrar">
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}
