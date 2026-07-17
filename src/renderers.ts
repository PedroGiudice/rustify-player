/* ============================================================
   renderers.ts — Spectrum renderers (Now Playing background).

   Cada renderer é uma estratégia de pintura que consome o MESMO
   campo escalar shapeFn(u,v,t) de shapes.ts — nenhum renderer
   sabe qual shape está ativo, por isso as listas se multiplicam
   (18 shapes × 5 renderers) sem custo.

   Assinatura: (ctx, w, h, t, shapeFn, amp, breath, ink, env,
   inkBoost?). `ink` é a tinta "r, g, b" (vinda de --bg-ink-rgb via
   Tweaks); cada renderer aplica o próprio alpha. `amp` (pixels, já
   contém o envelope de áudio + pulso do beat) desloca geometria em
   TODOS os renderers — inclusive dots, que cavalga o mesmo campo
   de onda do mesh. `breath` (LFO 4.5s) e `env` (envelope FFT 0..1)
   são consumidos só por dots: raio respira/pulsa, alpha flasheia.
   `inkBoost` (>= 1, pulso do beat-sync PLL) levanta a densidade de
   tinta sutilmente NO CONTOUR apenas — os demais ignoram (spec:
   PATCH-beat-sync-PLL.md, demo no Beat Sync Lab.html).

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
    inkBoost?: number,
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

/* dots — grade ESTÁTICA de pontos (sem balanço: o deslocamento de onda
   da v0.2.44 foi removido a pedido — o amp baseline oscila mesmo sem
   música e virava gangorra). Reatividade é 100% envelope de áudio:
   pulso de raio PONDERADO PELO CAMPO (pontos fortes estouram até +60%,
   fracos quase não mexem — o pulso desenha a shape, não a grade) e
   flash de alpha agressivo. Em silêncio (env=0) é o baseline do
   handoff, parado. */
function drawDots(
  ctx: CanvasRenderingContext2D, w: number, h: number, t: number,
  shapeFn: ShapeFn, _amp: number, breath: number, ink: string, env: number,
) {
  const maxR = Math.min(w / GX, h / GY) * 0.66;
  const e = Math.min(1, Math.max(0, env));
  ctx.fillStyle = `rgb(${ink})`;
  for (let gy = 0; gy < GY; gy++) {
    const v = gy / (GY - 1);
    const y = h * 0.04 + h * 0.94 * v;
    for (let gx = 0; gx < GX; gx++) {
      const u = gx / (GX - 1);
      const s = shapeFn(u, v, t);
      if (s < 0.03) continue;
      const cl = Math.min(1, s);
      const pulse = 1 + 0.6 * e * cl;  // punch concentrado nos pontos fortes
      const r = maxR * cl * (0.55 + 0.45 * breath) * pulse;
      const x = u * w + Math.sin(t * 0.6 + gy * 0.3) * 1.2;
      ctx.globalAlpha = Math.min(0.95, (0.10 + 0.55 * cl) * (1 + 0.9 * e));
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.globalAlpha = 1;
}

/* contour — poucas bandas; espessura/alpha ∝ pico da banda → topográfico.
   Único renderer que consome inkBoost: o pulso do beat-sync levanta a
   densidade de tinta sutilmente (lab: a·(1+0.5·pulse), cap 0.9). */
function drawContour(
  ctx: CanvasRenderingContext2D, w: number, h: number, t: number,
  shapeFn: ShapeFn, amp: number, _breath: number, ink: string, _env: number,
  inkBoost?: number,
) {
  const topY = h * 0.04, botY = h * 0.98;
  const boost = inkBoost ?? 1;
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
    const a = Math.min(0.9, (0.05 + 0.32 * peak) * boost);
    ctx.strokeStyle = `rgba(${ink}, ${a})`;
    ctx.lineWidth   = 0.6 + 1.6 * peak;
    ctx.stroke();
  }
}

export const RENDERERS: Renderer[] = [
  // mesh/columns têm um 10º param interno (style, usado pelo weave) que
  // NÃO é o inkBoost da interface — o wrapper isola o contrato público.
  { name: "mesh",    fn: (ctx, w, h, t, sf, amp, br, ink, env) => drawMesh(ctx, w, h, t, sf, amp, br, ink, env) },
  { name: "columns", fn: (ctx, w, h, t, sf, amp, br, ink, env) => drawColumns(ctx, w, h, t, sf, amp, br, ink, env) },
  { name: "weave",   fn: drawWeave },
  { name: "dots",    fn: drawDots },
  { name: "contour", fn: drawContour },
];
