/* ============================================================
   EqCanvas.tsx — Curva de resposta de magnitude do EQ.
   Eixo X log-scale (20 Hz -> 20 kHz), Y linear em dB (-18..+18 visual).
   Renderiza:
     - hairline grid horizontal + linha 0dB stronger
     - ticks verticais por decada
     - eixo Y com labels (+18, +12, +6, 0, -6, -12, -18)
     - curva REAL: somatorio das respostas peaking de cada banda
       (Lorentziana, usa freq + gain + Q). Antes era so spline ligando
       dots — ignorava Q e nao refletia o filtro real.
     - fill carbono 5% abaixo da curva
     - dots por banda (azul ativa, carbono usada, dim zero)
   Reativo via createEffect lendo bands/activeBand do store.
   Q tambem entra na reactivity (Solid signals).
   ============================================================ */

import { Component, createEffect, onCleanup, onMount } from "solid-js";
import type { EqBand } from "../../store/dsp";

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

// Escala Y do PLOT (display only). O DB_RANGE de controle continua
// 36 no store/dsp.ts — aqui so estica menos a curva pra ficar visivel.
const DB_VIS_RANGE = 18;
const CURVE_STEPS = 256; // resolucao horizontal da curva real

function freqToX(hz: number, padX: number, innerW: number): number {
  const u = (Math.log10(hz) - LOG_MIN) / LOG_SPAN;
  return padX + u * innerW;
}

function xToFreq(x: number, padX: number, innerW: number): number {
  const u = (x - padX) / innerW;
  return Math.pow(10, LOG_MIN + u * LOG_SPAN);
}

/** Resposta paramétrica peaking aprox. Lorentziana em dB, em offset n oitavas.
    bw_oct vem do Q via formula RBJ: bw = 2*asinh(1/2Q)/ln(2).
    Suficiente pra plot — nao precisamos da fase nem fs. */
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

  function draw() {
    if (!canvasEl) return;
    const ctx = canvasEl.getContext("2d");
    if (!ctx) return;
    const r = canvasEl.getBoundingClientRect();
    if (!r.width || !r.height) return;

    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvasEl.width = Math.round(r.width * dpr);
    canvasEl.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = r.width;
    const h = r.height;
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

    // ── Curva REAL: amostra a resposta total em CURVE_STEPS pontos ──
    const bands = props.bands;
    if (!bands?.length) return;

    const dbToY = (db: number) => mid - (db / DB_VIS_RANGE) * (h / 2) * 0.9;

    // Sampling no eixo X, mapeando cada x -> freq -> response dB
    const samples: [number, number][] = [];
    for (let i = 0; i <= CURVE_STEPS; i++) {
      const x = PAD_X + (innerW * i) / CURVE_STEPS;
      const f = xToFreq(x, PAD_X, innerW);
      const db = totalResponseDb(f, bands);
      // clamp visual no range; nao corrompe o calculo, so evita sair do plot
      const dbClamped = Math.max(-DB_VIS_RANGE, Math.min(DB_VIS_RANGE, db));
      samples.push([x, dbToY(dbClamped)]);
    }

    function curvePath(closeToMid: boolean): Path2D {
      const p = new Path2D();
      p.moveTo(samples[0][0], samples[0][1]);
      for (let i = 1; i < samples.length; i++) p.lineTo(samples[i][0], samples[i][1]);
      if (closeToMid) {
        p.lineTo(samples[samples.length - 1][0], mid);
        p.lineTo(samples[0][0], mid);
        p.closePath();
      }
      return p;
    }

    // ── Fill carbono 5% ──
    ctx.fillStyle = "rgba(23,23,23,0.05)";
    ctx.fill(curvePath(true));

    // ── Stroke carbono ─
    ctx.strokeStyle = "rgba(23,23,23,0.72)";
    ctx.lineWidth = 1.4;
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    ctx.stroke(curvePath(false));

    // ── Dots por banda (na curva resultante, nao no gain isolado) ──
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
    // Resize observer pra responsividade. Sem fallback de window resize:
    // o canvas e filho do .eq-canvas-wrap que reage a layout do painel.
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => draw());
      observer.observe(canvasEl);
    }
    // Primeiro frame ja foi disparado pelo createEffect; aqui so observamos resizes.
  });

  onCleanup(() => {
    observer?.disconnect();
  });

  // Reativo: qualquer band (freq/gain/q/mute) ou activeBand mudam -> redraw.
  // Toca em cada campo individualmente pra registrar dependencia no Solid store.
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
      {/* Eixo Y dB (CSS .eq-yaxis ja existia em extractor-lab.css,
          mas o JSX nao renderizava — wiring faltava). */}
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
