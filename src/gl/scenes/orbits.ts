/* ============================================================
   scenes/orbits.ts — Órbitas: 40 anéis inclinados ao longo de z;
   a câmera atravessa o túnel.

   Porte fiel da versão em three, com uma diferença só de custo:
   os 40 anéis saem numa chamada instanciada (LINE_STRIP x 40) em
   vez de 40 objetos. Cada anel continua sendo o círculo de 128
   segmentos transformado como o three fazia (escala, giro em z,
   giro em x, posição em z) e pintado como o LineBasicMaterial:
   cor + opacidade, blending aditivo do three (SRC_ALPHA, ONE) e a
   codificação sRGB na saída que o material embutido aplicava.

   O movimento é integrado na CPU (zoff e o giro em z somam delta de
   relógio x velocidade) — é o exemplo que o CLAUDE.md dá da regra.
   Reação relativa à faixa e onda do kick: ver stepOrbits.
   ============================================================ */

import { HEAD, SRGB_OETF } from "../glsl";
import { attribF, blend, clearTo, makeBuffer, makeProgram, type Program } from "../glkit";
import { circleStrip } from "../geometry";
import { createPulseHistory, pulseAgo, pushPulse, type PulseHistory } from "../kick";
import { mat4, perspective, translation } from "../mat4";
import type { GlScene, SceneCtx, SceneDef, ScenePalette } from "../scene";
import type { GlSignal } from "../signal";

export const ORBIT_RINGS = 40;
export const ORBIT_SEG = 128;
/** Espaçamento em z entre anéis; o túnel tem ORBIT_RINGS x isso. */
export const ORBIT_GAP = 3.2;

/** Floats por anel no buffer de instância: (z, escala, giroX, giroZ) +
    (r, g, b, opacidade). */
export const ORBIT_STRIDE = 8;

export interface OrbitRing {
  i: number;
  base: number;
  tilt: number;
  spin: number;
  radius: number;
  /** Giro em z acumulado (rad). */
  rotZ: number;
}

export function makeOrbitRings(n = ORBIT_RINGS): OrbitRing[] {
  const rings: OrbitRing[] = [];
  for (let i = 0; i < n; i++) {
    rings.push({
      i,
      base: -i * ORBIT_GAP,
      tilt: 0.35 + Math.sin(i * 0.7) * 0.25,
      spin: (0.12 + (i % 5) * 0.04) * (i % 2 ? 1 : -1),
      radius: 9 + Math.sin(i * 0.45) * 3,
      rotZ: 0,
    });
  }
  return rings;
}

export interface OrbitState {
  rings: OrbitRing[];
  zoff: number;
  /** Relógio do quadro anterior (null = primeiro quadro). */
  lastClock: number | null;
  /** Pulso dos últimos segundos: a onda do kick desce o túnel lendo
      o pulso de quando ela "passou" por cada anel. */
  hist: PulseHistory;
}

/** Velocidade do túnel (u por segundo de relógio): base e o quanto os
    graves acima da média (swell) somam. */
export const ORBIT_V_BASE = 2.5;
export const ORBIT_V_SWELL = 2.5;
/** Velocidade da onda do kick ao longo do túnel (u por segundo de
    relógio): percorre os 128 u em ~1,8 s, legível como "desceu". */
export const ORBIT_WAVE_SPEED = 70;
/** Dilatação do anel quando a onda passa (fração do raio). */
export const ORBIT_KICK_DILATE = 0.16;
/** Base da opacidade (multiplica a curva de profundidade). Calibrada no
    replay do sinal real para a média ficar perto da antiga (0,4 + 0,6 x
    agudos absolutos), contando agudos relativos e a onda do kick. */
export const ORBIT_OP_BASE = 0.36;

export function createOrbitState(): OrbitState {
  return {
    rings: makeOrbitRings(),
    zoff: 0,
    lastClock: null,
    hist: createPulseHistory((ORBIT_RINGS * ORBIT_GAP) / ORBIT_WAVE_SPEED + 0.2),
  };
}

/**
 * Avança o túnel um quadro e escreve os atributos de instância em `out`.
 * Puro (sem GL) para ser testável. Cores em float 0..1, lineares — a
 * codificação sRGB é feita no shader, como o three fazia.
 *
 * Tudo anda no RELÓGIO VIRTUAL (delta de sig.clock): Speed = 0 congela o
 * túnel inteiro, a versão calma anda a 1/4 (até 27/10 o avanço em z usava
 * o dt de parede e ignorava o Speed). Reação relativa à faixa: swell
 * acelera e ondula, midLift gira, highLift acende, e o kick (pulse) vira
 * uma onda que nasce perto da câmera e desce o túnel dilatando e
 * acendendo cada anel que atravessa.
 */
export function stepOrbits(
  st: OrbitState,
  sig: GlSignal,
  _dt: number,
  pal: ScenePalette,
  out: Float32Array,
): void {
  const dClock = st.lastClock === null ? 0 : Math.max(0, sig.clock - st.lastClock);
  st.lastClock = sig.clock;
  pushPulse(st.hist, sig.pulse, dClock);
  st.zoff += dClock * (ORBIT_V_BASE + ORBIT_V_SWELL * sig.swell);
  const L = st.rings.length * ORBIT_GAP;
  for (const r of st.rings) {
    const z = ((((r.base + st.zoff) % L) + L) % L) - L + 12;
    const dist = 12 - z;
    const wave = pulseAgo(st.hist, dist / ORBIT_WAVE_SPEED);
    // Ondulação dos graves: fase por anel (relógio x constante, nunca
    // relógio x sinal) com amplitude no swell.
    const s = r.radius * (1 + 0.08 * sig.swell * Math.sin(sig.clock * 1.3 + r.i * 0.55) + ORBIT_KICK_DILATE * wave);
    const rotX = r.tilt + Math.sin(sig.clock * 0.3 + r.i * 0.2) * 0.15;
    r.rotZ += dClock * r.spin * (1 + 1.5 * sig.midLift);
    const depth = Math.min(1, Math.max(0, 1 - dist / L));
    // A versão three multiplicava ainda por (1 - near), com near =
    // MathUtils.smoothstep(z, 12, 6). Com min > max essa função devolve 0
    // para todo z <= 12 — e z nunca passa de 12 —, então o fator sempre
    // foi 1. Fica de fora; fade perto da câmera seria mudança visual.
    const opacity = (0.08 + 0.6 * depth * depth) * (ORBIT_OP_BASE + 0.35 * sig.highLift + 0.5 * wave);
    const base = r.i % 3 === 0 ? pal.ink2 : pal.ink;
    const t = Math.min(1, sig.highLift * 0.25 * depth + 0.3 * wave);
    const o = r.i * ORBIT_STRIDE;
    out[o] = z;
    out[o + 1] = s;
    out[o + 2] = rotX;
    out[o + 3] = r.rotZ;
    out[o + 4] = base[0] + (pal.soft[0] - base[0]) * t;
    out[o + 5] = base[1] + (pal.soft[1] - base[1]) * t;
    out[o + 6] = base[2] + (pal.soft[2] - base[2]) * t;
    out[o + 7] = opacity;
  }
}

const VS = HEAD + `
in vec3 position; in vec4 aXf; in vec4 aCol;
uniform mat4 uView,uProj;
out vec4 vCol;
void main(){
  // Mesma composição do Object3D do three: T(z) * Rx * Rz * S(s,s,1).
  vec2 p=position.xy*aXf.y;
  float cz=cos(aXf.w), sz=sin(aXf.w);
  vec3 q=vec3(cz*p.x-sz*p.y, sz*p.x+cz*p.y, 0.0);
  float cx=cos(aXf.z), sx=sin(aXf.z);
  q=vec3(q.x, cx*q.y-sx*q.z, sx*q.y+cx*q.z);
  q.z+=aXf.x;
  vCol=aCol;
  gl_Position=uProj*(uView*vec4(q,1.0));
}`;

const FS = HEAD + SRGB_OETF + `
in vec4 vCol; out vec4 outColor;
void main(){ outColor=vec4(srgbOetf(vCol.rgb),vCol.a); }`;

class Orbits implements GlScene {
  private readonly gl: WebGL2RenderingContext;
  private readonly prog: Program;
  private readonly vao: WebGLVertexArrayObject;
  private readonly circle: WebGLBuffer;
  private readonly inst: WebGLBuffer;
  private readonly data = new Float32Array(ORBIT_RINGS * ORBIT_STRIDE);
  private readonly st: OrbitState = createOrbitState();
  private readonly view = mat4();
  private readonly proj = mat4();

  constructor(ctx: SceneCtx) {
    const gl = (this.gl = ctx.gl);
    this.prog = makeProgram(gl, VS, FS, { label: "orbits" });
    this.circle = makeBuffer(gl, circleStrip(ORBIT_SEG));
    this.inst = makeBuffer(gl, this.data.byteLength, gl.DYNAMIC_DRAW);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    attribF(gl, this.prog.attrib("position"), this.circle, 3);
    const B = ORBIT_STRIDE * 4;
    attribF(gl, this.prog.attrib("aXf"), this.inst, 4, B, 0, 1);
    attribF(gl, this.prog.attrib("aCol"), this.inst, 4, B, 16, 1);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  resize(w: number, h: number): void {
    perspective(this.proj, 60, w / h, 0.1, 200);
  }

  frame(sig: GlSignal, pal: ScenePalette, dt: number): void {
    const gl = this.gl;
    stepOrbits(this.st, sig, dt, pal, this.data);
    // Câmera sem rotação: a vista é só a translação por -posição.
    translation(this.view, -Math.sin(sig.clock * 0.2) * 0.6, -Math.cos(sig.clock * 0.17) * 0.4, -12);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);

    clearTo(gl, pal.canvas);
    blend(gl, "add-alpha");
    const p = this.prog;
    p.use();
    p.m4("uView", this.view);
    p.m4("uProj", this.proj);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.LINE_STRIP, 0, ORBIT_SEG + 1, ORBIT_RINGS);
    gl.bindVertexArray(null);
    blend(gl, "off");
  }

  dispose(): void {
    const gl = this.gl;
    this.prog.dispose();
    gl.deleteBuffer(this.circle);
    gl.deleteBuffer(this.inst);
    gl.deleteVertexArray(this.vao);
  }
}

export const orbits: SceneDef = {
  key: "orbits",
  create: (ctx) => new Orbits(ctx),
};
