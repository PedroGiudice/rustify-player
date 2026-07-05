/* ============================================================
   renderers.ts — Spectrum renderers (Now Playing background).

   Cada renderer é uma estratégia de pintura que consome o MESMO
   campo escalar shapeFn(u,v,t) de shapes.ts — nenhum renderer
   sabe qual shape está ativo, por isso as listas se multiplicam
   (18 shapes × 5 renderers) sem custo.

   Assinatura: (ctx, w, h, t, shapeFn, amp, breath, ink, env).
   `ink` é a tinta "r, g, b" (vinda de --bg-ink-rgb via Tweaks);
   cada renderer aplica o próprio alpha. `amp` (pixels, já contém
   o envelope de áudio) desloca geometria em TODOS os renderers —
   inclusive dots, que cavalga o mesmo campo de onda do mesh.
   `breath` (LFO 4.5s) e `env` (envelope FFT 0..1) são consumidos
   só por dots: raio respira/pulsa, alpha flasheia.

   Densidades e alphas copiados 1:1 do handoff (docs/design-refs/
   design_handoff_persistent_background). index 0 = mesh = o
   desenho original — comportamento antigo preservado por default.
   ============================================================ */

import type { ShapeFn } from "./shapes";

export interface Renderer {
  name: string;
  fn: (
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    t: number,
    shapeFn: ShapeFn,
    amp: number,
    breath: number,
    ink: string,
    env: number,
  ) => void;
}

/** Override interno de tinta usado pelo weave (mesh+columns a alpha baixo). */
interface StrokeStyle {
  color: string;
  width: number;
}

const NLINES  = 110;    // mesh: linhas horizontais
const NPOINTS = 96;     // mesh / contour: segmentos por linha
const NCOLS   = 90;     // columns: linhas verticais
const NROWS   = 110;    // columns: segmentos por coluna
const GX = 66, GY = 44; // dots: densidade da grade
const NBANDS  = 34;     // contour: bandas topográficas

/* mesh — linhas horizontais onduladas (o desenho original), 1 stroke(). */
function drawMesh(
  ctx: CanvasRenderingContext2D, w: number, h: number, t: number,
  shapeFn: ShapeFn, amp: number, _breath: number, ink: string,
  _env: number, style?: StrokeStyle,
) {
  const topY = h * 0.04, botY = h * 0.98;
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
      if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  }
  ctx.strokeStyle = style?.color ?? `rgba(${ink}, 0.16)`;
  ctx.lineWidth   = style?.width ?? 0.7;
  ctx.stroke();
}

/* columns — mesmo campo transposto: linhas verticais deslocadas em x. */
function drawColumns(
  ctx: CanvasRenderingContext2D, w: number, h: number, t: number,
  shapeFn: ShapeFn, amp: number, _breath: number, ink: string,
  _env: number, style?: StrokeStyle,
) {
  const leftX = w * 0.02, rightX = w * 0.98;
  ctx.beginPath();
  for (let i = 0; i < NCOLS; i++) {
    const u = i / (NCOLS - 1);
    const baselineX = leftX + (rightX - leftX) * u;
    for (let j = 0; j <= NROWS; j++) {
      const v = j / NROWS;
      const y = h * 0.04 + h * 0.94 * v;
      const s = shapeFn(u, v, t);
      const phase = i * 0.085 + t * 0.55;
      const wave  = Math.sin(v * Math.PI * 3.2 + phase) * s * amp;
      const drift = Math.sin(t * 0.45 + i * 0.07) * 1.4;
      const x = baselineX - wave + drift;
      if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
  }
  ctx.strokeStyle = style?.color ?? `rgba(${ink}, 0.16)`;
  ctx.lineWidth   = style?.width ?? 0.7;
  ctx.stroke();
}

/* weave — mesh + columns sobrepostos a alpha 0.10 → textura de tecido. */
function drawWeave(
  ctx: CanvasRenderingContext2D, w: number, h: number, t: number,
  shapeFn: ShapeFn, amp: number, breath: number, ink: string, env: number,
) {
  drawMesh(ctx, w, h, t, shapeFn, amp * 0.8, breath, ink, env, { color: `rgba(${ink}, 0.10)`, width: 0.6 });
  drawColumns(ctx, w, h, t, shapeFn, amp * 0.8, breath, ink, env, { color: `rgba(${ink}, 0.10)`, width: 0.6 });
}

/* dots — grade de pontos cavalgando o MESMO campo de onda do mesh:
   cada ponto desloca verticalmente por sin(u·π·3.2 + fase)·s·amp,
   a mesma reatividade espacial que os renderers de linha têm — é o
   deslocamento (dezenas de px) que o olho lê como "reage à música",
   não raio/alpha sozinhos. Por cima: raio respira (breath) e pulsa
   (env), alpha flasheia (env). Fase segue time-driven, nunca áudio. */
function drawDots(
  ctx: CanvasRenderingContext2D, w: number, h: number, t: number,
  shapeFn: ShapeFn, amp: number, breath: number, ink: string, env: number,
) {
  const maxR = Math.min(w / GX, h / GY) * 0.66;
  const e = Math.min(1, Math.max(0, env));
  const pulse = 1 + 0.35 * e; // raio: punch no pico
  const flash = 1 + 0.6 * e;  // alpha: flash de intensidade
  ctx.fillStyle = `rgb(${ink})`;
  for (let gy = 0; gy < GY; gy++) {
    const v = gy / (GY - 1);
    const baselineY = h * 0.04 + h * 0.94 * v;
    // Mesma inclinação de fase do mesh ao longo da altura:
    // mesh varre v*(NLINES-1)*0.085 ≈ v*9.27 rad. Fase só de tempo.
    const phase = v * 9.27 + t * 0.55;
    for (let gx = 0; gx < GX; gx++) {
      const u = gx / (GX - 1);
      const s = shapeFn(u, v, t);
      if (s < 0.03) continue;
      const cl = Math.min(1, s);
      const wave = Math.sin(u * Math.PI * 3.2 + phase) * s * amp * 0.6;
      const r = maxR * cl * (0.55 + 0.45 * breath) * pulse;
      const x = u * w + Math.sin(t * 0.6 + gy * 0.3) * 1.2;
      ctx.globalAlpha = Math.min(0.95, (0.10 + 0.55 * cl) * flash);
      ctx.beginPath();
      ctx.arc(x, baselineY - wave, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/* contour — poucas bandas; espessura/alpha ∝ pico da banda → topográfico. */
function drawContour(
  ctx: CanvasRenderingContext2D, w: number, h: number, t: number,
  shapeFn: ShapeFn, amp: number, _breath: number, ink: string, _env: number,
) {
  const topY = h * 0.04, botY = h * 0.98;
  for (let i = 0; i < NBANDS; i++) {
    const v = i / (NBANDS - 1);
    const baselineY = topY + (botY - topY) * v;
    let peak = 0;
    ctx.beginPath();
    for (let j = 0; j <= NPOINTS; j++) {
      const u = j / NPOINTS;
      const x = u * w;
      const s = shapeFn(u, v, t);
      if (s > peak) peak = s;
      const wave = Math.sin(u * Math.PI * 3.2 + t * 0.55) * s * amp * 1.5;
      const y = baselineY - wave;
      if (j === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = `rgba(${ink}, ${0.05 + 0.32 * peak})`;
    ctx.lineWidth   = 0.6 + 1.6 * peak;
    ctx.stroke();
  }
}

export const RENDERERS: Renderer[] = [
  { name: "mesh",    fn: drawMesh },
  { name: "columns", fn: drawColumns },
  { name: "weave",   fn: drawWeave },
  { name: "dots",    fn: drawDots },
  { name: "contour", fn: drawContour },
];
