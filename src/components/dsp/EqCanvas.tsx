/* ============================================================
   EqCanvas.tsx — Curva de magnitude do EQ.
   Eixo X log-scale (20 Hz -> 20 kHz), Y linear em dB.
   Renderiza:
     - hairline grid horizontal + linha 0dB stronger
     - ticks verticais por decada
     - curva Catmull-Rom -> Bezier suavizada
     - fill carbono 5% abaixo da curva
     - dots por banda (azul ativa, carbono usada, dim zero)
   Reativo via createEffect lendo bands/activeBand do store.
   ============================================================ */

import { Component, createEffect, onCleanup, onMount } from "solid-js";
import { DB_RANGE, type EqBand } from "../../store/dsp";

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

function freqToX(hz: number, padX: number, innerW: number): number {
  const u = (Math.log10(hz) - LOG_MIN) / LOG_SPAN;
  return padX + u * innerW;
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

    // ── Pontos da curva (log freq) ──
    const bands = props.bands;
    if (!bands?.length) return;
    const pts: [number, number][] = bands.map((b) => {
      const x = freqToX(b.freq, PAD_X, innerW);
      // y mapping: 0.86 factor mantém headroom visual quando gain == ±DB_RANGE.
      const y = mid - (b.gain_db / DB_RANGE) * (h / 2) * 0.86;
      return [x, y];
    });

    function curvePath(closeToMid: boolean): Path2D {
      const p = new Path2D();
      p.moveTo(pts[0][0], pts[0][1]);
      for (let i = 0; i < pts.length - 1; i++) {
        const p0 = pts[Math.max(i - 1, 0)];
        const p1 = pts[i];
        const p2 = pts[i + 1];
        const p3 = pts[Math.min(i + 2, pts.length - 1)];
        p.bezierCurveTo(
          p1[0] + (p2[0] - p0[0]) / 6,
          p1[1] + (p2[1] - p0[1]) / 6,
          p2[0] - (p3[0] - p1[0]) / 6,
          p2[1] - (p3[1] - p1[1]) / 6,
          p2[0],
          p2[1],
        );
      }
      if (closeToMid) {
        p.lineTo(pts[pts.length - 1][0], mid);
        p.lineTo(pts[0][0], mid);
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

    // ── Dots por banda ──
    const active = props.activeBand;
    pts.forEach(([x, y], i) => {
      const isActive = i === active;
      const used = bands[i].gain_db !== 0;
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
    });
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

  // Reativo: bands ou activeBand mudam -> redraw.
  createEffect(() => {
    // ler ambos pra rastrear reatividade
    void props.bands;
    void props.activeBand;
    draw();
  });

  return (
    <div class="eq-canvas-wrap">
      <canvas ref={canvasEl} aria-hidden="true" />
    </div>
  );
};
