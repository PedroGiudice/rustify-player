import { describe, it, expect } from "vitest";
import { groupByDay, playedWhen } from "./historyDays";

// Sexta, 31/10/2026, 15:00 (hora local).
const NOW = new Date(2026, 9, 31, 15, 0).getTime();
const at = (d: number, h: number, m = 0, month = 9, year = 2026) => new Date(year, month, d, h, m).getTime() / 1000;
const t = (id: string, last_played: number | null, play_count = 1) => ({ id, last_played, play_count });

describe("groupByDay (B13)", () => {
  it("agrupa na ordem que chega (mais recente primeiro) com o rótulo do dia", () => {
    const list = [
      t("a", at(31, 14, 32)),
      t("b", at(31, 9, 5)),
      t("c", at(30, 22, 10)),
      t("d", at(27, 8)),
      t("e", at(12, 8)),
      t("f", at(12, 8, 0, 9, 2025)),
    ];
    const g = groupByDay(list, NOW);
    expect(g.map((x) => [x.label, x.items.map((i) => i.id)])).toEqual([
      ["Hoje", ["a", "b"]],
      ["Ontem", ["c"]],
      ["Terça-feira", ["d"]],
      ["12 out", ["e"]],
      ["12 out 2025", ["f"]],
    ]);
  });

  it("faixa sem data fica num grupo próprio no fim", () => {
    const g = groupByDay([t("a", null), t("b", at(31, 10))], NOW);
    expect(g.map((x) => x.label)).toEqual(["Hoje", "Sem data"]);
  });
});

describe("playedWhen", () => {
  it("hora da última vez e quantas vezes tocou, quando mais de uma", () => {
    expect(playedWhen(t("a", at(31, 9, 5), 1))).toBe("09:05");
    expect(playedWhen(t("a", at(31, 14, 32), 7))).toBe("14:32 · 7 vezes");
    expect(playedWhen(t("a", null, 3))).toBe("—");
  });
});
