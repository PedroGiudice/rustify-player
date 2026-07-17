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

describe("bgInkCycle (paleta alternante do bg)", () => {
  it("default é true (alternar cores da capa ligado)", () => {
    localStorage.setItem("kv-tweaks", "{}");
    loadTweaks();
    expect(DEFAULTS.bgInkCycle).toBe(true);
    expect(tweaks().bgInkCycle).toBe(true);
  });

  it("estado salvo false é respeitado no boot", () => {
    localStorage.setItem("kv-tweaks", JSON.stringify({ bgInkCycle: false }));
    loadTweaks();
    expect(tweaks().bgInkCycle).toBe(false);
  });
});

describe("bgBeatMode + bgBeatDepth (beat-sync do bg)", () => {
  it("default é mode=speed depth=0.55 e escreve as 3 vars", () => {
    // Estado salvo sem os campos (versão antiga) também cai aqui: o load
    // preenche com DEFAULTS.
    localStorage.setItem("kv-tweaks", "{}");
    loadTweaks();
    expect(DEFAULTS.bgBeatMode).toBe("speed");
    expect(DEFAULTS.bgBeatDepth).toBe(0.55);
    expect(html().style.getPropertyValue("--bg-beat-sync")).toBe("1");
    expect(html().style.getPropertyValue("--bg-beat-mode")).toBe("1");
    expect(html().style.getPropertyValue("--bg-beat-depth")).toBe("0.55");
  });

  it("mode off escreve --bg-beat-sync=0 e --bg-beat-mode=0", () => {
    localStorage.setItem("kv-tweaks", "{}");
    loadTweaks();
    updateTweak("bgBeatMode", "off");
    expect(html().style.getPropertyValue("--bg-beat-sync")).toBe("0");
    expect(html().style.getPropertyValue("--bg-beat-mode")).toBe("0");
  });

  it("mode pulse escreve --bg-beat-mode=2", () => {
    localStorage.setItem("kv-tweaks", "{}");
    loadTweaks();
    updateTweak("bgBeatMode", "pulse");
    expect(html().style.getPropertyValue("--bg-beat-sync")).toBe("1");
    expect(html().style.getPropertyValue("--bg-beat-mode")).toBe("2");
  });

  it("depth salvo é respeitado no boot", () => {
    localStorage.setItem("kv-tweaks", JSON.stringify({ bgBeatMode: "speed", bgBeatDepth: 0.85 }));
    loadTweaks();
    expect(tweaks().bgBeatDepth).toBe(0.85);
    expect(html().style.getPropertyValue("--bg-beat-depth")).toBe("0.85");
  });

  it("migra bgBeatSync=false (schema v1) pra mode off", () => {
    localStorage.setItem("kv-tweaks", JSON.stringify({ bgBeatSync: false }));
    loadTweaks();
    expect(tweaks().bgBeatMode).toBe("off");
    expect(html().style.getPropertyValue("--bg-beat-sync")).toBe("0");
  });

  it("migra bgBeatDepth=0 (schema v2, off embutido) pra mode off + depth default", () => {
    localStorage.setItem("kv-tweaks", JSON.stringify({ bgBeatDepth: 0 }));
    loadTweaks();
    expect(tweaks().bgBeatMode).toBe("off");
    expect(tweaks().bgBeatDepth).toBe(0.55);
  });

  it("bgBeatDepth>0 do schema v2 vira mode speed preservando o depth", () => {
    localStorage.setItem("kv-tweaks", JSON.stringify({ bgBeatDepth: 0.85 }));
    loadTweaks();
    expect(tweaks().bgBeatMode).toBe("speed");
    expect(tweaks().bgBeatDepth).toBe(0.85);
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
