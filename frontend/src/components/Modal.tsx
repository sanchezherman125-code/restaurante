import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";

interface ModalProps {
  title: string;
  eyebrow?: string;
  icon?: ReactNode;
  className?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}

export function Modal({ title, eyebrow, icon, className, onClose, children, footer }: ModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    requestAnimationFrame(() => dialogRef.current?.focus());
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div ref={dialogRef} className={`modal ${className ?? ""}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <div className="modal-heading">
          {icon ? <span className="modal-heading-icon" aria-hidden="true">{icon}</span> : null}
          <div className="modal-heading-copy">
            {eyebrow ? <span className="modal-eyebrow">{eyebrow}</span> : null}
            <h2 id={titleId}>{title}</h2>
          </div>
          <button className="btn ghost small" onClick={onClose} aria-label="Cerrar">
            ✕
          </button>
        </div>
        {children}
        {footer ? <div className="row" style={{ marginTop: 16 }}>{footer}</div> : null}
      </div>
    </div>
  );
}

interface ConfirmProps {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel = "Confirmar", danger, onConfirm, onCancel }: ConfirmProps) {
  return (
    <Modal
      title={title}
      onClose={onCancel}
      footer={
        <>
          <button className="btn secondary grow" onClick={onCancel}>
            Cancelar
          </button>
          <button className={`btn grow ${danger ? "danger" : ""}`} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p style={{ marginTop: 0 }}>{message}</p>
    </Modal>
  );
}
