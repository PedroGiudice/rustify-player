/* ============================================================
   components/SpectrumCanvas.tsx — Carbon-on-paper spectrum bg.

   Renders only when its container is visible (active route =
   NowPlaying). Animation loop is rAF + bails if hidden.

   Shape state is persisted to localStorage so it survives reloads.
   ============================================================ */

import { createSignal, onCleanup, onMount } from "solid-js";
import { SHAPES } from "../shapes";

const SHAPE_KEY = "rustify-mock-shape";

const NLINES = 110;
const NPOINTS = 96;

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

export function SpectrumCanvas(props: SpectrumCanvasProps) {
  let canvas!: HTMLCanvasElement;
  let raf = 0;
  const t0 = performance.now();

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

    function frame() {
      raf = requestAnimationFrame(frame);
      if (document.hidden || !canvas.isConnected) return;

      const t = (performance.now() - t0) * 0.001;
      ctx.clearRect(0, 0, w, h);

      const beat = 0.7 + 0.3 * (0.5 + 0.5 * Math.sin(t * 1.4));
      const amp = h * 0.17 * beat;
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
          const phase = i * 0.085 + t * 0.55;
          const wave  = Math.sin(u * Math.PI * 3.2 + phase) * s * amp;
          const drift = Math.sin(t * 0.45 + i * 0.07) * 1.4;
          const y = baselineY - wave + drift;
          if (j === 0) ctx.moveTo(x, y);
          else         ctx.lineTo(x, y);
        }
      }
      ctx.strokeStyle = props.strokeStyle ?? "rgba(23, 23, 23, 0.10)";
      ctx.lineWidth = 0.6;
      ctx.stroke();
    }
    raf = requestAnimationFrame(frame);

    onCleanup(() => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    });
  });

  return <canvas ref={canvas} class={`np__canvas${props.class ? ` ${props.class}` : ""}`} aria-hidden="true" />;
}
