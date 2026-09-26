/* ============================================================
   bg/GlBg.tsx — fundo WebGL do aparelho.

   O motor e as cenas são EXATAMENTE os do desktop (gl/engine.ts +
   gl/registry.ts, laço em gl/host.ts): o que muda de lado é só de
   onde vêm o sinal e a paleta.

     sinal  ← bg/spectrum.ts (SpectrumTap real, com o gerador
              sintético cobrindo até o primeiro quadro)
     paleta ← MOBILE_VARS (--bg-ink-rgb / --accent /
              --accent-dim), então a capa continua mandando na
              cor pelo mesmo applyAdaptiveColor de sempre
     beat   ← --bg-beat-mode / --bg-beat-depth do beatSetting

   DPR: o 2D usa até 1.5; aqui fica em 1. Fragment shader de tela
   cheia num painel 1440p custa caro e a diferença visual em
   campo de partículas/névoa não paga o orçamento de bateria.
   ============================================================ */

import { onCleanup, onMount } from "solid-js";
import { startGlHost } from "../../gl/host";
import { MOBILE_VARS, readGlPalette } from "../../gl/palette";
import type { BeatMode, GlCfg } from "../../gl/signal";
import { bgScene } from "./engine";
import { pumpMockFft, readFft } from "./spectrum";

const FFT_STALE_MS = 250;

/** O mobile não tem painel de gains; os pesos por banda são os defaults
    do desktop. O que o usuário controla (Beat sync) chega pelas CSS vars
    que o beatSetting escreve — mesma fonte que o motor 2D lê. */
function cfgFrom(cs: CSSStyleDeclaration): GlCfg {
  const num = (k: string, fallback: number) => {
    const v = parseFloat(cs.getPropertyValue(k));
    return Number.isFinite(v) ? v : fallback;
  };
  const modeNum = num("--bg-beat-mode", 1);
  const depth = num("--bg-beat-depth", 0.55);
  const beatMode: BeatMode = depth <= 0 ? "off" : modeNum === 2 ? "pulse" : "speed";
  return {
    bassGain: 1.0,
    midGain: 1.0,
    trebleGain: 0.8,
    smoothing: 0.3,
    speed: 1.0,
    beatMode,
    beatDepth: depth,
  };
}

export function GlBg() {
  let canvas: HTMLCanvasElement | undefined;

  onMount(() => {
    if (!canvas) return;
    // Uma chamada de getComputedStyle por amostragem serve paleta E cfg.
    let cfg: GlCfg = cfgFrom(getComputedStyle(document.documentElement));
    const bands = { low: 0, mid: 0, high: 0, fresh: false };

    const stop = startGlHost({
      canvas,
      tag: "[mobile/gl]",
      scene: bgScene,
      palette: () => {
        const cs = getComputedStyle(document.documentElement);
        cfg = cfgFrom(cs);
        return readGlPalette((n) => cs.getPropertyValue(n).trim(), MOBILE_VARS);
      },
      cfg: () => cfg,
      bands: (nowMs) => {
        const f = readFft();
        bands.low = f.low;
        bands.mid = f.mid;
        bands.high = f.high;
        bands.fresh = f.at !== 0 && nowMs - f.at < FFT_STALE_MS;
        return bands;
      },
      beforeFrame: pumpMockFft,
    });

    onCleanup(stop);
  });

  return <canvas class="app-bg__canvas" ref={canvas} />;
}
