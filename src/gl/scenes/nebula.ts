/* ============================================================
   scenes/nebula.ts — Nébula: fbm com domain warping num triângulo
   de tela cheia. Sem geometria, custo todo em fillrate.

   São 25 ruídos simplex por pixel. Em resolução cheia custava
   23-24 ms por quadro na cmr-auto (UHD 620, 1366x768), mais que um
   quadro inteiro de 60 fps; por isso a cena pede o buffer reduzido
   do motor (maxRows = NEBULA_MAX_ROWS, gl/budget.ts): o motor a
   desenha em no máximo 256 linhas e compõe na tela com filtro
   linear + dither IGN, exatamente o que a versão three fazia.
   ============================================================ */

import { FS_COMMON, HEAD, NOISE, VS_TRI } from "../glsl";
import { makeProgram, type Program } from "../glkit";
import { NEBULA_MAX_ROWS } from "../budget";
import type { GlScene, SceneCtx, SceneDef, ScenePalette } from "../scene";
import type { GlSignal } from "../signal";

const FS = HEAD + FS_COMMON + NOISE + `
void main(){
  vec2 uv=gl_FragCoord.xy/uRes; vec2 p=(uv-0.5)*vec2(uRes.x/uRes.y,1.0)*1.6;
  float t=uTime*0.06;
  vec2 q=vec2(fbm(p+t),fbm(p+vec2(5.2,1.3)-t));
  vec2 r=vec2(fbm(p+1.7*q*(0.8+0.6*uLow)+vec2(1.7,9.2)+t*0.7),fbm(p+1.7*q+vec2(8.3,2.8)-t*0.5));
  float f=fbm(p+2.0*r);
  float body=smoothstep(0.15,0.95,f*0.5+0.5);
  vec3 col=mix(uCanvas,uInk,body*(0.35+0.5*uLow+0.2*uBeat));
  col=mix(col,uInk2,smoothstep(0.55,0.95,length(r))*uMid*0.5);
  col+=uSoft*pow(max(0.0,f),3.0)*uHigh*0.35;
  float vig=1.0-0.45*dot(uv-0.5,uv-0.5)*2.0;
  outColor=vec4(col*vig,1.0);
}`;

class Nebula implements GlScene {
  private readonly prog: Program;

  constructor(private readonly ctx: SceneCtx) {
    this.prog = makeProgram(ctx.gl, VS_TRI, FS, { label: "nebula" });
  }

  resize(): void {}

  frame(sig: GlSignal, pal: ScenePalette, _dt: number, w: number, h: number): void {
    this.prog.use();
    this.prog.common(sig, pal, w, h);
    this.ctx.fullscreen();
  }

  dispose(): void {
    this.prog.dispose();
  }
}

export const nebula: SceneDef = {
  key: "nebula",
  maxRows: NEBULA_MAX_ROWS,
  create: (ctx) => new Nebula(ctx),
};
