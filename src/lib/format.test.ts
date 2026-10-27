import { describe, expect, it } from "vitest";
import { fmtDur, relTime } from "./format";

describe("fmtDur", () => {
  it("trunca os segundos e usa M:SS", () => {
    expect(fmtDur(255_900)).toBe("4:15");
    expect(fmtDur(59_999)).toBe("0:59");
    expect(fmtDur(0)).toBe("0:00");
    expect(fmtDur(600_000)).toBe("10:00");
  });

  it("passa a H:MM:SS a partir de 1 h", () => {
    expect(fmtDur(3_600_000)).toBe("1:00:00");
    expect(fmtDur(3_725_000)).toBe("1:02:05");
  });
});

describe("relTime", () => {
  // Terça, 27/10/2026 15:00 na hora local.
  const now = new Date(2026, 9, 27, 15, 0, 0).getTime();
  const at = (d: Date) => d.getTime() / 1000;

  it("sem timestamp mostra traço", () => {
    expect(relTime(null, now)).toBe("—");
  });

  it("recente em minutos", () => {
    expect(relTime(now / 1000 - 20, now)).toBe("agora");
    expect(relTime(now / 1000 - 12 * 60, now)).toBe("há 12 min");
  });

  it("hoje, ontem e dia da semana com a hora", () => {
    expect(relTime(at(new Date(2026, 9, 27, 9, 5)), now)).toBe("hoje 09:05");
    expect(relTime(at(new Date(2026, 9, 26, 22, 10)), now)).toBe("ontem 22:10");
    expect(relTime(at(new Date(2026, 9, 23, 14, 32)), now)).toBe("sex 14:32");
  });

  it("mais antigo vira data", () => {
    expect(relTime(at(new Date(2026, 9, 12, 10, 0)), now)).toBe("12 out");
    expect(relTime(at(new Date(2025, 2, 3, 10, 0)), now)).toBe("3 mar 2025");
  });
});
