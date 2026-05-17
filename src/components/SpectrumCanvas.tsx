/* ============================================================
   components/SpectrumCanvas.tsx — Carbon-on-paper spectrum bg.

   Renders only when its container is visible (active route =
   NowPlaying). Animation loop is rAF + bails if hidden.

   Shape state is persisted to localStorage so it survives reloads.

   Beat-sync (T10): consome `low_band_mag` / `rms_energy` do payload
   `audio-fft` (envelope follower já aplicado no Rust em pw_capture.rs).
   Quando o stream para de chegar (subscribe inativo, DSP bypass, ou
   track carregando), faz fallback time-driven (fakeKick/fakeEnergy).

   Regra crítica: o envelope só modula amplitude e ink density.
   NUNCA toca em fase — caso contrário vira screensaver Winamp.
   ============================================================ */

import { createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { SHAPES } from "../shapes";
import { onAudioFft, spectrumSubscribe, type FftPayload } from "../tauri";
import { player } from "../store/player";

const SHAPE_KEY = "rustify-mock-shape";
const SYNC_KEY = "rustify-mock-sync";
const BPM_KEY = "rustify-mock-bpm";

const NLINES = 110;
const NPOINTS = 96;

/** Tempo (ms) sem frame de FFT antes de cair pro fallback time-driven. */
const FFT_STALE_MS = 250;

export interface SpectrumCanvasProps {
  /** Strokes lines in this color. Default is carbon ink 10% alpha (paper mode). */
  strokeStyle?: string;
  /** Class on the <canvas>. */
  class?: string;
}

/** Reactive shape index — components can read+update this. */
const [shapeIdx, setShapeIdx] = createSignal<number>(loadInitialShape());

function loadInitialShape(): number {
  try {
    const raw = parseInt(localStorage.getItem(SHAPE_KEY) ?? "0", 10);
    if (Number.isFinite(raw)) return ((raw % SHAPES.length) + SHAPES.length) % SHAPES.length;
  } catch {}
  return 0;
}

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

/**
 * Lê SYNC_STRENGTH do localStorage. Suporta tanto a forma nomeada
 * configurada no T9 Settings ("off" | "subtle" | "default" | "pulse")
 * quanto número direto (legado do mockup HTML). Default 0.55.
 */
function readSyncStrength(): number {
  try {
    const raw = localStorage.getItem(SYNC_KEY);
    if (raw === null) return 0.55;
    const named: Record<string, number> = {
      off: 0,
      subtle: 0.25,
      default: 0.55,
      pulse: 0.9,
    };
    if (raw in named) return named[raw];
    const n = parseFloat(raw);
    if (Number.isFinite(n)) return Math.max(0, Math.min(1, n));
  } catch {}
  return 0.55;
}

/** BPM do fallback (90 default, lido do localStorage). */
function readFallbackBpm(): number {
  try {
    const raw = localStorage.getItem(BPM_KEY);
    if (raw === null) return 90;
    const n = parseFloat(raw);
    if (Number.isFinite(n)) return Math.max(40, Math.min(200, n));
  } catch {}
  return 90;
}

/** Kick fallback time-driven — espelha o HTML referência. */
function fakeKick(t: number, bpm: number): number {
  const period = 60 / bpm;
  const phase = (t % period) / period;
  return phase < 0.05 ? phase / 0.05 : Math.exp(-(phase - 0.05) * 7.5);
}

/** Energy fallback time-driven — espelha o HTML referência. */
function fakeEnergy(t: number): number {
  return 0.55 + 0.2 * Math.sin(t * 0.7) + 0.15 * Math.sin(t * 0.45 + 1.7);
}

export function SpectrumCanvas(props: SpectrumCanvasProps) {
  let canvas!: HTMLCanvasElement;
  let raf = 0;
  const t0 = performance.now();

  // Estado vivo do envelope vindo do backend. Atualizado pelo listener
  // de `audio-fft`. Fora do Solid signal de propósito — frame loop não
  // precisa de reatividade, só do snapshot mais recente.
  let lastLow = 0;
  let lastRms = 0.55;
  let lastFftAt = 0;

  // Cache do SYNC_STRENGTH e BPM — relido a cada frame (custo zero) pra
  // refletir mudanças no Settings sem precisar de event listener.
  let syncStrength = readSyncStrength();
  let fallbackBpm = readFallbackBpm();
  // Cor da tinta (Tweaks → "Bg ink"). Lida da CSS var --bg-ink-rgb
  // (formato "R, G, B"). Default carbono.
  let inkRgb = "23, 23, 23";
  let cfgCheckTick = 0;

  // Listener de FFT do backend.
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

    // Subscribe ao audio-fft. Quando ativo, sobrescreve os fallbacks.
    onAudioFft((payload: FftPayload) => {
      lastLow = payload.low_band_mag ?? 0;
      lastRms = payload.rms_energy ?? 0;
      lastFftAt = performance.now();
    }).then((un) => { unlistenFft = un; });

    // Ativa o spectrum-emitter no backend. O command é idempotente
    // (refcount no lado Rust), então conviver com Visualizer também
    // mantendo subscribe não causa problema.
    spectrumSubscribe().catch(() => {});

    // Frame estatico desenhado quando o player esta pausado: zera kick,
    // energy, breath e drift; usa apenas a shape function pra textura.
    function drawStaticFrame() {
      if (document.hidden || !canvas.isConnected) return;
      ctx.clearRect(0, 0, w, h);
      const amp = h * 0.17; // sem breath, sem reactive
      const topY = h * 0.04;
      const botY = h * 0.98;
      const shapeFn = SHAPES[shapeIdx()].fn;
      ctx.beginPath();
      for (let i = 0; i < NLINES; i++) {
        const v = i / (NLINES - 1);
        const baselineY = topY + (botY - topY) * v;
        for (let j = 0; j <= NPOINTS; j++) {
          const u = j / NPOINTS;
          const x = u * w;
          // t=0 congelado; fase apenas espacial por linha
          const s = shapeFn(u, v, 0);
          const phase = i * 0.085;
          const wave = Math.sin(u * Math.PI * 3.2 + phase) * s * amp;
          const y = baselineY - wave;
          if (j === 0) ctx.moveTo(x, y);
          else         ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = props.strokeStyle ?? `rgba(${inkRgb}, 0.08)`;
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }

    function frame() {
      // Loop so anda enquanto algo toca. Sem isso, fakeKick + fakeEnergy +
      // breath + drift continuam pulsando o canvas em silencio. Pause limpa
      // o ultimo frame estatico (sem animacao residual) e libera o rAF.
      if (!player.isPlaying) {
        drawStaticFrame();
        raf = 0;
        return;
      }
      raf = requestAnimationFrame(frame);
      if (document.hidden || !canvas.isConnected) return;

      // Re-ler config do localStorage ~3x/s pra refletir mudanças no Tweaks
      // Settings sem precisar de listener dedicado. Cheap (~1 syscall).
      cfgCheckTick++;
      if (cfgCheckTick % 20 === 0) {
        syncStrength = readSyncStrength();
        fallbackBpm = readFallbackBpm();
        const v = getComputedStyle(document.documentElement)
          .getPropertyValue("--bg-ink-rgb").trim();
        if (v) inkRgb = v;
      }

      const tMs = performance.now();
      const t = (tMs - t0) * 0.001;
      ctx.clearRect(0, 0, w, h);

      // Macro breathing — preservado do original. 4.5 s period.
      const breath = 0.85 + 0.15 * Math.sin(t * 0.4);

      // Escolhe fonte do envelope: backend se fresco, senão time-driven.
      const fresh = lastFftAt !== 0 && tMs - lastFftAt < FFT_STALE_MS;
      const kick = fresh ? lastLow : fakeKick(t, fallbackBpm);
      const energy = fresh ? lastRms : fakeEnergy(t);

      // Music-reactive envelope: dominado pelo kick (sub-bass), com RMS
      // como tempero suave de dinamica geral. Coeficientes calibrados pra
      // Subtle (0.25) gerar ~18% de amplitude no pico e Default (0.55)
      // ~40%. Kick > RMS pra animacao seguir grave/kick e nao hi-hats.
      // Scaled around 1.0 — syncStrength=0 deixa shape exatamente como antes.
      const reactive = 1 + syncStrength * (kick * 0.7 + (energy - 0.7) * 0.15);
      const amp = h * 0.17 * breath * reactive;

      const topY = h * 0.04;
      const botY = h * 0.98;
      const shapeFn = SHAPES[shapeIdx()].fn;

      ctx.beginPath();
      for (let i = 0; i < NLINES; i++) {
        const v = i / (NLINES - 1);
        const baselineY = topY + (botY - topY) * v;
        for (let j = 0; j <= NPOINTS; j++) {
          const u = j / NPOINTS;
          const x = u * w;
          const s = shapeFn(u, v, t);
          // Fase é APENAS time-driven — nunca tocada pelo envelope.
          const phase = i * 0.085 + t * 0.55;
          const wave  = Math.sin(u * Math.PI * 3.2 + phase) * s * amp;
          const drift = Math.sin(t * 0.45 + i * 0.07) * 1.4;
          const y = baselineY - wave + drift;
          if (j === 0) ctx.moveTo(x, y);
          else         ctx.lineTo(x, y);
        }
      }

      // Ink density rides o kick — cada beat fica como um leve adensamento.
      const inkAlpha = 0.1 + syncStrength * kick * 0.05;
      ctx.strokeStyle = props.strokeStyle ?? `rgba(${inkRgb}, ${inkAlpha.toFixed(3)})`;
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
    raf = requestAnimationFrame(frame);

    // Reativa o loop quando isPlaying virar true (foi pausado e voltou).
    // O proprio frame() decide se continua; aqui so dispara o re-start.
    createEffect(() => {
      if (player.isPlaying && raf === 0) {
        raf = requestAnimationFrame(frame);
      } else if (!player.isPlaying && raf !== 0) {
        // Pausa imediata: cancela o frame agendado e desenha estatico.
        cancelAnimationFrame(raf);
        raf = 0;
        drawStaticFrame();
      }
    });

    onCleanup(() => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      try { unlistenFft?.(); } catch {}
    });
  });

  return <canvas ref={canvas} class={`np__canvas${props.class ? ` ${props.class}` : ""}`} aria-hidden="true" />;
}
