/* ============================================================
   radioSession.test.ts — sinal de sessão client-side de station
   (Fase 2/3 do session-awareness). Escrito ANTES da implementação
   (TDD) — ver docs/superpowers/specs/2026-07-12-session-awareness-design.md.
   ============================================================ */

import { describe, it, expect, beforeEach } from "vitest";
import {
  startRadioSession,
  registerSeen,
  registerSkipIfEarly,
  resetRadioSession,
  currentSession,
} from "./radioSession";

beforeEach(() => {
  resetRadioSession();
});

describe("startRadioSession", () => {
  it("gera contextId com prefixo station:<id>: e reseta seen/skipped", () => {
    registerSeen(["1", "2"]);
    const contextId = startRadioSession("neon-123");
    expect(contextId).toMatch(/^station:neon-123:\d+$/);
    expect(currentSession()).toEqual({
      stationId: "neon-123",
      contextId,
      seenIds: [],
      skippedIds: [],
      lastAcceptedId: null,
    });
  });

  it("chamadas sucessivas trocam a station ativa e o contextId", () => {
    const a = startRadioSession("x");
    const b = startRadioSession("y");
    expect(a).not.toBe(b);
    expect(currentSession().stationId).toBe("y");
    expect(currentSession().contextId).toBe(b);
  });
});

describe("registerSeen", () => {
  it("acumula ids na sessao ativa", () => {
    startRadioSession("s1");
    registerSeen(["1", "2"]);
    registerSeen(["3"]);
    expect(currentSession().seenIds).toEqual(["1", "2", "3"]);
  });

  it("ignora ids vazios/nulos/undefined", () => {
    startRadioSession("s1");
    registerSeen(["1", "", null, undefined, "2"]);
    expect(currentSession().seenIds).toEqual(["1", "2"]);
  });
});

describe("registerSkipIfEarly", () => {
  it("registra quando a posicao relativa fica abaixo do threshold (0.35)", () => {
    startRadioSession("s1");
    registerSkipIfEarly("t1", 10, 180); // ~0.055
    expect(currentSession().skippedIds).toEqual(["t1"]);
  });

  it("NAO registra no limiar exato (0.35) nem acima", () => {
    startRadioSession("s1");
    registerSkipIfEarly("t1", 63, 180); // exatamente 0.35
    registerSkipIfEarly("t2", 90, 180); // 0.5
    expect(currentSession().skippedIds).toEqual([]);
  });

  it("ignora duration invalida (0 ou negativa) e trackId vazio", () => {
    startRadioSession("s1");
    registerSkipIfEarly("t1", 5, 0);
    registerSkipIfEarly("t2", 5, -1);
    registerSkipIfEarly("", 1, 100);
    expect(currentSession().skippedIds).toEqual([]);
  });

  it("mais recente primeiro, repetir o mesmo trackId nao duplica", () => {
    startRadioSession("s1");
    registerSkipIfEarly("t1", 1, 100);
    registerSkipIfEarly("t2", 1, 100);
    registerSkipIfEarly("t1", 1, 100); // repete t1 -> volta pro topo, sem duplicar
    expect(currentSession().skippedIds).toEqual(["t1", "t2"]);
  });

  it("cap em 15 — descarta os skips mais antigos", () => {
    startRadioSession("s1");
    for (let i = 0; i < 20; i++) {
      registerSkipIfEarly(`t${i}`, 1, 100);
    }
    const ids = currentSession().skippedIds;
    expect(ids.length).toBe(15);
    expect(ids[0]).toBe("t19"); // mais recente primeiro
    expect(ids).not.toContain("t0");
    expect(ids).not.toContain("t4");
    expect(ids).toContain("t5");
  });

  it("funciona mesmo sem startRadioSession prévio (gating fica a cargo do caller)", () => {
    registerSkipIfEarly("t1", 1, 100);
    expect(currentSession().skippedIds).toEqual(["t1"]);
  });
});

describe("resetRadioSession", () => {
  it("limpa stationId/contextId/seen/skipped", () => {
    startRadioSession("s1");
    registerSeen(["1"]);
    registerSkipIfEarly("t1", 1, 100);
    resetRadioSession();
    expect(currentSession()).toEqual({
      stationId: null,
      contextId: null,
      seenIds: [],
      skippedIds: [],
      lastAcceptedId: null,
    });
  });
});
