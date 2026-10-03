import { describe, expect, it } from "vitest";
import { formatElapsed, money } from "./useElapsed";

describe("money", () => {
  it("formatea montos con dos decimales", () => {
    expect(money("12.5")).toBe("S/ 12.50");
    expect(money(0)).toBe("S/ 0.00");
    expect(money(null)).toBe("S/ 0.00");
  });

  it("maneja valores no numéricos", () => {
    expect(money("abc")).toBe("S/ 0.00");
  });
});

describe("formatElapsed", () => {
  it("formatea minutos y segundos", () => {
    expect(formatElapsed(0)).toBe("00:00");
    expect(formatElapsed(65)).toBe("01:05");
    expect(formatElapsed(3600)).toBe("1:00:00");
  });
});
