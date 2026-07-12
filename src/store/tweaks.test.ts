/* ============================================================
   tweaks.test.ts — Dirty-flag, precedência do ink e migração.

   Cobre o contrato central do themes boost: o valor do usuário só
   vale se ele tocou no knob (dirty); sem dirty, capa (adaptive) e
   tema assumem, nessa ordem. Migração de estado salvo por versão
   antiga infere dirty por diferença contra DEFAULTS.
   ============================================================ */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../tauri", () => ({
  themeVar: () => null,
  clearThemeVars: vi.fn(),
  normSetEnabled: vi.fn().mockResolvedValue(undefined),
  normSetTarget: vi.fn().mockResolvedValue(undefined),
}));

// O store lê window.__TAURI__ no top-level (invoke de list_system_fonts).
(window as any).__TAURI__ = { core: { invoke: vi.fn().mockResolvedValue([]) } };

import {
  DEFAULTS,
  loadTweaks,
  updateTweak,
  clearDirty,
  isDirty,
  setAdaptiveColor,
  tweaks,
} from "./tweaks";

const html = () => document.documentElement;

function currentInk(): string {
  return html().style.getPropertyValue("--bg-ink").trim();
}

beforeEach(() => {
  localStorage.clear();
  setAdaptiveColor(null);
  clearDirty("bgInk");
  clearDirty("lyricsGlass");
});

describe("precedência do ink", () => {
  it("sem dirty e sem capa, vale o default", () => {
    loadTweaks();
    expect(currentInk()).toBe(DEFAULTS.bgInk);
  });

  it("capa vence o default quando adaptiveInk está on", () => {
    loadTweaks();
    setAdaptiveColor("#224433");
    expect(currentInk()).toBe("#224433");
  });

  it("usuário (dirty) vence a capa", () => {
    loadTweaks();
    setAdaptiveColor("#224433");
    updateTweak("bgInk", "#101010");
    expect(isDirty("bgInk")).toBe(true);
    expect(currentInk()).toBe("#101010");
  });

  it("clearDirty devolve o controle pra capa/tema", () => {
    loadTweaks();
    setAdaptiveColor("#224433");
    updateTweak("bgInk", "#101010");
    clearDirty("bgInk");
    expect(currentInk()).toBe("#224433");
  });

  it("adaptiveInk off ignora a capa", () => {
    loadTweaks();
    updateTweak("adaptiveInk", false);
    setAdaptiveColor("#224433");
    expect(currentInk()).toBe(DEFAULTS.bgInk);
  });
});

describe("migração de estado salvo sem __dirty", () => {
  it("valor diferente do default vira dirty (preserva customização)", () => {
    localStorage.setItem("kv-tweaks", JSON.stringify({ ...DEFAULTS, lyricsGlass: 0.85 }));
    loadTweaks();
    expect(isDirty("lyricsGlass")).toBe(true);
    expect(tweaks().lyricsGlass).toBe(0.85);
  });

  it("valor igual ao default fica limpo (tema assume)", () => {
    localStorage.setItem("kv-tweaks", JSON.stringify({ ...DEFAULTS }));
    loadTweaks();
    expect(isDirty("bgInk")).toBe(false);
    expect(isDirty("lyricsGlass")).toBe(false);
  });

  it("__dirty persistido é respeitado como está", () => {
    localStorage.setItem(
      "kv-tweaks",
      JSON.stringify({ ...DEFAULTS, bgInk: "#171717", __dirty: ["bgInk"] }),
    );
    loadTweaks();
    expect(isDirty("bgInk")).toBe(true);
  });
});

describe("bgBeatSync (beat-sync do bg)", () => {
  it("default é true e applyTweaks escreve --bg-beat-sync = 1", () => {
    // Estado salvo sem o campo (versão antiga) também cai aqui: o load
    // preenche com DEFAULTS.
    localStorage.setItem("kv-tweaks", "{}");
    loadTweaks();
    expect(DEFAULTS.bgBeatSync).toBe(true);
    expect(tweaks().bgBeatSync).toBe(true);
    expect(html().style.getPropertyValue("--bg-beat-sync")).toBe("1");
  });

  it("toggle off escreve --bg-beat-sync = 0", () => {
    localStorage.setItem("kv-tweaks", "{}");
    loadTweaks();
    updateTweak("bgBeatSync", false);
    expect(html().style.getPropertyValue("--bg-beat-sync")).toBe("0");
  });

  it("estado salvo false é respeitado no boot", () => {
    localStorage.setItem("kv-tweaks", JSON.stringify({ bgBeatSync: false }));
    loadTweaks();
    expect(tweaks().bgBeatSync).toBe(false);
    expect(html().style.getPropertyValue("--bg-beat-sync")).toBe("0");
  });
});

describe("lyricsGlass regido por tema", () => {
  it("sem dirty, não escreve as vars inline (fallbacks do CSS valem)", () => {
    loadTweaks();
    expect(html().style.getPropertyValue("--lyrics-bg-alpha")).toBe("");
  });

  it("com dirty, escreve as vars derivadas do slider", () => {
    loadTweaks();
    updateTweak("lyricsGlass", 0.5);
    expect(html().style.getPropertyValue("--lyrics-bg-alpha")).not.toBe("");
  });
});
