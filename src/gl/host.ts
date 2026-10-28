/* ============================================================
   gl/host.ts — o laço que hospeda o motor WebGL2 num canvas.

   Desktop (components/GlBackground.tsx) e mobile (mobile/bg/GlBg.tsx)
   diferem só em DE ONDE vêm o sinal, a paleta e a configuração; o
   resto é igual e mora aqui:
     - cria o motor e a cena; qualquer falha (sem WebGL2, shader que
       não compila, contexto perdido) vira glStatus.ok = false e o
       App reassume o 2D — tela preta nunca;
     - paleta: alvo amostrado a ~3 Hz, corrente interpolada por quadro
       (lerp local; animar custom property no :root é proibido). O tau
       do lerp segue --bg-ink-morph, como no 2D: troca de faixa responde
       em ~1 s, o ciclo da paleta da capa (bgInkCycle) migra em ~10 s;
     - transição: a cena entra por dissolução (gl/engine.ts) quando
       `transitions()` permite — a medição de cenas troca seco;
     - modo: focused/ambient lido por quadro e entregue ao motor, que
       desfoca o ambient na GPU (gl/ambient.ts); sem `mode`, focused;
     - sinal: gl/signal.ts por quadro;
     - fps medido 1x/s em glStatus (o gate da feature) e a cena de
       fato montada em glActiveScene (a medição espera por ela).
   ============================================================ */

import { GlEngine } from "./engine";
import type { BgMode } from "./ambient";
import { setGlActiveScene, setGlStatus, type SceneKey } from "./meta";
import type { GlPalette, Rgb } from "./palette";
import { createGlSignal, stepGlSignal, type FftBands, type GlCfg } from "./signal";
import { stepRgbLerp } from "../lib/rgbLerp";

/** Tau (s) padrão do morph de cor — mesmo do SpectrumCanvas: troca de
    faixa responde rápido. O ciclo da paleta anuncia um tau longo em
    --bg-ink-morph (lib/adaptiveInk.ts) e o host o segue (morphTau). */
export const INK_TAU = 0.35;
/** Teto do tau lido (s): valor estranho na var nunca congela a cor. */
const INK_TAU_MAX = 10;

/** Tau efetivo do morph: o anunciado, se for um número válido; senão o padrão. */
export function inkMorphTau(raw: number | null | undefined): number {
  return typeof raw === "number" && raw > 0 && raw <= INK_TAU_MAX ? raw : INK_TAU;
}

/** De quantos em quantos quadros reamostrar as CSS vars (getComputedStyle
    é caro; ~3x/s basta e é a cadência que o 2D já usa). */
const VAR_SAMPLE_EVERY = 20;

export interface GlHostOptions {
  canvas: HTMLCanvasElement;
  /** Prefixo dos logs ("[gl]", "[mobile/gl]"). */
  tag: string;
  /** Cena desejada, lida por quadro. */
  scene: () => SceneKey;
  /** Paleta alvo, lida a ~3 Hz (getComputedStyle agrupado). */
  palette: () => GlPalette;
  /** Configuração do sinal, lida por quadro. */
  cfg: () => GlCfg;
  /** Bandas do FFT e se o stream está vivo, lidas por quadro. */
  bands: (nowMs: number) => FftBands & { fresh: boolean };
  /** Gancho no início de cada quadro (o mock de FFT do mobile). */
  beforeFrame?: () => void;
  /** Tau (s) anunciado para o morph de cor, lido junto da paleta (~3 Hz).
      Ausente ou inválido = INK_TAU. */
  morphTau?: () => number | null;
  /** Troca de cena com dissolução? Ausente = sempre. */
  transitions?: () => boolean;
  /** Versão calma (reduzir animação): a transição só dissolve. */
  calm?: () => boolean;
  /** Modo do fundo, lido por quadro (desktop: focused no Now Playing e
      no cinema, ambient no resto). Ausente = focused (mobile). */
  mode?: () => BgMode;
}

/** Sobe o motor no canvas. Devolve a função de desmonte. */
export function startGlHost(o: GlHostOptions): () => void {
  let engine: GlEngine | null = null;
  let raf = 0;
  let ro: ResizeObserver | null = null;
  let stopped = false;
  let renderer = "";

  const fail = (msg: string, e?: unknown) => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(raf);
    setGlActiveScene(null);
    setGlStatus({ ok: false, renderer, error: msg, fps: 0 });
    console.error(`${o.tag} fundo WebGL caiu para o 2D:`, e ?? msg);
  };

  try {
    engine = new GlEngine(o.canvas, { onLost: (reason) => fail(reason) });
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e), e);
    return () => {};
  }
  const eng = engine;
  renderer = eng.rendererName();

  const mountScene = (key: SceneKey): boolean => {
    try {
      eng.setScene(key, o.transitions ? o.transitions() : true);
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e), e);
      return false;
    }
    return true;
  };

  let tgt = o.palette();
  const cur: GlPalette = {
    canvas: { ...tgt.canvas },
    ink: { ...tgt.ink },
    ink2: { ...tgt.ink2 },
    soft: { ...tgt.soft },
  };
  eng.setPalette(cur);
  let inkTau = inkMorphTau(o.morphTau?.());

  const measure = () => {
    const r = o.canvas.getBoundingClientRect();
    try {
      eng.resize(Math.round(r.width), Math.round(r.height));
    } catch (e) {
      fail(e instanceof Error ? e.message : String(e), e);
    }
  };
  measure();
  ro = new ResizeObserver(measure);
  ro.observe(o.canvas);

  if (stopped || !mountScene(o.scene())) return () => teardown();
  setGlStatus({ ok: true, renderer, error: "", fps: 0 });
  setGlActiveScene(eng.sceneKey);

  const sig = createGlSignal();
  let lastMs = performance.now();
  let tick = 0;
  let frames = 0;
  let acc = 0;

  function frame() {
    if (stopped) return;
    raf = requestAnimationFrame(frame);
    if (document.hidden || !o.canvas.isConnected) return;
    o.beforeFrame?.();

    const nowMs = performance.now();
    const dt = Math.max(0, Math.min(0.1, (nowMs - lastMs) * 0.001));
    lastMs = nowMs;

    if (++tick % VAR_SAMPLE_EVERY === 0) {
      tgt = o.palette();
      inkTau = inkMorphTau(o.morphTau?.());
    }
    stepRgbLerp(cur.canvas as Rgb, tgt.canvas, dt, inkTau);
    stepRgbLerp(cur.ink as Rgb, tgt.ink, dt, inkTau);
    stepRgbLerp(cur.ink2 as Rgb, tgt.ink2, dt, inkTau);
    stepRgbLerp(cur.soft as Rgb, tgt.soft, dt, inkTau);
    eng.setPalette(cur);

    const b = o.bands(nowMs);
    const cfg = o.cfg();
    stepGlSignal(sig, dt, b.fresh, b, cfg);
    // Calma ou Speed = 0: a transição não avança o retrato.
    const calm = o.calm?.() ?? false;
    const still = calm || !(cfg.speed > 0);
    // A troca de modo só depende da calma: Speed = 0 para a cena, não
    // a interface.
    eng.setMode(o.mode?.() ?? "focused", calm);

    const want = o.scene();
    if (eng.sceneKey !== want) {
      if (!mountScene(want)) return;
      setGlActiveScene(eng.sceneKey);
    }
    try {
      eng.frame(sig, dt, still);
    } catch (e) {
      // Erro de cena em tempo de execução: 2D em vez de imagem congelada.
      fail(e instanceof Error ? e.message : String(e), e);
      return;
    }

    frames++;
    acc += dt;
    if (acc >= 1) {
      const fps = Math.round(frames / acc);
      frames = 0;
      acc = 0;
      // Reafirma ok/renderer junto do fps: quem zerou o status (medição,
      // religar o motor) vê o motor vivo de novo em até 1 s.
      setGlStatus((s) =>
        s.ok === true && s.fps === fps && s.renderer === renderer ? s : { ok: true, renderer, error: "", fps },
      );
    }
  }
  raf = requestAnimationFrame(frame);

  function teardown() {
    stopped = true;
    cancelAnimationFrame(raf);
    ro?.disconnect();
    setGlActiveScene(null);
    eng.dispose();
  }
  return teardown;
}
