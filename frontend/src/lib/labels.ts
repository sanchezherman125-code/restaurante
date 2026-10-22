import type { IconName } from "../components/Icon";
import type { ItemStatus, OrderStatus, PaymentMethod, Role, TaskStatus } from "../types/api";

export type Tone = "neutral" | "wait" | "run" | "ok" | "bad" | "ember";

/** Etiquetas en español para estados internos: nunca se muestran códigos como IN_PREPARATION. */
export const ORDER_STATUS: Record<OrderStatus, { label: string; tone: Tone; icon: IconName }> = {
  OPEN: { label: "Abierto", tone: "wait", icon: "hourglass" },
  IN_PREPARATION: { label: "En preparación", tone: "run", icon: "flame" },
  READY: { label: "Listo para entregar", tone: "ok", icon: "check" },
  DELIVERED: { label: "Entregado, por cobrar", tone: "ember", icon: "money" },
  PAID: { label: "Pagado", tone: "ok", icon: "check" },
  CLOSED: { label: "Cerrado", tone: "neutral", icon: "check" },
  CANCELLED: { label: "Cancelado", tone: "bad", icon: "ban" },
};

export const ITEM_STATUS: Record<ItemStatus, { label: string; tone: Tone; icon: IconName }> = {
  PENDING: { label: "Pendiente", tone: "wait", icon: "hourglass" },
  PREPARING: { label: "Preparando", tone: "run", icon: "flame" },
  READY: { label: "Listo", tone: "ok", icon: "check" },
  DELIVERED: { label: "Entregado", tone: "neutral", icon: "check" },
  CANCELLED: { label: "Cancelado", tone: "bad", icon: "ban" },
};

export const TASK_STATUS: Record<TaskStatus, { label: string; tone: Tone; icon: IconName }> = {
  PENDING: { label: "Pendiente", tone: "wait", icon: "hourglass" },
  PREPARING: { label: "Preparando", tone: "run", icon: "flame" },
  READY: { label: "Listo", tone: "ok", icon: "check" },
  CANCELLED: { label: "Cancelado", tone: "bad", icon: "ban" },
};

export const AREA_NAME: Record<string, string> = { KITCHEN: "Cocina", GRILL: "Parrilla", WAITER: "Salón" };

export const PAYMENT_METHOD: Record<PaymentMethod, string> = {
  CASH: "Efectivo", YAPE: "Yape", PLIN: "Plin", CARD: "Tarjeta", OTHER: "Otro",
};

export const ROLE_LABEL: Record<Role, string> = {
  ADMIN: "Administrador", WAITER: "Mesero", KITCHEN: "Cocina", GRILL: "Parrilla",
};

export const toneClass = (tone: Tone): string =>
  ({ neutral: "", wait: "warning", run: "info", ok: "success", bad: "danger", ember: "ember" })[tone];
