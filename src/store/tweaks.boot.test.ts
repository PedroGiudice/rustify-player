/* ============================================================
   tweaks.boot.test.ts — regressão do clobber de boot (auditoria).

   createEffect em module-level roda SÍNCRONO no import; sem o gate
   _loaded, o effect salvava DEFAULTS por cima do kv-tweaks ANTES
   de loadTweaks() rodar — nenhum tweak sobrevivia a restart. Este
   arquivo importa o módulo DINAMICAMENTE depois de semear o
   storage, reproduzindo a ordem real do boot (import graph →
   render → loadTweaks). Os testes de tweaks.test.ts não pegam
   porque semeiam DEPOIS do import estático.
   ============================================================ */

import { describe, it, expect, vi } from "vitest";

vi.mock("../tauri", () => ({
  themeVar: () => null,
  clearThemeVars: vi.fn(),
  normSetEnabled: vi.fn().mockResolvedValue(undefined),
  normSetTarget: vi.fn().mockResolvedValue(undefined),
}));

(window as any).__TAURI__ = { core: { invoke: vi.fn().mockResolvedValue([]) } };

describe("boot: import do módulo não clobbera kv-tweaks", () => {
  it("estado persistido sobrevive ao import e é carregado pelo loadTweaks", async () => {
    localStorage.setItem(
      "kv-tweaks",
      JSON.stringify({ glow: 0.9, bgInk: "#123456", loudnessTarget: -8, __dirty: ["bgInk"] }),
    );

    // Ordem real: módulo avaliado (effects top-level rodam) ANTES do load.
    const mod = await import("./tweaks");

    const raw = JSON.parse(localStorage.getItem("kv-tweaks")!);
    expect(raw.glow).toBe(0.9);
    expect(raw.loudnessTarget).toBe(-8);
    expect(raw.__dirty).toContain("bgInk");

    mod.loadTweaks();
    expect(mod.tweaks().glow).toBe(0.9);
    expect(mod.tweaks().loudnessTarget).toBe(-8);
    expect(mod.isDirty("bgInk")).toBe(true);
    // glow != default e ausente do __dirty antigo: inferência marca dirty
    // (chave virou theme-governed depois do estado ter sido salvo).
    expect(mod.isDirty("glow")).toBe(true);
  });
});
