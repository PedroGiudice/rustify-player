/* ============================================================
   tweaks.test.ts — Dirty-flag, precedência do ink e migração.

   Cobre o contrato central do themes boost: o valor do usuário só
   vale se ele tocou no knob (dirty); sem dirty, capa (adaptive) e
   tema assumem, nessa ordem. Migração de estado salvo por versão
   antiga infere dirty por diferença contra DEFAULTS.
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Vars do "tema ativo" que o themeVar do mock devolve (vazio = sem tema).
const themeVars = vi.hoisted(() => ({}) as Record<string, string>);

vi.mock("../tauri", () => ({
  themeVar: (name: string) => themeVars[name] ?? null,
  clearThemeVars: vi.fn(),
  normSetEnabled: vi.fn().mockResolvedValue(undefined),
  normSetTarget: vi.fn().mockResolvedValue(undefined),
}));

// O store lê window.__TAURI__ no top-level (invoke de list_system_fonts).
(window as any).__TAURI__ = { core: { invoke: vi.fn().mockResolvedValue([]) } };

import {
  DEFAULTS,
  applyTweaks,
  bgKnobs,
  flushTweaks,
  loadTweaks,
  updateTweak,
  clearDirty,
  isDirty,
  resetTweaks,
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
    flushTweaks();
    expect(isDirty("bgInk")).toBe(true);
    expect(currentInk()).toBe("#101010");
  });

  it("clearDirty devolve o controle pra capa/tema", () => {
    loadTweaks();
    setAdaptiveColor("#224433");
    updateTweak("bgInk", "#101010");
    clearDirty("bgInk");
    flushTweaks();
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
  // Desde o cfg-15 os knobs do fundo não vão mais pro :root (nenhum CSS os
  // lê): o SpectrumCanvas lê do store via bgKnobs. A tradução para os
  // números que o frame loop consome é a mesma das antigas vars.
  it("default é mode=speed depth=0.55: gate 1, modo 1", () => {
    // Estado salvo sem os campos (versão antiga) também cai aqui: o load
    // preenche com DEFAULTS.
    localStorage.setItem("kv-tweaks", "{}");
    loadTweaks();
    expect(DEFAULTS.bgBeatMode).toBe("speed");
    expect(DEFAULTS.bgBeatDepth).toBe(0.55);
    const k = bgKnobs(tweaks());
    expect([k.beatSync, k.beatMode, k.beatDepth]).toEqual([1, 1, 0.55]);
  });

  it("mode off vira gate 0 e modo 0", () => {
    const k = bgKnobs({ ...DEFAULTS, bgBeatMode: "off" });
    expect([k.beatSync, k.beatMode]).toEqual([0, 0]);
  });

  it("mode pulse vira gate 1 e modo 2", () => {
    const k = bgKnobs({ ...DEFAULTS, bgBeatMode: "pulse" });
    expect([k.beatSync, k.beatMode]).toEqual([1, 2]);
  });

  it("ganhos, smoothing e velocidade passam direto", () => {
    const k = bgKnobs({ ...DEFAULTS, bgBassGain: 1.7, bgMidGain: 0.4, bgTrebleGain: 2, bgSmoothing: 0.9, bgSpeed: 0.5 });
    expect(k).toMatchObject({ bassGain: 1.7, midGain: 0.4, trebleGain: 2, smoothing: 0.9, speed: 0.5 });
  });

  it("depth salvo é respeitado no boot", () => {
    localStorage.setItem("kv-tweaks", JSON.stringify({ bgBeatMode: "speed", bgBeatDepth: 0.85 }));
    loadTweaks();
    expect(tweaks().bgBeatDepth).toBe(0.85);
    expect(bgKnobs(tweaks()).beatDepth).toBe(0.85);
  });

  it("migra bgBeatSync=false (schema v1) pra mode off", () => {
    localStorage.setItem("kv-tweaks", JSON.stringify({ bgBeatSync: false }));
    loadTweaks();
    expect(tweaks().bgBeatMode).toBe("off");
    expect(bgKnobs(tweaks()).beatSync).toBe(0);
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

  it("os knobs do fundo não são escritos no :root", () => {
    localStorage.setItem("kv-tweaks", "{}");
    loadTweaks();
    for (const name of [
      "--bg-bass-gain", "--bg-mid-gain", "--bg-treble-gain", "--bg-smoothing",
      "--bg-speed", "--bg-beat-sync", "--bg-beat-mode", "--bg-beat-depth",
    ]) {
      expect(html().style.getPropertyValue(name)).toBe("");
    }
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
    flushTweaks();
    expect(html().style.getPropertyValue("--lyrics-bg-alpha")).not.toBe("");
  });

  // np-18: com a seção lyrics no YAML, o applyTheme escreve --lyrics-* no
  // inline; sem dirty, o applyTweaks fazia removeProperty e matava o valor
  // do tema — o "↺ tema" voltava pra constante do CSS, não pro tema.
  it("sem dirty, restaura as vars de lyrics que o tema declarou", () => {
    themeVars["--lyrics-bg-alpha"] = "0.4";
    themeVars["--lyrics-bg-brightness"] = "0.7";
    try {
      loadTweaks();
      updateTweak("lyricsGlass", 0.9);
      clearDirty("lyricsGlass");
      flushTweaks();
      applyTweaks();
      expect(html().style.getPropertyValue("--lyrics-bg-alpha")).toBe("0.4");
      expect(html().style.getPropertyValue("--lyrics-bg-brightness")).toBe("0.7");
    } finally {
      delete themeVars["--lyrics-bg-alpha"];
      delete themeVars["--lyrics-bg-brightness"];
    }
  });
});

// config-v4: o Mono funciona por html[data-type="mono"] { --font-sans:
// var(--font-mono) }, mas a UI Font escolhida (ou a fonte do tema) grava
// --font-sans no style inline, que vence qualquer regra de folha: marcar
// Mono não mudava nada na tela.
describe("Type Mono", () => {
  it("vence a UI Font escolhida e devolve a fonte ao voltar pra Sans", () => {
    resetTweaks();
    loadTweaks();
    updateTweak("fontUI", "Foo Sans");
    updateTweak("type", "mono");
    flushTweaks();
    expect(html().style.getPropertyValue("--font-sans")).toBe("var(--font-mono)");
    updateTweak("type", "body");
    flushTweaks();
    expect(html().style.getPropertyValue("--font-sans")).toContain('"Foo Sans"');
    resetTweaks();
  });

  it("segue valendo depois que um tema é aplicado", () => {
    resetTweaks();
    loadTweaks();
    updateTweak("type", "mono");
    flushTweaks();
    html().style.setProperty("--font-sans", '"Tema Sans", sans-serif');
    window.dispatchEvent(new CustomEvent("rustify:theme-applied", { detail: { ink: null } }));
    expect(html().style.getPropertyValue("--font-sans")).toBe("var(--font-mono)");
    resetTweaks();
  });
});

// cfg-15: cada evento de input do slider rodava o applyTweaks inteiro
// (custom properties herdadas no :root = restyle da árvore) e gravava o
// kv-tweaks (JSON.stringify + setItem síncrono). Agora: escrita das vars
// agrupada por quadro (rAF) e gravação com debounce.
describe("arrasto de slider (cfg-15)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("vários inputs no mesmo quadro escrevem a var uma vez, com o valor final", () => {
    flushTweaks(); // quadro/timer reais pendentes de testes anteriores
    vi.useFakeTimers();
    resetTweaks();
    loadTweaks();
    flushTweaks();
    const spy = vi.spyOn(html().style, "setProperty");
    for (const v of [0.3, 0.4, 0.5, 0.6, 0.7]) updateTweak("glow", v);
    const writes = () => spy.mock.calls.filter(([k]) => k === "--glow");
    expect(writes()).toHaveLength(0);
    vi.advanceTimersByTime(20);
    expect(writes()).toEqual([["--glow", "0.7"]]);
    spy.mockRestore();
    clearDirty("glow");
    flushTweaks();
  });

  // Metade que faltava do cfg-15: mesmo agrupado por quadro, cada quadro do
  // arrasto reescrevia ~25 custom properties herdadas no :root (fontes,
  // glow, vidro, ink, accent e os 8 knobs do fundo), mudassem ou não.
  it("arrastar um knob do fundo não escreve custom property nenhuma no :root", () => {
    flushTweaks(); // quadro/timer reais pendentes de testes anteriores
    vi.useFakeTimers();
    resetTweaks();
    loadTweaks();
    flushTweaks();
    const set = vi.spyOn(html().style, "setProperty");
    const rm = vi.spyOn(html().style, "removeProperty");
    try {
      for (const v of [0.5, 0.8, 1.3]) {
        updateTweak("bgSpeed", v);
        vi.advanceTimersByTime(20);
      }
      expect(set).not.toHaveBeenCalled();
      expect(rm).not.toHaveBeenCalled();
    } finally {
      set.mockRestore();
      rm.mockRestore();
    }
  });

  it("um knob que o CSS consome escreve só a própria var", () => {
    flushTweaks(); // quadro/timer reais pendentes de testes anteriores
    vi.useFakeTimers();
    resetTweaks();
    loadTweaks();
    flushTweaks();
    const set = vi.spyOn(html().style, "setProperty");
    try {
      updateTweak("lyricsGlass", 0.5);
      vi.advanceTimersByTime(20);
      expect(set.mock.calls.map(([k]) => k).sort()).toEqual(["--lyrics-bg-alpha", "--lyrics-bg-brightness"]);
    } finally {
      set.mockRestore();
      clearDirty("lyricsGlass");
      flushTweaks();
    }
  });

  // Sem tema ativo, resolver o ink lia o canvas por getComputedStyle — a
  // cada quadro do arrasto de qualquer slider, com o :root recém-escrito.
  it("arrastar um knob sem tema ativo não chama getComputedStyle", () => {
    flushTweaks(); // quadro/timer reais pendentes de testes anteriores
    vi.useFakeTimers();
    resetTweaks();
    loadTweaks();
    flushTweaks();
    const gcs = vi.spyOn(window, "getComputedStyle");
    try {
      for (const v of [0.5, 0.8, 1.3]) {
        updateTweak("bgBassGain", v);
        vi.advanceTimersByTime(20);
      }
      expect(gcs).not.toHaveBeenCalled();
    } finally {
      gcs.mockRestore();
    }
  });

  it("não avisa (rustify:tweaks-applied) quando as vars do vidro não mudaram", () => {
    flushTweaks(); // quadro/timer reais pendentes de testes anteriores
    vi.useFakeTimers();
    resetTweaks();
    loadTweaks();
    flushTweaks();
    const onApplied = vi.fn();
    window.addEventListener("rustify:tweaks-applied", onApplied);
    try {
      for (const v of [0.5, 0.8, 1.3]) {
        updateTweak("bgMidGain", v);
        vi.advanceTimersByTime(20);
      }
    } finally {
      window.removeEventListener("rustify:tweaks-applied", onApplied);
    }
    expect(onApplied).not.toHaveBeenCalled();
  });

  it("grava o kv-tweaks uma vez depois que o arrasto para", () => {
    flushTweaks(); // quadro/timer reais pendentes de testes anteriores
    vi.useFakeTimers();
    resetTweaks();
    loadTweaks();
    flushTweaks();
    const spy = vi.spyOn(Storage.prototype, "setItem");
    const saves = () => spy.mock.calls.filter(([k]) => k === "kv-tweaks");
    for (const v of [0.5, 0.6, 0.7]) {
      updateTweak("bgSpeed", v);
      vi.advanceTimersByTime(20);
    }
    expect(saves()).toHaveLength(0);
    vi.advanceTimersByTime(1000);
    expect(saves()).toHaveLength(1);
    expect(JSON.parse(saves()[0][1] as string).bgSpeed).toBe(0.7);
    spy.mockRestore();
  });

  // Integração com o np-2: o card de letras do NowPlaying mede as vars do
  // vidro num rAF próprio, e a ordem entre esse rAF e o daqui depende da
  // ordem dos observadores do signal, que o Solid embaralha a cada
  // re-execução — a medição chegava a ler o passo anterior do slider.
  // applyTweaks avisa, DEPOIS de escrever, quem precisa medir.
  it("avisa (rustify:tweaks-applied) depois de escrever as vars do vidro, a cada quadro", () => {
    flushTweaks(); // quadro/timer reais pendentes de testes anteriores
    vi.useFakeTimers();
    resetTweaks();
    loadTweaks();
    flushTweaks();
    const seen: string[] = [];
    const onApplied = () => seen.push(html().style.getPropertyValue("--lyrics-bg-alpha"));
    window.addEventListener("rustify:tweaks-applied", onApplied);
    try {
      for (const g of [0.1, 0.4, 0.7]) {
        updateTweak("lyricsGlass", g);
        vi.advanceTimersByTime(20);
      }
    } finally {
      window.removeEventListener("rustify:tweaks-applied", onApplied);
    }
    expect(seen).toEqual(["0.101", "0.284", "0.467"]);
  });

  it("flushTweaks aplica e grava o pendente na hora (fechar a janela)", () => {
    flushTweaks(); // quadro/timer reais pendentes de testes anteriores
    vi.useFakeTimers();
    resetTweaks();
    loadTweaks();
    flushTweaks();
    updateTweak("glow", 0.6);
    flushTweaks();
    expect(html().style.getPropertyValue("--glow")).toBe("0.6");
    expect(JSON.parse(localStorage.getItem("kv-tweaks")!).glow).toBe(0.6);
    clearDirty("glow");
    flushTweaks();
  });
});
