import { describe, expect, it } from "vitest";
import { canReceiveCommandNotification, isDuplicateNotification, orderItemReadyTitle, shouldUseSystemPush } from "./useSocket";

describe("notificaciones de order_item.ready", () => {
  it.each([
    ["KITCHEN", "GRILL", "Cocina terminó — Lomo saltado"],
    ["KITCHEN", "WAITER", "Plato listo — Lomo saltado"],
    ["GRILL", "KITCHEN", "Parrilla terminó — Lomo saltado"],
    ["GRILL", "WAITER", "Plato listo — Lomo saltado"],
  ])("muestra el texto correcto para %s/%s", (preparationArea, role, expected) => {
    expect(orderItemReadyTitle(role, { preparation_area: preparationArea, name: "Lomo saltado" })).toBe(expected);
  });

  it.each([
    ["KITCHEN", "KITCHEN"],
    ["KITCHEN", "ADMIN"],
    ["GRILL", "GRILL"],
    ["GRILL", "ADMIN"],
  ])("no muestra toast para %s/%s", (preparationArea, role) => {
    expect(orderItemReadyTitle(role, { preparation_area: preparationArea, name: "Lomo saltado" })).toBeNull();
  });
});

describe("filtrado y deduplicación de notificaciones", () => {
  it("limita una comanda a las áreas incluidas y conserva acceso de administración", () => {
    const data = { areas: ["KITCHEN"] };
    expect(canReceiveCommandNotification("KITCHEN", data)).toBe(true);
    expect(canReceiveCommandNotification("GRILL", data)).toBe(false);
    expect(canReceiveCommandNotification("ADMIN", data)).toBe(true);
    expect(canReceiveCommandNotification("WAITER", data)).toBe(false);
  });

  it("deduplica el mismo evento recibido por más de un canal o pestaña", () => {
    localStorage.clear();
    expect(isDuplicateNotification("event-1")).toBe(false);
    expect(isDuplicateNotification("event-1")).toBe(true);
    expect(isDuplicateNotification("event-2")).toBe(false);
  });

  it("deja que el service worker sea el único canal de alertas push cubiertas", () => {
    expect(shouldUseSystemPush("order.ready", true)).toBe(true);
    expect(shouldUseSystemPush("availability.changed", true)).toBe(false);
    expect(shouldUseSystemPush("order.ready", false)).toBe(false);
  });
});
