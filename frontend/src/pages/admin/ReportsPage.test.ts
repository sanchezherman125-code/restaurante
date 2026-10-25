import { describe, expect, it } from "vitest";
import { periodParams, peruDate } from "./ReportsPage";

describe("períodos de reportes", () => {
  it("usa el día calendario de Perú aunque en UTC ya sea el día siguiente", () => {
    // 23:30 del 14/10 en Lima = 04:30 UTC del 15/10.
    const lateNight = new Date("2026-10-15T04:30:00Z");
    expect(peruDate(lateNight)).toBe("2026-10-14");
    expect(periodParams("today", "", "", lateNight)).toEqual({ date_from: "2026-10-14", date_to: "2026-10-14" });
  });

  it("7 días incluye hoy y los seis anteriores, también al cruzar de mes", () => {
    expect(periodParams("7d", "", "", new Date("2026-11-03T15:00:00Z"))).toEqual({ date_from: "2026-10-28", date_to: "2026-11-03" });
  });

  it("este mes empieza el día 1 del mes de Perú", () => {
    expect(periodParams("month", "", "", new Date("2026-11-01T03:00:00Z"))).toEqual({ date_from: "2026-10-01", date_to: "2026-10-31" });
  });

  it("Todo pide el historial completo y Turno actual no envía filtros", () => {
    expect(periodParams("all", "2026-01-01", "2026-01-31")).toEqual({ scope: "all" });
    expect(periodParams("shift", "2026-01-01", "")).toEqual({});
  });

  it("el rango personalizado solo envía las fechas elegidas", () => {
    expect(periodParams("custom", "2026-10-01", "")).toEqual({ date_from: "2026-10-01" });
    expect(periodParams("custom", "2026-10-01", "2026-10-05")).toEqual({ date_from: "2026-10-01", date_to: "2026-10-05" });
  });
});
