/* ============================================================
   components/SpectrumCanvas.tsx — Carbon-on-paper animated bg.

   Background global do app (mora no .app-bg, monta UMA vez).
   Animação base: shape + breath + drift + fase temporal — roda
   sempre, mesmo sem áudio. É bg, não visualizer.

   Reatividade à música: consome 3 envelope followers do payload
   audio-fft (já com smoothing assimétrico aplicado no Rust em
   pw_capture.rs):
     - low_band_mag   (20-200 Hz)
     - mid_band_mag   (200-2 000 Hz)
     - high_band_mag  (2 000-12 000 Hz)

   O peso de cada banda é controlado por Tweaks via CSS vars
   --bg-bass-gain / --bg-mid-gain / --bg-treble-gain (0..2). O
   smoothing final no canvas (decay quando FFT para) sai de
   --bg-smoothing (0..1 → tau em ENV_TAU_MIN..ENV_TAU_MAX).

   Regra crítica: o envelope só modula amplitude. NUNCA toca em
   fase nem em ink density — caso contrário vira screensaver.

   Tinta puxada da CSS var --bg-ink-rgb (Tweaks panel). Default
   carbono 23, 23, 23; alpha por renderer (renderers.ts).

   Duas camadas independentes que se multiplicam:
     shape (shapes.ts)      = campo escalar fn(u,v,t) — "o quê"
     renderer (renderers.ts) = estratégia de pintura — "como"
   O frame loop só despacha RENDERERS[idx].fn(...). Trocar shape
   ou renderer nunca remonta o canvas — muda um índice reativo.

   Shape/renderer persistem em localStorage via useShape() /
   useRenderer().
   ============================================================ */

import { createSignal, onCleanup, onMount } from "solid-js";
import { SHAPES } from "../shapes";
import { RENDERERS } from "../renderers";
import { onAudioFft, spectrumSubscribe, type FftPayload } from "../tauri";

const SHAPE_KEY = "rustify-mock-shape";
const RENDER_KEY = "rustify-mock-renderer";

/** Tempo (ms) sem frame de FFT antes de considerar stream parado. */
const FFT_STALE_MS = 250;

/** Quanto o envelope contínuo modula amplitude (1 + ENV_GAIN * env). */
const ENV_GAIN = 0.5;

/** Limites de tau (s) para o decay do envelope. Mapeados pelo slider
    bgSmoothing dos Tweaks: 0 → ENV_TAU_MIN (resposta crua), 1 → ENV_TAU_MAX
    (bem suave). Default em store/tweaks.ts é 0.3 → tau ≈ 310 ms. */
const ENV_TAU_MIN = 0.1;
const ENV_TAU_MAX = 0.8;

export interface SpectrumCanvasProps {
  /** Class extra no <canvas>. */
  class?: string;
}

/** Índice salvo em localStorage, normalizado pro range da lista. */
function loadInitialIdx(key: string, len: number): number {
  try {
    const raw = parseInt(localStorage.getItem(key) ?? "0", 10);
    if (Number.isFinite(raw)) return ((raw % len) + len) % len;
  } catch {}
  return 0;
}

/** Reactive shape index — components can read+update this. */
const [shapeIdx, setShapeIdx] = createSignal<number>(loadInitialIdx(SHAPE_KEY, SHAPES.length));

/** Reactive renderer index — default 0 (mesh) preserva o visual antigo. */
const [renderIdx, setRenderIdx] = createSignal<number>(loadInitialIdx(RENDER_KEY, RENDERERS.length));

export function useShape() {
  return {
    idx: shapeIdx,
    name: () => SHAPES[shapeIdx()].name,
    set: (n: number) => {
      const i = ((n % SHAPES.length) + SHAPES.length) % SHAPES.length;
      setShapeIdx(i);
      try { localStorage.setItem(SHAPE_KEY, String(i)); } catch {}
    },
    next: () => useShape().set(shapeIdx() + 1),
    prev: () => useShape().set(shapeIdx() - 1),
    count: SHAPES.length,
  };
}

export function useRenderer() {
  return {
    idx: renderIdx,
    name: () => RENDERERS[renderIdx()].name,
    set: (n: number) => {
      const i = ((n % RENDERERS.length) + RENDERERS.length) % RENDERERS.length;
      setRenderIdx(i);
      try { localStorage.setItem(RENDER_KEY, String(i)); } catch {}
    },
    next: () => useRenderer().set(renderIdx() + 1),
    prev: () => useRenderer().set(renderIdx() - 1),
    count: RENDERERS.length,
  };
}

export function SpectrumCanvas(props: SpectrumCanvasProps) {
  let canvas!: HTMLCanvasElement;
  let raf = 0;

  // Relógio virtual da animação. Avança como `dt * bgSpeed` a cada
  // frame, em vez de `(now - t0)`. Assim, mudar bgSpeed no Tweaks
  // afeta só a derivada (rotação freia / acelera in-place) sem o
  // salto de fase que aconteceria se recomputássemos t do zero.
  let bgClock = 0;

  // Estado vivo dos 3 envelopes vindos do backend. Atualizados
  // pelo listener de `audio-fft`. Fora de signal de propósito —
  // frame loop não precisa de reatividade Solid, só do snapshot.
  let lastLow = 0;
  let lastMid = 0;
  let lastHigh = 0;
  let lastFftAt = 0;

  // Envelope suavizado final — converge pro target via exp decay.
  // Garante que pause / FFT stale produza fade gradual.
  let smoothedEnv = 0;
  let lastFrameMs = performance.now();

  // Cor da tinta + ganhos por banda + smoothing. Lidos das CSS
  // vars que Tweaks escreve no <html> (~3x/s, sem listener).
  let inkRgb = "23, 23, 23";
  let bassGain = 1.0;
  let midGain = 1.0;
  let trebleGain = 0.8;
  let smoothing = 0.3;
  let speed = 1.0;
  let cfgCheckTick = 0;

  // Cleanup do listener de FFT.
  let unlistenFft: (() => void) | undefined;

  onMount(() => {
    const ctx = canvas.getContext("2d")!;
    let w = 0, h = 0, dpr = 1;

    function resize() {
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      const r = canvas.getBoundingClientRect();
      w = Math.max(1, r.width);
      h = Math.max(1, r.height);
      canvas.width  = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }
    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    // Subscribe ao audio-fft. Quando ativo, alimenta os 3 envelopes.
    // Fallback pra 0 se um campo vier ausente (payloads antigos).
    onAudioFft((payload: FftPayload) => {
      lastLow  = payload.low_band_mag ?? 0;
      lastMid  = payload.mid_band_mag ?? 0;
      lastHigh = payload.high_band_mag ?? 0;
      lastFftAt = performance.now();
    }).then((un) => { unlistenFft = un; });

    // Ativa o spectrum-emitter no backend (idempotente, refcount no
    // Rust — conviver com Visualizer também subscrito é seguro).
    spectrumSubscribe().catch(() => {});

    function frame() {
      raf = requestAnimationFrame(frame);
      if (document.hidden || !canvas.isConnected) return;

      // Re-ler CSS vars dos Tweaks ~3x/s pra refletir mudanças sem
      // listener Solid. 5 leituras agrupadas no mesmo tick pra evitar
      // 5 reflows separados em janelas onde getComputedStyle não
      // está warm.
      cfgCheckTick++;
      if (cfgCheckTick % 20 === 0) {
        const cs = getComputedStyle(document.documentElement);
        const ink = cs.getPropertyValue("--bg-ink-rgb").trim();
        if (ink) inkRgb = ink;
        const b = parseFloat(cs.getPropertyValue("--bg-bass-gain"));
        const m = parseFloat(cs.getPropertyValue("--bg-mid-gain"));
        const tr = parseFloat(cs.getPropertyValue("--bg-treble-gain"));
        const sm = parseFloat(cs.getPropertyValue("--bg-smoothing"));
        const sp = parseFloat(cs.getPropertyValue("--bg-speed"));
        if (Number.isFinite(b)) bassGain = b;
        if (Number.isFinite(m)) midGain = m;
        if (Number.isFinite(tr)) trebleGain = tr;
        if (Number.isFinite(sm)) smoothing = sm;
        if (Number.isFinite(sp)) speed = sp;
      }

      const tMs = performance.now();
      const dt = Math.max(0, (tMs - lastFrameMs) * 0.001);
      lastFrameMs = tMs;
      // Avança o relógio virtual da animação. bgSpeed=0 congela,
      // 1 = nominal, 2 = dobro. Independente do dt do envelope.
      bgClock += dt * speed;
      const t = bgClock;
      ctx.clearRect(0, 0, w, h);

      // Target do envelope: soma ponderada das 3 bandas, normalizada
      // pela soma dos pesos pra evitar saturar quando gains > 1.
      // Quando stale (sem FFT por > FFT_STALE_MS), target = 0 e o
      // smoothedEnv decai naturalmente.
      const fresh = lastFftAt !== 0 && tMs - lastFftAt < FFT_STALE_MS;
      let target = 0;
      if (fresh) {
        const num = bassGain * lastLow + midGain * lastMid + trebleGain * lastHigh;
        const den = bassGain + midGain + trebleGain;
        target = den > 1e-3 ? num / den : 0;
      }

      // Suavização exponencial: smoothedEnv converge pra target com
      // tau controlado por --bg-smoothing (0..1 → ENV_TAU_MIN..MAX).
      const tau = ENV_TAU_MIN + smoothing * (ENV_TAU_MAX - ENV_TAU_MIN);
      const alpha = 1 - Math.exp(-dt / tau);
      smoothedEnv += (target - smoothedEnv) * alpha;

      // Macro breathing — preservado do original. 4.5 s period.
      const breath = 0.85 + 0.15 * Math.sin(t * 0.4);

      // Reatividade contínua: envelope só modula amplitude (nunca
      // fase, nunca tinta — senão vira Winamp).
      const reactive = 1 + ENV_GAIN * smoothedEnv;
      const amp = h * 0.17 * breath * reactive;

      // Despacha pro renderer ativo — todo renderer consome o mesmo
      // campo shapeFn(u,v,t); só o índice muda entre eles.
      const shapeFn = SHAPES[shapeIdx()].fn;
      RENDERERS[renderIdx()].fn(ctx, w, h, t, shapeFn, amp, breath, inkRgb);
    }
    raf = requestAnimationFrame(frame);

    onCleanup(() => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      try { unlistenFft?.(); } catch {}
    });
  });

  return <canvas ref={canvas} class={`app-bg__canvas${props.class ? ` ${props.class}` : ""}`} aria-hidden="true" />;
}
