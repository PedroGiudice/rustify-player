/* ============================================================
   scenes/mandala.ts — Mandala: anéis fractais concêntricos, em
   linha, num túnel que se aprofunda sem fim.

   Pedido do CEO (18/10): "fractais concêntricos, modern & unique,
   psytrance". A versão clichê (caleidoscópio arco-íris saturado) foi
   descartada na mesa: aqui é só linha fina e brilho, nas cores do
   app sobre preto, com a geometria fazendo o trabalho.

   Como funciona: coordenadas log-polares (u = log r, v = ângulo) —
   aproximar é TRANSLADAR em u, então o zoom é um deslocamento que
   nunca acaba. O ângulo é dobrado em N setores espelhados
   (caleidoscópio) e o par (u, v) passa por um IFS caleidoscópico
   (dobra |p| − c, giro, escala), 4 iterações; a "armadilha de
   órbita" nos eixos devolve a distância às linhas: eixo u = círculos
   concêntricos, eixo v = raios. Cada iteração acrescenta um nível de
   detalhe auto-semelhante dentro dos anéis. O centro se apaga antes
   de virar moiré e o canto escurece com uma vinheta.

   Sinal (relativo à faixa): graves (swell) mudam a VELOCIDADE do
   zoom, integrado na CPU (CMR-267); cada kick (pulse) dá um impulso
   angular que amortece (a mandala gira e assenta); médios (midRel)
   respiram o deslocamento do IFS; agudos (highLift) acendem os
   níveis finos.

   Custo: gl-bench na cmr-auto (WebKitGTK, 1857x1048, 18/10): 2,2 ms
   por quadro, em resolução cheia.
   ============================================================ */

import { FS_COMMON, HEAD, VS_TRI } from "../glsl";
import { makeProgram, type Program } from "../glkit";
import type { GlScene, SceneCtx, SceneDef, ScenePalette } from "../scene";
import type { GlSignal } from "../signal";

/** Setores do caleidoscópio. */
export const MANDALA_FOLDS = 6;
/** Zoom em repouso (unidades de log r por segundo) e ganho do grave. */
export const ZOOM_BASE = 0.12;
export const ZOOM_SWELL = 0.35;
/** Impulso angular por kick (rad/s) e constante de amortecimento (s). */
export const SPIN_KICK = 0.9;
export const SPIN_TAU = 0.7;

const FS = HEAD + FS_COMMON + `
uniform float uZoom, uRot, uBreath, uFine, uFlash;

const float N = ${MANDALA_FOLDS}.0;
const float TAU = 6.28318530718;
const float PERIOD = 2.4;     // período em u: o túnel se repete sem costura

mat2 rot(float a) { float c = cos(a), s = sin(a); return mat2(c, -s, s, c); }

void main() {
  vec2 p = (gl_FragCoord.xy - 0.5 * uRes) / uRes.y;
  float r = length(p);
  float a = atan(p.y, p.x) + uRot;
  float sec = TAU / N;
  a = abs(mod(a + sec * 0.5, sec) - sec * 0.5);   // dobra espelhada
  float u = log(max(r, 1e-4)) * 1.6 + uZoom;
  u = mod(u, PERIOD) - PERIOD * 0.5;
  vec2 q = vec2(u, a * 1.6);

  // IFS caleidoscópico com armadilha de órbita nos eixos
  float dRing = 1e3, dRay = 1e3, dFine = 1e3;
  float scale = 1.0;
  vec2 c = vec2(0.55 + uBreath, 0.42);
  for (int i = 0; i < 4; i++) {
    q = abs(q) - c;
    q = rot(0.5 + float(i) * 0.37) * q;
    q *= 1.35; scale *= 1.35;
    float dr = abs(q.x) / scale, dy = abs(q.y) / scale;
    if (i < 2) { dRing = min(dRing, dr); dRay = min(dRay, dy); }
    else if (i == 2) dFine = min(dFine, min(dr, dy));
  }
  // linhas em pixels: a derivada do campo log-polar cresce com 1/r
  float px = 1.6 / max(r * uRes.y, 1.0);
  float ring = smoothstep(px * 2.2, 0.0, dRing);
  float ray = smoothstep(px * 1.6, 0.0, dRay) * (1.0 - smoothstep(0.22, 0.6, r) * 0.95);
  // o nível fino só perto do centro: longe dele viraria retícula na tela toda
  float fine = smoothstep(px * 1.4, 0.0, dFine) * (1.0 - smoothstep(0.25, 0.6, r));
  float glow = exp(-dRing * 22.0) * 0.22 + exp(-dRay * 30.0) * 0.04;

  float centre = smoothstep(0.03, 0.16, r);
  float vig = 1.0 - smoothstep(0.55, 1.05, r) * 0.85;
  vec3 col = uInk2 * (ring * (0.85 + uFlash * 0.4) + glow)
           + uInk * (ray * 0.25 + fine * (0.06 + 0.5 * uFine))
           + uSoft * ring * uFlash * 0.3;
  outColor = vec4(dither(uCanvas + col * centre * vig), 1.0);
}`;

export interface MandalaMotion {
  zoom: number;
  rot: number;
  /** Velocidade angular (rad/s), amortecida. */
  spin: number;
  armed: boolean;
}

export function createMandalaMotion(): MandalaMotion {
  return { zoom: 0, rot: 0, spin: 0, armed: true };
}

const DCLOCK_MAX = 0.1;

/** Zoom e giro integrados pelo relógio virtual: o grave muda a
    velocidade do zoom, o kick dá um impulso que amortece. Muta e devolve `m`. */
export function stepMandala(m: MandalaMotion, sig: GlSignal, dClock: number): MandalaMotion {
  const dt = Math.min(Math.max(dClock, 0), DCLOCK_MAX);
  const swell = sig.swell < 0 ? 0 : sig.swell > 1 ? 1 : sig.swell;
  m.zoom += dt * (ZOOM_BASE + ZOOM_SWELL * swell);
  if (m.armed && sig.pulse > 0.5) {
    m.spin += SPIN_KICK * Math.min(1, sig.pulse);
    m.armed = false;
  } else if (!m.armed && sig.pulse < 0.2) m.armed = true;
  m.rot += dt * m.spin;
  m.spin *= Math.exp(-dt / SPIN_TAU);
  return m;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

class Mandala implements GlScene {
  private readonly prog: Program;
  private readonly m = createMandalaMotion();
  private lastClock: number | null = null;

  constructor(private readonly ctx: SceneCtx) {
    this.prog = makeProgram(ctx.gl, VS_TRI, FS, { label: "mandala" });
  }

  resize(): void {}

  frame(sig: GlSignal, pal: ScenePalette, _dt: number, w: number, h: number): void {
    const dClock = this.lastClock === null ? 0 : sig.clock - this.lastClock;
    this.lastClock = sig.clock;
    stepMandala(this.m, sig, dClock);
    const p = this.prog;
    p.use();
    p.common(sig, pal, w, h);
    p.f("uZoom", this.m.zoom);
    p.f("uRot", this.m.rot);
    p.f("uBreath", 0.06 * Math.max(-1, Math.min(1, sig.midRel)));
    p.f("uFine", clamp01(sig.highLift));
    p.f("uFlash", clamp01(sig.pulse));
    this.ctx.fullscreen();
  }

  dispose(): void {
    this.prog.dispose();
  }
}

export const mandala: SceneDef = {
  key: "mandala",
  create: (ctx) => new Mandala(ctx),
};
