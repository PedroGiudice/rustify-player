/* ============================================================
   scenes/dust.ts — Poeira: 6000 pontos em volume fluindo para a
   câmera, disco aditivo.

   Porte da versão em three (lab de 12/09): mesma câmera (55°, near
   0.1, far 200, olhando para (0,0,-30) com a deriva lenta), mesmos
   pontos, mesmo blending aditivo do three (SRC_ALPHA, ONE). O fluxo
   em z é integrado na CPU (gl/motion.ts, CMR-267): o shader só
   recebe o deslocamento pronto em uTravel.

   Reação (overdrive, 27/10): RELATIVA à média da faixa, como o
   Relevo e a Tinta. A versão anterior lia as bandas absolutas
   (tamanho com uLow, brilho com uLow/uHigh, fluxo com uMid) e, como
   o FFT é medido depois do volume e do limiter, música de grave
   forte deixava a nuvem inchada e acesa o tempo todo: o kick quase
   não aparecia. Agora:
     - fluxo: médios acima da média (midLift) aceleram, o kick dá um
       arranco (surge) que decai em ~1 batida — integrado na CPU;
     - kick: uma FRENTE de luz nasce perto da câmera e corre para o
       fundo da névoa (até 3 ao mesmo tempo); os grãos que ela
       atravessa crescem e acendem. Um evento por bumbo, no máximo
       ~3 por segundo (gl/kick.ts);
     - brilho e tamanho: swell (graves acima da média), highLift
       (agudos) e pulse, com base calibrada para a média ficar perto
       da antiga no sinal real (scenes.test.ts, replay).
   Com o beat-sync desligado (e na versão calma) o pulso é zero: sem
   frente, sem arranco, só a respiração lenta.
   ============================================================ */

import { HEAD } from "../glsl";
import { attribF, blend, clearTo, makeBuffer, makeProgram, type Program } from "../glkit";
import { createKickTrigger, stepKickTrigger, stepSurge, type KickTrigger } from "../kick";
import { lookAt, mat4, perspective } from "../mat4";
import { advanceDustTravel } from "../motion";
import type { GlScene, SceneCtx, SceneDef, ScenePalette } from "../scene";
import type { GlSignal } from "../signal";
import { drive } from "../react";

export const DUST_POINTS = 6000;
const TARGET = [0, 0, -30] as const;

/** Frentes de kick simultâneas (uniform vec3: uma por componente). */
export const DUST_WAVES = 3;
/** Velocidade da frente (u por segundo de relógio): atravessa os ~85 u
    da névoa em ~1,9 s — dá para seguir com o olho. */
export const DUST_WAVE_SPEED = 45;
/** Tau (s de relógio) do apagar da frente enquanto ela corre. */
export const DUST_WAVE_TAU = 0.8;
/** Onde a frente nasce (u da câmera): logo à frente, não colada nela. */
const DUST_WAVE_START = 3;

/** Posições e sementes na MESMA ordem de sorteio da versão three
    (x, y, z, semente por ponto): com o mesmo gerador, a nuvem é a mesma. */
export function dustCloud(n: number, rnd: () => number = Math.random): { pos: Float32Array; seed: Float32Array } {
  const pos = new Float32Array(n * 3);
  const seed = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = (rnd() - 0.5) * 70;
    pos[i * 3 + 1] = (rnd() - 0.5) * 40;
    pos[i * 3 + 2] = -rnd() * 90;
    seed[i] = rnd();
  }
  return { pos, seed };
}

/** Estado de movimento da Poeira (CPU). */
export interface DustMotion {
  travel: number;
  lastClock: number | null;
  surge: number;
  trig: KickTrigger;
  /** Distância da câmera de cada frente (u) e amplitude (0..1). */
  waveZ: Float32Array;
  waveA: Float32Array;
  next: number;
  /** Uniforms do quadro: brilho e escala do tamanho. */
  lum: number;
  size: number;
}

export function createDustMotion(): DustMotion {
  return {
    travel: 0,
    lastClock: null,
    surge: 0,
    trig: createKickTrigger(),
    waveZ: new Float32Array(DUST_WAVES).fill(1e3),
    waveA: new Float32Array(DUST_WAVES),
    next: 0,
    lum: 0,
    size: 1,
  };
}

/* Brilho e tamanho. Bases calibradas no replay do sinal real
   (fft-real-2609, cfg do CEO e defaults; scenes.test.ts): a média
   fica perto da versão absoluta, e a variação passa a acompanhar a
   música em vez de ficar presa no alto. */
export const DUST_LUM_BASE = 0.24;
export const DUST_SIZE_BASE = 1.2;

/* `level` (nível lento dos graves, com o ganho Bass) entra pouco e
   devagar: mantém o knob Bass mexendo no brilho geral, como antes, sem
   prender a nuvem no alto. O que pisca é o RELATIVO. */
export function dustLum(sig: GlSignal): number {
  return DUST_LUM_BASE + 0.25 * sig.level + 0.28 * drive(sig.swell) + 0.22 * drive(sig.highLift) + 0.16 * sig.pulse;
}

export function dustSize(sig: GlSignal): number {
  return DUST_SIZE_BASE + 0.5 * sig.level + 0.4 * drive(sig.swell) + 0.45 * sig.pulse;
}

/** Avança o estado um quadro. dt = parede (detector do kick, surge);
    o resto anda no relógio virtual (Speed = 0 congela). */
export function stepDust(m: DustMotion, sig: GlSignal, dt: number): void {
  const dClock = m.lastClock === null ? 0 : Math.max(0, sig.clock - m.lastClock);
  m.lastClock = sig.clock;
  m.surge = stepSurge(m.surge, sig.pulse, dt);
  m.travel = advanceDustTravel(m.travel, dClock, drive(sig.midLift), m.surge);

  // Detecta no onset (sem depth); o depth só dá a força da frente.
  if (stepKickTrigger(m.trig, sig.onset, dt)) {
    m.waveZ[m.next] = DUST_WAVE_START;
    m.waveA[m.next] = 0.55 + 0.45 * Math.min(1, sig.pulse);
    m.next = (m.next + 1) % DUST_WAVES;
  }
  const fade = Math.exp(-dClock / DUST_WAVE_TAU);
  for (let k = 0; k < DUST_WAVES; k++) {
    m.waveZ[k] = Math.min(1e3, m.waveZ[k] + dClock * DUST_WAVE_SPEED);
    m.waveA[k] *= fade;
  }
  m.lum = dustLum(sig);
  m.size = dustSize(sig);
}

const VS = HEAD + `
in vec3 position; in float aSeed;
out float vSeed; out float vDepth; out float vWave;
uniform mat4 uView,uProj;
uniform float uTime,uTravel,uSize;
uniform vec3 uWaveZ,uWaveA;
// Frente do kick: casca gaussiana de ~4 u em torno de cada distância.
float shell(float d,float z,float a){float x=(d-z)*0.25;return a*exp(-x*x);}
void main(){
  vSeed=aSeed;
  vec3 p=position;
  p.z=mod(p.z+uTravel+aSeed*90.0,90.0)-85.0;
  p.x+=sin(uTime*0.4+aSeed*40.0)*1.6; p.y+=cos(uTime*0.33+aSeed*31.0)*1.1;
  vec4 mv=uView*vec4(p,1.0);
  float d=-mv.z; vDepth=clamp(1.0-d/85.0,0.0,1.0);
  float w=shell(d,uWaveZ.x,uWaveA.x)+shell(d,uWaveZ.y,uWaveA.y)+shell(d,uWaveZ.z,uWaveA.z);
  vWave=min(w,1.0);
  float size=(1.6+2.4*aSeed)*uSize*(1.0+0.7*vWave);
  gl_PointSize=size*(160.0/d);
  gl_Position=uProj*mv;
}`;

const FS = HEAD + `
in float vSeed; in float vDepth; in float vWave;
uniform vec3 uInk,uInk2,uSoft; uniform float uLum;
out vec4 outColor;
void main(){
  vec2 q=gl_PointCoord-0.5; float d=length(q);
  float a=smoothstep(0.5,0.05,d); a*=a;
  // Semente > 0,8 usa o soft no lugar do ink2: step escolhe, sem ramo.
  vec3 col=mix(uInk,mix(uInk2,uSoft,step(0.8,vSeed)),vSeed);
  // A frente puxa o grão para o soft (o tom claro do tema) e acende.
  col=mix(col,uSoft,0.35*vWave);
  float lum=uLum+0.55*vWave;
  outColor=vec4(col*lum*(0.35+0.65*vDepth),a*min(1.0,0.25+0.75*vDepth+0.4*vWave));
}`;

class Dust implements GlScene {
  private readonly gl: WebGL2RenderingContext;
  private readonly prog: Program;
  private readonly vao: WebGLVertexArrayObject;
  private readonly bufs: WebGLBuffer[];
  private readonly view = mat4();
  private readonly proj = mat4();
  private readonly eye: [number, number, number] = [0, 0, 10];
  private readonly m = createDustMotion();

  constructor(ctx: SceneCtx) {
    const gl = (this.gl = ctx.gl);
    this.prog = makeProgram(gl, VS, FS, { label: "dust" });
    const { pos, seed } = dustCloud(DUST_POINTS);
    const bPos = makeBuffer(gl, pos);
    const bSeed = makeBuffer(gl, seed);
    this.bufs = [bPos, bSeed];
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    attribF(gl, this.prog.attrib("position"), bPos, 3);
    attribF(gl, this.prog.attrib("aSeed"), bSeed, 1);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  resize(w: number, h: number): void {
    perspective(this.proj, 55, w / h, 0.1, 200);
  }

  frame(sig: GlSignal, pal: ScenePalette, dt: number, w: number, h: number): void {
    const gl = this.gl;
    const m = this.m;
    stepDust(m, sig, dt);

    this.eye[0] = Math.sin(sig.clock * 0.11) * 1.2;
    this.eye[1] = Math.cos(sig.clock * 0.09) * 0.8;
    lookAt(this.view, this.eye, TARGET);

    clearTo(gl, pal.canvas);
    blend(gl, "add-alpha");
    const p = this.prog;
    p.use();
    p.common(sig, pal, w, h);
    p.f("uTravel", m.travel);
    p.f("uLum", m.lum);
    p.f("uSize", m.size);
    p.v3("uWaveZ", m.waveZ);
    p.v3("uWaveA", m.waveA);
    p.m4("uView", this.view);
    p.m4("uProj", this.proj);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.POINTS, 0, DUST_POINTS);
    gl.bindVertexArray(null);
    blend(gl, "off");
  }

  dispose(): void {
    const gl = this.gl;
    this.prog.dispose();
    for (const b of this.bufs) gl.deleteBuffer(b);
    gl.deleteVertexArray(this.vao);
  }
}

export const dust: SceneDef = {
  key: "dust",
  create: (ctx) => new Dust(ctx),
};
