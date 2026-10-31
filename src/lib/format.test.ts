import { describe, expect, it } from "vitest";
import { fmtDur, fmtEta, fmtInt, fmtListDur, fmtSize, plural, relTime } from "./format";

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

// A44: um formato por grandeza, em pt-BR.
describe("plural e fmtInt", () => {
  it("1 faixa, n faixas, milhar com ponto", () => {
    expect(plural(1, "faixa", "faixas")).toBe("1 faixa");
    expect(plural(0, "faixa", "faixas")).toBe("0 faixas");
    expect(plural(2203, "faixa", "faixas")).toBe("2.203 faixas");
  });
  it("fmtInt não depende da localidade do sistema", () => {
    expect(fmtInt(2203)).toBe("2.203");
    expect(fmtInt(1_234_567)).toBe("1.234.567");
    expect(fmtInt(12)).toBe("12");
  });
});

describe("fmtSize", () => {
  it("exato: uma casa com vírgula, MB decimal; GB a partir de 1000 MB", () => {
    expect(fmtSize(7_100_000)).toBe("7,1 MB");
    expect(fmtSize(1_100_000_000)).toBe("1,1 GB");
    expect(fmtSize(0)).toBe("0 MB");
  });
  it("estimativa: til e MB inteiro", () => {
    expect(fmtSize(360_400_000, true)).toBe("~360 MB");
    expect(fmtSize(400_000, true)).toBe("~1 MB");
    expect(fmtSize(1_100_000_000, true)).toBe("~1,1 GB");
  });
});

describe("fmtEta", () => {
  it("tempo estimado com til, horas e minutos separados", () => {
    expect(fmtEta(0)).toBe("0 min");
    expect(fmtEta(30)).toBe("<1 min");
    expect(fmtEta(1700)).toBe("~28 min");
    expect(fmtEta(4800)).toBe("~1 h 20 min");
  });
});

describe("fmtListDur", () => {
  it("duração somada de lista: minutos, depois horas e minutos", () => {
    expect(fmtListDur(25 * 60_000)).toBe("25 min");
    expect(fmtListDur((3 * 60 + 5) * 60_000)).toBe("3 h 05 min");
    expect(fmtListDur(2 * 3_600_000)).toBe("2 h");
    expect(fmtListDur(0)).toBe("0 min");
  });
});
