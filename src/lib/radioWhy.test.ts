import { describe, it, expect } from "vitest";
import { autoplayReasonText, exclusionText } from "./radioWhy";
import type { AutoplayReason, RadioExclusion } from "../tauri";

const reason = (r: Partial<AutoplayReason>): AutoplayReason => ({
  kind: "known", ended: null, liked: null, pool: null, seed_id: "1", ...r,
});

describe("autoplayReasonText (B10)", () => {
  it("conhecida diz quantas vezes foi ouvida até o fim", () => {
    expect(autoplayReasonText(reason({ kind: "known", ended: 7 }))).toBe(
      "Conhecida: você ouviu até o fim 7 vezes",
    );
    expect(autoplayReasonText(reason({ kind: "known", ended: 1 }))).toBe(
      "Conhecida: você ouviu até o fim 1 vez",
    );
  });

  it("conhecida por curtida", () => {
    expect(autoplayReasonText(reason({ kind: "known", ended: 0, liked: true }))).toBe("Conhecida: você curtiu");
    expect(autoplayReasonText(reason({ kind: "known", ended: 4, liked: true }))).toBe(
      "Conhecida: você curtiu e ouviu até o fim 4 vezes",
    );
  });

  it("descoberta", () => {
    expect(autoplayReasonText(reason({ kind: "discovery", ended: 0 }))).toBe("Descoberta: nunca ouvida até o fim");
    expect(autoplayReasonText(reason({ kind: "discovery", ended: 2 }))).toBe("Descoberta: ouvida até o fim só 2 vezes");
    expect(autoplayReasonText(reason({ kind: "discovery", ended: null }))).toBe("Descoberta");
  });

  it("parecida com a semente, pelo título quando se sabe", () => {
    expect(autoplayReasonText(reason({ kind: "similar" }), "Alright")).toBe("Parecida com “Alright”");
    expect(autoplayReasonText(reason({ kind: "similar" }), null)).toBe("Parecida com a faixa de partida");
  });

  it("sorteio do acervo", () => {
    expect(autoplayReasonText(reason({ kind: "shuffle" }))).toBe("Sorteio do acervo");
  });
});

const ex = (r: Partial<RadioExclusion>): RadioExclusion => ({
  never_ends: false, motor_attempts: 0, early_skips: 0, early_skips_total: 0, ended: 0,
  never_at: null, off_stations: [], released_at: null, ...r,
});

describe("exclusionText (B9)", () => {
  const names = (id: string) => ({ chuva: "Chuva", noite: "Noite" } as Record<string, string>)[id];
  const now = new Date(2026, 9, 31, 12, 0).getTime();

  it("nunca no rádio, com a data", () => {
    const ts = new Date(2026, 9, 12, 9, 0).getTime() / 1000;
    expect(exclusionText(ex({ never_at: ts }), names, now)).toBe("Você tirou do rádio em 12 out");
  });

  it("fora de stations, pelo nome", () => {
    expect(exclusionText(ex({ off_stations: ["chuva", "noite"] }), names, now)).toBe(
      "Fora das stations Chuva e Noite",
    );
    expect(exclusionText(ex({ off_stations: ["chuva"] }), names, now)).toBe("Fora da station Chuva");
    expect(exclusionText(ex({ off_stations: ["sumiu"] }), names, now)).toBe("Fora de 1 station que já não existe");
  });

  it("o motor tirou: o motivo em números", () => {
    expect(exclusionText(ex({ never_ends: true, motor_attempts: 5, early_skips: 4 }), names, now)).toBe(
      "Pulada cedo 4 vezes nas 5 em que o rádio a tocou, nunca até o fim",
    );
  });

  it("junta os motivos", () => {
    expect(
      exclusionText(ex({ never_ends: true, motor_attempts: 3, early_skips: 3, off_stations: ["chuva"] }), names, now),
    ).toBe("Pulada cedo 3 vezes nas 3 em que o rádio a tocou, nunca até o fim · Fora da station Chuva");
  });
});
