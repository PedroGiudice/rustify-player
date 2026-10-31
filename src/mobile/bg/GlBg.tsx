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

     calma  ← motion.ts: "Remover animações" do Android liga a versão
              calma do desktop (calmGlCfg + calm + reduced), A53
     modo   ← focused no Now Playing, ambient no resto: o desfoque do
              ambient sai da GPU (gl/ambient.ts), não de filter CSS de
              tela cheia sobre o canvas (A55, B6 do desktop). Montado, o
              wrapper leva data-engine="webgl" e o CSS do ambient (só do
              2D) não vale; o ganho mistura com --s-base, a base do S24.

   DPR: o 2D usa até 1.5; aqui fica em 1. Fragment shader de tela
   cheia num painel 1440p custa caro e a diferença visual em
   campo de partículas/névoa não paga o orçamento de bateria.
   ============================================================ */

import { onCleanup, onMount } from "solid-js";
import { startGlHost } from "../../gl/host";
import { MOBILE_VARS, readGlPalette, type PaletteVars } from "../../gl/palette";
import { calmGlCfg, type BeatMode, type GlCfg } from "../../gl/signal";
import { isNpOpen } from "../nav";
import { reducedMotion } from "../motion";
import { bgScene } from "./engine";
import { pumpMockFft, readFft } from "./spectrum";

const FFT_STALE_MS = 250;

/** Paleta do S24 com o fundo atrás do canvas: a base do .device. */
const VARS: PaletteVars = { ...MOBILE_VARS, back: ["--s-base"] };

/** O mobile não tem painel de gains; os pesos por banda são os defaults
    do desktop. O que o usuário controla (Beat sync) chega pelas CSS vars
    que o beatSetting escreve — mesma fonte que o motor 2D lê. */
function cfgFrom(cs: CSSStyleDeclaration, reduced: boolean): GlCfg {
  const num = (k: string, fallback: number) => {
    const v = parseFloat(cs.getPropertyValue(k));
    return Number.isFinite(v) ? v : fallback;
  };
  const modeNum = num("--bg-beat-mode", 1);
  const depth = num("--bg-beat-depth", 0.55);
  const beatMode: BeatMode = depth <= 0 ? "off" : modeNum === 2 ? "pulse" : "speed";
  const cfg: GlCfg = {
    bassGain: 1.0,
    midGain: 1.0,
    trebleGain: 0.8,
    smoothing: 0.3,
    speed: 1.0,
    beatMode,
    beatDepth: depth,
  };
  return reduced ? calmGlCfg(cfg) : cfg;
}

export function GlBg() {
  let canvas: HTMLCanvasElement | undefined;

  onMount(() => {
    if (!canvas) return;
    const wrapper = canvas.parentElement;
    wrapper?.setAttribute("data-engine", "webgl");
    // Uma chamada de getComputedStyle por amostragem serve paleta E cfg.
    let cfg: GlCfg = cfgFrom(getComputedStyle(document.documentElement), reducedMotion());
    const bands = { low: 0, mid: 0, high: 0, fresh: false };

    const stop = startGlHost({
      canvas,
      tag: "[mobile/gl]",
      scene: bgScene,
      palette: () => {
        const cs = getComputedStyle(document.documentElement);
        cfg = cfgFrom(cs, reducedMotion());
        return readGlPalette((n) => cs.getPropertyValue(n).trim(), VARS);
      },
      cfg: () => cfg,
      calm: reducedMotion,
      reduced: reducedMotion,
      mode: () => (isNpOpen() ? "focused" : "ambient"),
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

    onCleanup(() => {
      stop();
      wrapper?.removeAttribute("data-engine");
    });
  });

  return <canvas class="app-bg__canvas" ref={canvas} />;
}
