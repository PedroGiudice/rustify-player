/* ============================================================
   bg/GlBg.tsx — fundo WebGL do aparelho.

   As cenas são EXATAMENTE as do desktop (src/gl/scenes.ts): o
   que muda de lado é só de onde vêm o sinal e a paleta.

     sinal  ← bg/spectrum.ts (SpectrumTap real, com o gerador
              sintético cobrindo até o primeiro quadro)
     paleta ← MOBILE_VARS (--s-base / --bg-ink-rgb / --accent /
              --accent-dim), então a capa continua mandando na
              cor pelo mesmo applyAdaptiveColor de sempre
     beat   ← --bg-beat-mode / --bg-beat-depth do beatSetting

   DPR: o 2D usa até 1.5; aqui fica em 1. Fragment shader de tela
   cheia num painel 1440p custa caro e a diferença visual em
   campo de partículas/névoa não paga o orçamento de bateria.
   ============================================================ */

import { onCleanup, onMount } from "solid-js";
import { GlStage } from "../../gl/scenes";
import { setGlStatus } from "../../gl/meta";
import { MOBILE_VARS, readGlPalette, type GlPalette, type Rgb } from "../../gl/palette";
import { createGlSignal, stepGlSignal, type BeatMode, type GlCfg } from "../../gl/signal";
import { stepRgbLerp } from "../../lib/rgbLerp";
import { bgScene } from "./engine";
import { pumpMockFft, readFft } from "./spectrum";

const FFT_STALE_MS = 250;
const INK_TAU = 0.35;
const VAR_SAMPLE_EVERY = 20;

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
    let stage: GlStage;
    try {
      stage = new GlStage(canvas, bgScene());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setGlStatus({ ok: false, renderer: "", error: msg, fps: 0 });
      console.error("[mobile/gl] contexto WebGL indisponível:", e);
      return;
    }
    setGlStatus({ ok: true, renderer: stage.rendererName(), error: "", fps: 0 });

    // Uma chamada de getComputedStyle por amostragem serve paleta E cfg.
    let tgt: GlPalette = readGlPalette(
      (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim(),
      MOBILE_VARS,
    );
    let cfg: GlCfg = cfgFrom(getComputedStyle(document.documentElement));
    const sample = () => {
      const cs = getComputedStyle(document.documentElement);
      tgt = readGlPalette((n) => cs.getPropertyValue(n).trim(), MOBILE_VARS);
      cfg = cfgFrom(cs);
    };

    const cur: GlPalette = {
      canvas: { ...tgt.canvas },
      ink: { ...tgt.ink },
      ink2: { ...tgt.ink2 },
      soft: { ...tgt.soft },
    };
    stage.setPalette(cur);

    const el = canvas;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      stage.resize(Math.round(r.width), Math.round(r.height), 1);
    });
    ro.observe(el);
    const r0 = el.getBoundingClientRect();
    stage.resize(Math.round(r0.width), Math.round(r0.height), 1);

    const sig = createGlSignal();
    let lastMs = performance.now();
    let tick = 0;
    let frames = 0;
    let acc = 0;
    let raf = requestAnimationFrame(function frame() {
      raf = requestAnimationFrame(frame);
      if (document.hidden || !el.isConnected) return;

      pumpMockFft();

      const nowMs = performance.now();
      const dt = Math.max(0, Math.min(0.1, (nowMs - lastMs) * 0.001));
      lastMs = nowMs;

      if (++tick % VAR_SAMPLE_EVERY === 0) sample();
      stepRgbLerp(cur.canvas as Rgb, tgt.canvas, dt, INK_TAU);
      stepRgbLerp(cur.ink as Rgb, tgt.ink, dt, INK_TAU);
      stepRgbLerp(cur.ink2 as Rgb, tgt.ink2, dt, INK_TAU);
      stepRgbLerp(cur.soft as Rgb, tgt.soft, dt, INK_TAU);
      stage.setPalette(cur);

      const f = readFft();
      const fresh = f.at !== 0 && nowMs - f.at < FFT_STALE_MS;
      stepGlSignal(sig, dt, fresh, f, cfg);

      stage.setScene(bgScene());
      stage.frame(sig, dt);

      frames++;
      acc += dt;
      if (acc >= 1) {
        const fps = Math.round(frames / acc);
        frames = 0;
        acc = 0;
        setGlStatus((s) => (s.fps === fps ? s : { ...s, fps }));
      }
    });

    onCleanup(() => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      stage.dispose();
    });
  });

  return <canvas class="app-bg__canvas" ref={canvas} />;
}
