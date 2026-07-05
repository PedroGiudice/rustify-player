/* ============================================================
   EqCanvas.tsx — Curva de resposta de magnitude do EQ + overlay
   de spectrum REAL pos-DSP (RTA 1/3 oitava com peak-hold).

   Camadas (ordem z de baixo pra cima):
     1. Grid horizontal hairline
     2. Linha 0 dB stronger
     3. Ticks verticais por decada
     4. Spectrum bars (bg-ink 22% alpha) — quando overlay+playing
     5. Spectrum peaks (bg-ink 55% alpha, hairline horizontal)
     6. Fill carbono 5% abaixo da curva
     7. Stroke carbono 72% da curva
     8. Dots por banda

   Spectrum data: subscribe ao evento Tauri `audio-fft` (60 Hz,
   pos-DSP via PipeWire monitor). Estado vive em refs (Float32Array
   + objs) fora do Solid pra evitar overhead reativo no caminho hot.
   ============================================================ */

import { Component, createEffect, onCleanup, onMount } from "solid-js";
import type { EqBand } from "../../store/dsp";
import { tweaks } from "../../store/tweaks";
import { player } from "../../store/player";
import { cssColorToRgb } from "../../lib/color";
import { onAudioFft, spectrumSubscribe, spectrumUnsubscribe, type FftPayload } from "../../tauri";
import {
  ISO_CENTERS,
  NUM_BANDS,
  computeBinRanges,
  decodeDb,
  smoothToward,
  updatePeak,
  DISPLAY_DB_MIN,
  DISPLAY_DB_MAX,
  type PeakState,
} from "./spectrum-bands";

export interface EqCanvasProps {
  bands: EqBand[];
  activeBand: number;
}

const F_MIN = 20;
const F_MAX = 20000;
const LOG_MIN = Math.log10(F_MIN);
const LOG_SPAN = Math.log10(F_MAX) - LOG_MIN;
const DECADES = [50, 100, 200, 500, 1000, 2000, 5000, 10000];
const PAD_X = 26;
const PAD_X_RIGHT = 8;

// Escala Y do PLOT da curva (display only).
const DB_VIS_RANGE = 18;
const CURVE_STEPS = 256;

const DEFAULT_SAMPLE_RATE = 48000;

function freqToX(hz: number, padX: number, innerW: number): number {
  const u = (Math.log10(hz) - LOG_MIN) / LOG_SPAN;
  return padX + u * innerW;
}

function xToFreq(x: number, padX: number, innerW: number): number {
  const u = (x - padX) / innerW;
  return Math.pow(10, LOG_MIN + u * LOG_SPAN);
}

/** Resposta peaking aprox. Lorentziana em dB (offset em oitavas).
    bw_oct vem do Q via formula RBJ. */
function peakingDbAt(f: number, b: EqBand): number {
  if (b.gain_db === 0 || b.mute) return 0;
  const q = b.q || 1;
  const bwOct = (2 * Math.asinh(1 / (2 * q))) / Math.LN2;
  const nOct = Math.log2(f / b.freq);
  return b.gain_db / (1 + Math.pow((2 * nOct) / bwOct, 2));
}

function totalResponseDb(f: number, bands: EqBand[]): number {
  let s = 0;
  for (let i = 0; i < bands.length; i++) s += peakingDbAt(f, bands[i]);
  return s;
}

export const EqCanvas: Component<EqCanvasProps> = (props) => {
  let canvasEl!: HTMLCanvasElement;
  let observer: ResizeObserver | undefined;

  // ── Estado do RTA (fora de Solid: caminho hot 60Hz) ──
  const bandMags = new Float32Array(NUM_BANDS).fill(-80);
  const bandPeaks: PeakState[] = Array.from({ length: NUM_BANDS }, () => ({
    peak: -80,
    age: 0,
  }));
  let bandBinRanges = computeBinRanges(DEFAULT_SAMPLE_RATE);
  let cachedSampleRate = DEFAULT_SAMPLE_RATE;
  let lastFftAt = 0;
  let lastDrawAt = 0;
  let rafId = 0;

  // ── Listener de FFT: guarda a Promise, não só o resultado ──
  // Sem isso, desmontar/desligar antes do resolve do onAudioFft vaza o
  // callback de 60Hz pelo resto da sessão (o unlisten chegava tarde demais
  // e ninguém o chamava).
  let fftUnlisten: (() => void) | null = null;
  let fftPending: Promise<() => void> | null = null;

  // ── Dimensões/DPR cacheados (recomputados só no ResizeObserver) ──
  // Atribuir canvas.width/height reseta o backing store E a transform do
  // contexto; fazer isso a 60Hz no draw() é caro e força layout. Cacheamos
  // e só reatribuímos quando o tamanho físico muda (padrão do SpectrumCanvas).
  let cssW = 0;
  let cssH = 0;

  // ── Buffers reutilizados por frame (evita churn de GC no caminho quente) ──
  // Geometria das barras e amostras da curva são recomputadas in-place,
  // nunca realocadas.
  const xCenters = new Float32Array(NUM_BANDS);
  const slotW = new Float32Array(NUM_BANDS);
  const sampleX = new Float32Array(CURVE_STEPS + 1);
  const sampleY = new Float32Array(CURVE_STEPS + 1);

  function onFft(payload: FftPayload) {
    if (
      payload.sample_rate > 0 &&
      payload.sample_rate !== cachedSampleRate
    ) {
      cachedSampleRate = payload.sample_rate;
      bandBinRanges = computeBinRanges(cachedSampleRate);
    }
    const now = performance.now();
    let dt = lastFftAt === 0 ? 0.016 : (now - lastFftAt) / 1000;
    if (dt < 0.001) dt = 0.001;
    if (dt > 0.1) dt = 0.1;
    lastFftAt = now;

    const mags = payload.magnitudes;
    if (!mags || mags.length === 0) return;

    for (let b = 0; b < NUM_BANDS; b++) {
      const [start, end] = bandBinRanges[b];
      let maxDb = -80;
      const lim = Math.min(end, mags.length);
      for (let i = start; i < lim; i++) {
        const db = decodeDb(mags[i]);
        if (db > maxDb) maxDb = db;
      }
      bandMags[b] = smoothToward(bandMags[b], maxDb, dt);
      updatePeak(bandPeaks[b], bandMags[b], dt);
    }
  }

  function frame(now: number) {
    const dtDraw =
      lastDrawAt === 0 ? 0.016 : Math.min(0.1, (now - lastDrawAt) / 1000);
    lastDrawAt = now;

    // Decay continuo entre fft frames pra suavizar o peak visual
    for (let b = 0; b < NUM_BANDS; b++) {
      updatePeak(bandPeaks[b], bandMags[b], dtDraw);
    }

    draw();

    if (tweaks().eqSpectrumOverlay && player.isPlaying) {
      rafId = requestAnimationFrame(frame);
    } else {
      rafId = 0;
    }
  }

  function startLoop() {
    if (rafId !== 0) return;
    lastDrawAt = 0;
    rafId = requestAnimationFrame(frame);
  }

  function stopLoop() {
    if (rafId !== 0) {
      cancelAnimationFrame(rafId);
      rafId = 0;
    }
  }

  function ensureFftListener() {
    if (fftPending) return; // já assinado ou assinando
    spectrumSubscribe().catch(() => {});
    const p = onAudioFft(onFft);
    fftPending = p;
    p.then((un) => {
      if (fftPending !== p) {
        // dropFftListener rodou antes do resolve: descarta o listener tardio
        // em vez de deixá-lo vazar.
        un();
        return;
      }
      fftUnlisten = un;
    });
  }

  function dropFftListener() {
    if (!fftPending) return;
    fftPending = null; // sinaliza cancelamento pro resolve tardio (guard acima)
    spectrumUnsubscribe().catch(() => {}); // balanceia o refcount do subscribe
    if (fftUnlisten) {
      fftUnlisten();
      fftUnlisten = null;
    }
  }

  /** Recomputa dimensões/DPR e reatribui o backing store só quando muda.
      Chamado no mount e pelo ResizeObserver — nunca por frame. */
  function resize() {
    if (!canvasEl) return;
    const r = canvasEl.getBoundingClientRect();
    if (!r.width || !r.height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const nextW = Math.round(r.width * dpr);
    const nextH = Math.round(r.height * dpr);
    cssW = r.width;
    cssH = r.height;
    // Reatribuir width/height reseta o backing store + a transform, então só
    // fazemos quando o tamanho físico de fato muda.
    if (canvasEl.width !== nextW || canvasEl.height !== nextH) {
      canvasEl.width = nextW;
      canvasEl.height = nextH;
    }
    const ctx = canvasEl.getContext("2d");
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  }

  function draw() {
    if (!canvasEl) return;
    const ctx = canvasEl.getContext("2d");
    if (!ctx) return;
    const w = cssW;
    const h = cssH;
    if (!w || !h) return; // ainda não dimensionado (resize roda no mount)

    const mid = h / 2;
    const innerW = w - PAD_X - PAD_X_RIGHT;

    ctx.clearRect(0, 0, w, h);

    // ── Grid hairline horizontal ──
    ctx.strokeStyle = "rgba(0,0,0,0.05)";
    ctx.lineWidth = 1;
    for (let i = 1; i < 5; i++) {
      const y = (h / 5) * i + 0.5;
      ctx.beginPath();
      ctx.moveTo(PAD_X, y);
      ctx.lineTo(PAD_X + innerW, y);
      ctx.stroke();
    }
    // Linha 0 dB stronger
    ctx.strokeStyle = "rgba(0,0,0,0.10)";
    ctx.beginPath();
    ctx.moveTo(PAD_X, mid + 0.5);
    ctx.lineTo(PAD_X + innerW, mid + 0.5);
    ctx.stroke();

    // ── Ticks verticais por decada ──
    ctx.strokeStyle = "rgba(0,0,0,0.04)";
    for (const hz of DECADES) {
      const x = freqToX(hz, PAD_X, innerW) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 6);
      ctx.lineTo(x, h - 6);
      ctx.stroke();
    }

    // ── Spectrum bars + peaks (RTA pos-DSP) ──
    if (tweaks().eqSpectrumOverlay) {
      // Lê --bg-ink (custom property registrada como <color>): durante o
      // crossfade de 480ms o getComputedStyle devolve o valor INTERPOLADO,
      // então as barras acompanham a transição de graça. Fallback pro
      // --bg-ink-rgb cru se o parse falhar (registro indisponível).
      const cs = getComputedStyle(document.documentElement);
      const animated = cssColorToRgb(cs.getPropertyValue("--bg-ink"));
      const inkRgb = animated
        ? `${animated.r}, ${animated.g}, ${animated.b}`
        : (cs.getPropertyValue("--bg-ink-rgb").trim() || "23, 23, 23");
      const bottom = h - 4;
      const top = 4;
      const usableH = bottom - top;
      const dbSpan = DISPLAY_DB_MAX - DISPLAY_DB_MIN;

      const barDbToY = (db: number): number => {
        const c = Math.max(DISPLAY_DB_MIN, Math.min(DISPLAY_DB_MAX, db));
        const norm = (c - DISPLAY_DB_MIN) / dbSpan;
        return bottom - norm * usableH;
      };

      // Slot widths a partir do espaco entre centros adjacentes.
      // xCenters/slotW: buffers reutilizados, preenchidos in-place.
      for (let i = 0; i < NUM_BANDS; i++) {
        xCenters[i] = freqToX(ISO_CENTERS[i], PAD_X, innerW);
      }
      for (let i = 0; i < NUM_BANDS; i++) {
        const left =
          i === 0
            ? xCenters[0] - (xCenters[1] - xCenters[0]) / 2
            : (xCenters[i - 1] + xCenters[i]) / 2;
        const right =
          i === NUM_BANDS - 1
            ? xCenters[i] + (xCenters[i] - xCenters[i - 1]) / 2
            : (xCenters[i] + xCenters[i + 1]) / 2;
        slotW[i] = right - left;
      }

      // Barras
      ctx.fillStyle = `rgba(${inkRgb}, 0.22)`;
      for (let i = 0; i < NUM_BANDS; i++) {
        const barW = Math.max(2, slotW[i] * 0.7);
        const x = xCenters[i] - barW / 2;
        const yTop = barDbToY(bandMags[i]);
        if (yTop < bottom - 0.5) {
          ctx.fillRect(x, yTop, barW, bottom - yTop);
        }
      }

      // Peaks (hairline horizontal por banda)
      ctx.fillStyle = `rgba(${inkRgb}, 0.55)`;
      for (let i = 0; i < NUM_BANDS; i++) {
        const barW = Math.max(2, slotW[i] * 0.7);
        const x = xCenters[i] - barW / 2;
        const yPeak = barDbToY(bandPeaks[i].peak);
        if (yPeak < bottom - 0.5) {
          ctx.fillRect(x, yPeak - 0.5, barW, 1.5);
        }
      }
    }

    // ── Curva REAL: somatorio peaking ──
    const bands = props.bands;
    if (!bands?.length) return;

    const dbToY = (db: number) => mid - (db / DB_VIS_RANGE) * (h / 2) * 0.9;

    // Amostra a curva em buffers reutilizados (sampleX/sampleY): sem alocar
    // 257 tuplas por frame.
    for (let i = 0; i <= CURVE_STEPS; i++) {
      const x = PAD_X + (innerW * i) / CURVE_STEPS;
      const f = xToFreq(x, PAD_X, innerW);
      const db = totalResponseDb(f, bands);
      const dbClamped = Math.max(-DB_VIS_RANGE, Math.min(DB_VIS_RANGE, db));
      sampleX[i] = x;
      sampleY[i] = dbToY(dbClamped);
    }

    // Fill carbono 5% (curva fechada até a linha 0 dB). Path direto no
    // contexto — evita alocar Path2D por frame.
    ctx.fillStyle = "rgba(23,23,23,0.05)";
    ctx.beginPath();
    ctx.moveTo(sampleX[0], sampleY[0]);
    for (let i = 1; i <= CURVE_STEPS; i++) ctx.lineTo(sampleX[i], sampleY[i]);
    ctx.lineTo(sampleX[CURVE_STEPS], mid);
    ctx.lineTo(sampleX[0], mid);
    ctx.closePath();
    ctx.fill();

    // Stroke carbono 72% (curva aberta).
    ctx.strokeStyle = "rgba(23,23,23,0.72)";
    ctx.lineWidth = 1.4;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(sampleX[0], sampleY[0]);
    for (let i = 1; i <= CURVE_STEPS; i++) ctx.lineTo(sampleX[i], sampleY[i]);
    ctx.stroke();

    // Dots por banda
    const active = props.activeBand;
    for (let i = 0; i < bands.length; i++) {
      const b = bands[i];
      const x = freqToX(b.freq, PAD_X, innerW);
      const dbOnCurve = totalResponseDb(b.freq, bands);
      const dbClamped = Math.max(-DB_VIS_RANGE, Math.min(DB_VIS_RANGE, dbOnCurve));
      const y = dbToY(dbClamped);
      const isActive = i === active;
      const used = b.gain_db !== 0;
      ctx.beginPath();
      ctx.arc(x, y, isActive ? 4 : used ? 3 : 2, 0, Math.PI * 2);
      ctx.fillStyle = isActive
        ? "rgba(37,99,235,1)"
        : used
          ? "rgba(23,23,23,0.78)"
          : "rgba(115,115,115,0.45)";
      ctx.fill();
      if (isActive) {
        ctx.strokeStyle = "rgba(255,255,255,0.95)";
        ctx.lineWidth = 1.4;
        ctx.stroke();
      }
    }
  }

  onMount(() => {
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => resize());
      observer.observe(canvasEl);
    }
    // Dimensiona sincronamente no mount (antes dos createEffects que desenham);
    // o observer cobre mudanças de tamanho/DPR futuras.
    resize();
  });

  onCleanup(() => {
    observer?.disconnect();
    stopLoop();
    dropFftListener();
  });

  // Lifecycle: liga listener + rAF loop quando overlay e isPlaying.
  // tweaks() é signal de objeto inteiro — QUALQUER knob re-roda este effect.
  // Só age quando overlay/playing de fato mudam (padrão de adaptiveInk.ts),
  // senão arrastar um slider viraria burst de draw() no branch pausado.
  let prevOverlayOn: boolean | null = null;
  let prevIsPlaying: boolean | null = null;
  createEffect(() => {
    const overlayOn = tweaks().eqSpectrumOverlay;
    const isPlaying = player.isPlaying;
    if (overlayOn === prevOverlayOn && isPlaying === prevIsPlaying) return;
    prevOverlayOn = overlayOn;
    prevIsPlaying = isPlaying;
    if (overlayOn && isPlaying) {
      ensureFftListener();
      startLoop();
    } else {
      stopLoop();
      if (!overlayOn) dropFftListener();
      draw();
    }
  });

  // Redraw on band/active change (comportamento existente).
  createEffect(() => {
    void props.activeBand;
    for (const b of props.bands) {
      void b.freq; void b.gain_db; void b.q; void b.mute;
    }
    draw();
  });

  return (
    <div class="eq-canvas-wrap">
      <canvas ref={canvasEl} aria-hidden="true" />
      <div class="eq-yaxis" aria-hidden="true">
        <span>+18</span>
        <span>+9</span>
        <span>0</span>
        <span>-9</span>
        <span>-18</span>
      </div>
    </div>
  );
};
