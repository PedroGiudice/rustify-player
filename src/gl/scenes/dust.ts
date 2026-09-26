/* ============================================================
   scenes/dust.ts — Poeira: 6000 pontos em volume fluindo para a
   câmera, disco aditivo.

   Porte fiel da versão em three (lab de 12/09): mesma câmera
   (55°, near 0.1, far 200, olhando para (0,0,-30) com a deriva
   lenta), mesmos pontos, mesmo blending aditivo do three
   (SRC_ALPHA, ONE). O fluxo em z é integrado na CPU (gl/motion.ts,
   CMR-267): o shader só recebe o deslocamento pronto em uTravel.
   ============================================================ */

import { HEAD } from "../glsl";
import { attribF, blend, clearTo, makeBuffer, makeProgram, type Program } from "../glkit";
import { lookAt, mat4, perspective } from "../mat4";
import { advanceDustTravel } from "../motion";
import type { GlScene, SceneCtx, SceneDef, ScenePalette } from "../scene";
import type { GlSignal } from "../signal";

export const DUST_POINTS = 6000;
const TARGET = [0, 0, -30] as const;

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

const VS = HEAD + `
in vec3 position; in float aSeed;
out float vSeed; out float vDepth;
uniform mat4 uView,uProj;
uniform float uTime,uLow,uBeat,uTravel;
void main(){
  vSeed=aSeed;
  vec3 p=position;
  p.z=mod(p.z+uTravel+aSeed*90.0,90.0)-85.0;
  p.x+=sin(uTime*0.4+aSeed*40.0)*1.6; p.y+=cos(uTime*0.33+aSeed*31.0)*1.1;
  vec4 mv=uView*vec4(p,1.0);
  float d=-mv.z; vDepth=clamp(1.0-d/85.0,0.0,1.0);
  float size=(1.6+2.4*aSeed)*(1.0+0.9*uLow+0.6*uBeat);
  gl_PointSize=size*(160.0/d);
  gl_Position=uProj*mv;
}`;

const FS = HEAD + `
in float vSeed; in float vDepth;
uniform vec3 uInk,uInk2,uSoft; uniform float uLow,uHigh;
out vec4 outColor;
void main(){
  vec2 q=gl_PointCoord-0.5; float d=length(q);
  float a=smoothstep(0.5,0.05,d); a*=a;
  vec3 col=mix(uInk,vSeed>0.8?uSoft:uInk2,vSeed);
  float lum=0.22+0.55*uLow+0.35*uHigh;
  outColor=vec4(col*lum*(0.35+0.65*vDepth),a*(0.25+0.75*vDepth));
}`;

class Dust implements GlScene {
  private readonly gl: WebGL2RenderingContext;
  private readonly prog: Program;
  private readonly vao: WebGLVertexArrayObject;
  private readonly bufs: WebGLBuffer[];
  private readonly view = mat4();
  private readonly proj = mat4();
  private readonly eye: [number, number, number] = [0, 0, 10];
  private travel = 0;
  private lastClock: number | null = null;

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

  frame(sig: GlSignal, pal: ScenePalette, _dt: number, w: number, h: number): void {
    const gl = this.gl;
    // Avanço do relógio VIRTUAL (não o dt de parede): bgSpeed e o
    // beat-sync seguem valendo para a deriva.
    const dClock = this.lastClock === null ? 0 : sig.clock - this.lastClock;
    this.lastClock = sig.clock;
    this.travel = advanceDustTravel(this.travel, dClock, sig.mid);

    this.eye[0] = Math.sin(sig.clock * 0.11) * 1.2;
    this.eye[1] = Math.cos(sig.clock * 0.09) * 0.8;
    lookAt(this.view, this.eye, TARGET);

    clearTo(gl, pal.canvas);
    blend(gl, "add-alpha");
    const p = this.prog;
    p.use();
    p.common(sig, pal, w, h);
    p.f("uTravel", this.travel);
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
