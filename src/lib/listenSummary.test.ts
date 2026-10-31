import { describe, it, expect } from "vitest";
import { listenLine, qualityParts, ago } from "./listenSummary";
import type { ListenStats, QualitySummary } from "../tauri";

const NOW = new Date(2026, 9, 31, 12, 0).getTime();
const at = (daysAgo: number) => Math.floor((NOW - daysAgo * 86_400_000) / 1000);

const q = (r: Partial<QualitySummary> = {}): QualitySummary => ({
  sem_corte: 0, provavel_lossy: 0, lossy: 0, hires_de_cd: 0, unmeasured: 0, lowest_cutoff_hz: null, ...r,
});
const stats = (r: Partial<ListenStats>): ListenStats => ({
  familiarity_ready: true, tracks: 10, listened_tracks: 0, full_listens: 0, plays: 0,
  last_played_at: null, last_ended_at: null, quality: q(), per_track: [], ...r,
});

describe("ago", () => {
  it("dias, semanas, meses, anos", () => {
    expect(ago(at(0), NOW)).toBe("hoje");
    expect(ago(at(1), NOW)).toBe("ontem");
    expect(ago(at(3), NOW)).toBe("há 3 dias");
    expect(ago(at(15), NOW)).toBe("há 2 semanas");
    expect(ago(at(70), NOW)).toBe("há 2 meses");
    expect(ago(at(800), NOW)).toBe("há 2 anos");
  });
});

describe("listenLine (B11)", () => {
  it("ouvido até o fim e a última escuta", () => {
    expect(listenLine(stats({ full_listens: 12, plays: 20, last_played_at: at(3) }), NOW)).toBe(
      "ouvido até o fim 12 vezes · última há 3 dias",
    );
    expect(listenLine(stats({ full_listens: 1, plays: 1, last_played_at: at(0) }), NOW)).toBe(
      "ouvido até o fim 1 vez · última hoje",
    );
  });

  it("tocado mas nunca até o fim", () => {
    expect(listenLine(stats({ plays: 4, last_played_at: at(1) }), NOW)).toBe(
      "tocado 4 vezes, nunca até o fim · última ontem",
    );
  });

  it("nunca tocado", () => {
    expect(listenLine(stats({}), NOW)).toBe("nunca tocado");
  });

  it("motor montando: sem linha (zerado não é verdade)", () => {
    expect(listenLine(stats({ familiarity_ready: false, full_listens: 0 }), NOW)).toBeNull();
  });
});

describe("qualityParts (B11)", () => {
  it("sem corte, CD convertido, lossy e sem medição, nessa ordem", () => {
    expect(qualityParts(q({ sem_corte: 12, lossy: 1, provavel_lossy: 1, hires_de_cd: 2, unmeasured: 3, lowest_cutoff_hz: 16_075 }))).toEqual([
      { n: 12, label: "12 sem corte", tone: "ok" },
      { n: 2, label: "2 CD convertido", tone: "ok" },
      { n: 2, label: "2 lossy", tone: "lossy", title: "Corte de MP3 ou AAC; o menor em 16,1 kHz" },
      { n: 3, label: "3 sem medição", tone: "none" },
    ]);
  });

  it("sem medição não conta como limpa", () => {
    expect(qualityParts(q({ unmeasured: 5 }))).toEqual([{ n: 5, label: "5 sem medição", tone: "none" }]);
  });

  it("nada a dizer: vazio", () => {
    expect(qualityParts(q())).toEqual([]);
  });
});
