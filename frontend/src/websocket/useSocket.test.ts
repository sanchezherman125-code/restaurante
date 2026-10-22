import { describe, expect, it } from "vitest";
import { canReceiveCommandNotification, isDuplicateNotification, isSilentEvent, orderItemReadyTitle, shouldUseSystemPush, taskProgressTitle } from "./useSocket";

describe("notificaciones de order_item.ready (plato completo)", () => {
  it("avisa solo al mesero, una vez por plato, sin importar qué área terminó al final", () => {
    for (const area of ["KITCHEN", "GRILL"]) {
      expect(orderItemReadyTitle("WAITER", { preparation_area: area, name: "Alitas con papas" })).toBe(
        "Plato listo — Alitas con papas",
      );
    }
  });

  it.each(["KITCHEN", "GRILL", "ADMIN"])("no muestra toast de plato completo a %s", (role) => {
    expect(orderItemReadyTitle(role, { preparation_area: "KITCHEN", name: "Lomo saltado" })).toBeNull();
  });
});

describe("un solo aviso por finalización", () => {
  it("un order_item.ready marcado silent solo actualiza pantallas: el aviso lo da order.ready", () => {
    expect(isSilentEvent({ silent: true, name: "Alitas con papas" })).toBe(true);
    expect(isSilentEvent({ silent: false })).toBe(false);
    expect(isSilentEvent({ name: "Alitas con papas" })).toBe(false);
  });
});

describe("avance de una tarea en un plato compartido", () => {
  const base = { name: "Alitas con papas", task_area: "KITCHEN", task_status: "READY", status: "PREPARING", areas: ["GRILL", "KITCHEN"] };

  it("informa a la otra área cuando termina su parte", () => {
    expect(taskProgressTitle("GRILL", base)).toBe("Cocina terminó — Alitas con papas");
  });

  it("no avisa al área que terminó, a áreas que no participan, ni al mesero", () => {
    expect(taskProgressTitle("KITCHEN", base)).toBeNull();
    expect(taskProgressTitle("GRILL", { ...base, areas: ["KITCHEN"] })).toBeNull();
    expect(taskProgressTitle("WAITER", base)).toBeNull();
  });

  it("no anuncia nada si el plato ya está completo ni si la tarea apenas comenzó", () => {
    expect(taskProgressTitle("GRILL", { ...base, status: "READY" })).toBeNull();
    expect(taskProgressTitle("GRILL", { ...base, task_status: "PREPARING" })).toBeNull();
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
