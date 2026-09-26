/* ============================================================
   scenes/bokeh.ts — Palco: 48 luzes de palco fora de foco,
   instanciadas em três planos.

   Porte fiel do lab v2 (docs/design-refs/fundo-lab-v2, classe
   Bokeh): mesmos shaders, mesmas constantes, mesma reação ao
   sinal. O plano de fundo é a treliça do palco (duas fileiras de
   refletores no alto); meio e frente são luzes soltas, maiores e
   mais apagadas. Abertura de 6 lâminas com a MESMA rotação em todas
   as luzes (é uma lente só), borda um pouco mais clara (aberração
   esférica), halo que vaza da borda e franja cromática por três
   avaliações do SDF em escalas vizinhas.

   Sinal: graves acendem todas; o kick (beat) estoura o clarão nas
   luzes marcadas; agudos cintilam a treliça; médios aceleram a
   deriva — que é integrada na CPU (advanceBokehDrift, CMR-267) e
   entra pronta em uDrift.

   Custo medido no lab na cmr-auto (UHD 620, 1366x768): ~2 ms por
   quadro. Resolução cheia: o disco tem borda nítida e a franja é de
   1-2 px, que o buffer reduzido borraria.
   ============================================================ */

import { FS_COMMON, HEAD, UNI, VS_TRI } from "../glsl";
import { attribF, blend, makeBuffer, makeProgram, type Program } from "../glkit";
import type { GlScene, SceneCtx, SceneDef, ScenePalette } from "../scene";
import type { GlSignal } from "../signal";

export const BOKEH_LIGHTS = 48;
/** Luzes [0, BOKEH_BACK) = plano de fundo (treliça). */
export const BOKEH_BACK = 26;
/** Luzes [BOKEH_BACK, BOKEH_MID) = plano do meio; o resto é a frente. */
export const BOKEH_MID = 40;
/** Floats por luz: aA (x, y, plano, cor) + aB (raio, fase, clarão, cintilação). */
export const BOKEH_STRIDE = 8;

/**
 * Disposição das luzes, na ordem de sorteio do lab: com o mesmo
 * gerador, o palco é o mesmo.
 *   aA = (x 0..1, y 0..1, plano 0/1/2, sorteio de cor)
 *   aB = (sorteio de raio, fase, clarão 0/1, frequência de cintilação 2..7)
 * No fundo, x e y são a treliça (13 colunas, fileiras em 0,80 e 0,90,
 * com 1% de jitter) e o clarão não é sorteado.
 */
export function bokehLights(rnd: () => number = Math.random): Float32Array {
  const d = new Float32Array(BOKEH_LIGHTS * BOKEH_STRIDE);
  for (let i = 0; i < BOKEH_LIGHTS; i++) {
    const layer = i < BOKEH_BACK ? 0 : i < BOKEH_MID ? 1 : 2;
    const bx = layer === 0 ? (Math.floor(i / 2) + 0.5) / 13 + (rnd() - 0.5) * 0.02 : rnd();
    const by = layer === 0 ? 0.8 + (i % 2) * 0.1 + (rnd() - 0.5) * 0.02 : rnd();
    const o = i * BOKEH_STRIDE;
    d[o] = bx;
    d[o + 1] = by;
    d[o + 2] = layer;
    d[o + 3] = rnd();
    d[o + 4] = rnd();
    d[o + 5] = rnd();
    d[o + 6] = layer > 0 && rnd() < 0.2 ? 1 : 0;
    d[o + 7] = 2 + rnd() * 5;
  }
  return d;
}

/**
 * Avança a deriva das luzes um quadro: 0,25/s parado, até 0,85/s com
 * os médios no máximo. O sinal muda a VELOCIDADE; a posição é esta
 * soma, nunca `uTime * (a + b*sinal)`.
 */
export function advanceBokehDrift(drift: number, dt: number, mid: number): number {
  return drift + Math.max(0, dt) * (0.25 + 0.6 * mid);
}

/** Fundo: preto com um véu da tinta subindo para o alto (a treliça). */
const FS_BG = HEAD + FS_COMMON + `
void main(){
  vec2 uv=gl_FragCoord.xy/uRes;
  vec3 col=uCanvas+mix(uSoft,uInk,0.5)*0.035*smoothstep(0.2,1.0,uv.y)*(0.7+0.3*uLow);
  outColor=vec4(dither(col),1.0);
}`;

const VS_DISC = HEAD + UNI + `
in vec2 aCorner; in vec4 aA; in vec4 aB; uniform float uDrift;
out vec2 vL; out vec3 vCol; out float vI; out float vEdge;
void main(){
  float a=uRes.x/uRes.y;
  float layer=aA.z;
  vec2 base=vec2((aA.x-0.5)*(a+0.2),(aA.y-0.5)*1.15);
  float amp=layer<0.5?0.008:(layer<1.5?0.05:0.09);
  vec2 c=base+amp*vec2(sin(uDrift*(0.21+0.17*aB.y)+aB.y*6.28),cos(uDrift*(0.17+0.13*aB.x)+aB.y*4.1));
  float R=layer<0.5?mix(0.010,0.024,aB.x):(layer<1.5?mix(0.040,0.070,aB.x):mix(0.11,0.19,aB.x));
  float flare=aB.z*smoothstep(0.45,0.95,uBeat);
  R*=1.0+0.10*flare;
  float I=layer<0.5?1.0:(layer<1.5?0.55:0.18);
  float tw=layer<0.5?(1.0+0.9*uHigh*sin(uTime*aB.w+aB.y*20.0)):1.0;
  I*=tw*(0.55+0.45*uLow)*(1.0+1.8*flare);
  vCol=aA.w<0.5?uInk:(aA.w<0.86?uInk2:mix(uInk2,vec3(1.0),0.45));
  vI=I; vL=aCorner*1.15;
  vEdge=layer<0.5?0.16:(layer<1.5?0.11:0.07);
  vec2 q=c+aCorner*1.15*R;
  gl_Position=vec4(q.x/(0.5*a),q.y/0.5,0.0,1.0);
}`;

const FS_DISC = HEAD + `
in vec2 vL; in vec3 vCol; in float vI; in float vEdge; out vec4 outColor;
float sdHex(vec2 p,float r){const vec3 k=vec3(-0.866025404,0.5,0.577350269);p=abs(p);p-=2.0*min(dot(k.xy,p),0.0)*k.xy;p-=vec2(clamp(p.x,-k.z*r,k.z*r),r);return length(p)*sign(p.y);}
float ap(vec2 l){const float c=0.9659258,s=0.2588190;l=mat2(c,-s,s,c)*l;return mix(sdHex(l,0.88),length(l)-1.0,0.4);}
float prof(float d,float e){
  float inside=1.0-smoothstep(-e,e,d);
  float bubble=0.50+0.50*smoothstep(-0.55,0.0,d);      // centro um pouco mais escuro, borda acesa
  float rim=exp(-abs(d+0.04)*22.0)*0.35;
  float halo=exp(-max(d,0.0)*9.0)*0.10;                // luz que vaza da borda
  return inside*(bubble+rim)+halo;
}
void main(){
  float r=prof(ap(vL*1.012),vEdge), g=prof(ap(vL),vEdge), b=prof(ap(vL*0.988),vEdge);
  vec3 c=vCol*vec3(r,g,b)*vI;
  float n=fract(52.9829189*fract(dot(gl_FragCoord.xy,vec2(0.06711056,0.00583715))));
  outColor=vec4(c+step(0.001,g)*(n-0.5)/255.0,1.0);
}`;

/** Quad unitário em dois triângulos (os cantos do disco). */
const QUAD = new Float32Array([-1, -1, 1, -1, 1, 1, -1, -1, 1, 1, -1, 1]);

class Bokeh implements GlScene {
  private readonly gl: WebGL2RenderingContext;
  private readonly bg: Program;
  private readonly disc: Program;
  private readonly vao: WebGLVertexArrayObject;
  private readonly qbuf: WebGLBuffer;
  private readonly ibuf: WebGLBuffer;
  private drift = 0;

  constructor(private readonly ctx: SceneCtx) {
    const gl = (this.gl = ctx.gl);
    this.bg = makeProgram(gl, VS_TRI, FS_BG, { label: "bokeh/fundo" });
    try {
      this.disc = makeProgram(gl, VS_DISC, FS_DISC, { label: "bokeh/luzes" });
    } catch (e) {
      this.bg.dispose();
      throw e;
    }
    this.qbuf = makeBuffer(gl, QUAD);
    this.ibuf = makeBuffer(gl, bokehLights());
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    attribF(gl, this.disc.attrib("aCorner"), this.qbuf, 2);
    const B = BOKEH_STRIDE * 4;
    attribF(gl, this.disc.attrib("aA"), this.ibuf, 4, B, 0, 1);
    attribF(gl, this.disc.attrib("aB"), this.ibuf, 4, B, 16, 1);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  resize(): void {}

  frame(sig: GlSignal, pal: ScenePalette, dt: number, w: number, h: number): void {
    const gl = this.gl;
    this.drift = advanceBokehDrift(this.drift, dt, sig.mid);

    // Fundo pinta todos os pixels, sem blending: dispensa clear.
    this.bg.use();
    this.bg.common(sig, pal, w, h);
    this.ctx.fullscreen();

    blend(gl, "add");
    const d = this.disc;
    d.use();
    d.common(sig, pal, w, h);
    d.f("uDrift", this.drift);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 6, BOKEH_LIGHTS);
    gl.bindVertexArray(null);
    blend(gl, "off");
  }

  dispose(): void {
    const gl = this.gl;
    this.bg.dispose();
    this.disc.dispose();
    gl.deleteBuffer(this.qbuf);
    gl.deleteBuffer(this.ibuf);
    gl.deleteVertexArray(this.vao);
  }
}

export const bokeh: SceneDef = {
  key: "bokeh",
  create: (ctx) => new Bokeh(ctx),
};
