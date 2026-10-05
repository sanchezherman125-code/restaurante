import { describe, expect, it } from "vitest";
import { orderItemReadyTitle } from "./useSocket";

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
