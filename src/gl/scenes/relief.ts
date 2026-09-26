/* ============================================================
   scenes/relief.ts — Relevo: plano deslocado por ruído no vértice,
   wireframe com névoa.

   Porte fiel da versão em three: PlaneGeometry(150, 110, 120, 88)
   deitado no XZ, câmera de 50° em (x, 13, 42) olhando para
   (0, -2, -20), blending alfa do three. O wireframe é desenhado
   com GL_LINES sobre o MESMO índice que o three montava (as três
   arestas de cada triângulo, diagonal e repetição incluídas — ver
   gl/geometry.ts), então a malha e a opacidade das linhas não mudam.
   ============================================================ */

import { HEAD, NOISE } from "../glsl";
import { attribF, blend, clearTo, makeBuffer, makeProgram, type Program } from "../glkit";
import { planeGridXZ, wireframeIndices } from "../geometry";
import { lookAt, mat4, perspective } from "../mat4";
import type { GlScene, SceneCtx, SceneDef, ScenePalette } from "../scene";
import type { GlSignal } from "../signal";

export const RELIEF_GRID = { width: 150, height: 110, gx: 120, gy: 88 } as const;
const TARGET = [0, -2, -20] as const;

const VS = HEAD + NOISE + `
in vec3 position;
uniform mat4 uView,uProj;
uniform float uTime,uLow,uMid,uBeat;
out float vH; out float vD;
void main(){
  vec3 p=position;
  vec2 q=p.xz*0.045+vec2(0.0,uTime*0.10);
  float h=fbm(q)*(5.5+5.0*uLow+3.0*uBeat);
  float ridge=sin(p.x*0.22+uTime*0.9)*exp(-abs(p.z+15.0)*0.05)*6.0*uMid;
  p.y+=h+ridge;
  vH=clamp((h+ridge)/12.0,0.0,1.0);
  vec4 mv=uView*vec4(p,1.0); vD=-mv.z;
  gl_Position=uProj*mv;
}`;

const FS = HEAD + `
uniform vec3 uCanvas,uInk,uInk2,uSoft; uniform float uHigh;
in float vH; in float vD;
out vec4 outColor;
void main(){
  float fog=smoothstep(140.0,25.0,vD);
  vec3 col=mix(uInk,uInk2,vH);
  col=mix(col,uSoft,uHigh*0.35*vH);
  outColor=vec4(col,(0.10+0.55*vH)*fog);
}`;

class Relief implements GlScene {
  private readonly gl: WebGL2RenderingContext;
  private readonly prog: Program;
  private readonly vao: WebGLVertexArrayObject;
  private readonly vbo: WebGLBuffer;
  private readonly ibo: WebGLBuffer;
  private readonly count: number;
  private readonly indexType: number;
  private readonly view = mat4();
  private readonly proj = mat4();
  private readonly eye: [number, number, number] = [0, 13, 42];

  constructor(ctx: SceneCtx) {
    const gl = (this.gl = ctx.gl);
    this.prog = makeProgram(gl, VS, FS, { label: "relief" });
    const { width, height, gx, gy } = RELIEF_GRID;
    const idx = wireframeIndices(gx, gy);
    this.count = idx.length;
    this.indexType = idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    this.vbo = makeBuffer(gl, planeGridXZ(width, height, gx, gy));
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    attribF(gl, this.prog.attrib("position"), this.vbo, 3);
    // O ELEMENT_ARRAY_BUFFER fica gravado no VAO: ligar com o VAO ativo.
    this.ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
  }

  resize(w: number, h: number): void {
    perspective(this.proj, 50, w / h, 0.1, 300);
  }

  frame(sig: GlSignal, pal: ScenePalette, _dt: number, w: number, h: number): void {
    const gl = this.gl;
    this.eye[0] = Math.sin(sig.clock * 0.07) * 4;
    lookAt(this.view, this.eye, TARGET);

    clearTo(gl, pal.canvas);
    blend(gl, "alpha");
    const p = this.prog;
    p.use();
    p.common(sig, pal, w, h);
    p.m4("uView", this.view);
    p.m4("uProj", this.proj);
    gl.bindVertexArray(this.vao);
    gl.drawElements(gl.LINES, this.count, this.indexType, 0);
    gl.bindVertexArray(null);
    blend(gl, "off");
  }

  dispose(): void {
    const gl = this.gl;
    this.prog.dispose();
    gl.deleteBuffer(this.vbo);
    gl.deleteBuffer(this.ibo);
    gl.deleteVertexArray(this.vao);
  }
}

export const relief: SceneDef = {
  key: "relief",
  create: (ctx) => new Relief(ctx),
};
