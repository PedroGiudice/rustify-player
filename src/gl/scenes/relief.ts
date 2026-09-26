/* ============================================================
   scenes/relief.ts — Relevo: plano deslocado por ruído no vértice,
   com névoa, em cinco variantes de linha (26/09, o CEO escolhe
   vendo). O estilo vem de effectiveReliefStyle() (gl/meta.ts), lido
   a cada quadro: trocar no painel ou na medição vale no quadro
   seguinte, sem remontar a cena.

   "original": porte fiel da versão em three, INTACTO — é a
   referência. PlaneGeometry(150, 110, 120, 88) deitado no XZ, câmera
   de 50° em (x, 13, 42) olhando para (0, -2, -20), blending alfa do
   three. O wireframe é desenhado com GL_LINES sobre o MESMO índice que
   o three montava (as três arestas de cada triângulo, diagonal e
   repetição incluídas — ver gl/geometry.ts), com o brilho variando
   pela altura e pela música. Ignora os eixos forma e superfície.

   Todas as outras variantes seguem a decisão do CEO (26/09): cor e
   brilho ÚNICOS, estáveis no tempo — uInk com alfa constante; só a
   névoa de distância muda a intensidade. A deformação tem a mesma
   FORMA da do original (fbm com amplitude, onda transversal dos
   médios, rolagem em z pelo relógio), mas a REAÇÃO ao áudio é a
   calibrada de gl/reliefReaction.ts (26/09): amplitude uAmp e onda
   uWave calculadas uma vez por quadro na CPU a partir de swell,
   pulse e midLift (relativos à média da própria faixa), com teto de
   1,5x e onda de no máximo ±2,5. O original soma graves + batida +
   médios absolutos e satura com música de grave forte. O eixo forma
   só escolhe o fbm:
     detailed  fbm de 5 oitavas (o de glsl.ts, o terreno de sempre);
     smooth    fbm3 local, sem as 2 oitavas mais finas. A 5ª oitava tem
               comprimento de onda de ~1,3 unidade de mundo, quase a
               célula do wireframe (1,25): é ela que vira ponta e
               serrilhado. A 3ª tem ~5,4 u e a malha desenha limpo.

   "mesh": a malha e os índices do original, brilho único.

   "ridges" / "contours" / "weave" são DESENHADAS POR PIXEL: a
   superfície vira triângulos preenchidos numa malha densa (360x264)
   e o fragment shader traça linhas antialiasadas com derivadas de
   tela (fwidth), de espessura constante (~1,2 px) e que esmaecem
   quando ficam mais juntas que ~3 px (sem moiré no horizonte).
     ridges    só as linhas transversais (z constante): curvas contínuas,
               estilo capa de Unknown Pleasures em 3D;
     contours  curvas de nível (altura constante);
     weave     duas famílias deformadas por ruído estático de baixa
               frequência: células que não são quadrados nem losangos.
   Superfície "open": blending alfa, só a linha pinta (morro vazado).
   Superfície "solid": sem blending, cada fragmento pinta o canvas
   com a linha por cima; os índices vão em ordem de pintor (linhas da
   grade do fundo para a frente e, dentro de cada uma, das bordas para
   o x da câmera — gl/geometry.ts surfaceIndices), então o morro da
   frente esconde o de trás sem depth buffer (o contexto não tem).

   Recursos: programas (um por variante x forma, no máximo 9) e as duas
   geometrias nascem sob demanda na primeira vez que o estilo pede e
   ficam em cache até o dispose, que apaga tudo. Depois da primeira
   passada por um estilo, trocar de estilo não aloca nada.
   ============================================================ */

import { HEAD, NOISE } from "../glsl";
import { attribF, blend, clearTo, makeBuffer, makeProgram, type Program } from "../glkit";
import { planeGridXZ, surfaceIndices, wireframeIndices } from "../geometry";
import { lookAt, mat4, perspective } from "../mat4";
import { effectiveReliefStyle, type ReliefShape, type ReliefStyle } from "../meta";
import type { GlScene, SceneCtx, SceneDef, ScenePalette } from "../scene";
import type { GlSignal } from "../signal";
import { reliefAmp, reliefWaveAmp } from "../reliefReaction";

export const RELIEF_GRID = { width: 150, height: 110, gx: 120, gy: 88 } as const;

/** Malha das variantes desenhadas por pixel: a mesma área com 3x as
    divisões por eixo do wireframe (célula de 0,417 u). A linha é traçada
    no fragmento sobre valores interpolados entre vértices, então a curva
    é poligonal na escala da célula — e quebra de ângulo visível é
    justamente o "angular" que o CEO pediu para tirar. Medido no
    WebKitGTK da cmr-auto a 1857x1048 (bench relief=all, app aberto):
      240x176 (0,625 u): 2,2-4,3 ms; quebras de ~20-30 px no primeiro
                         plano, visíveis nos shots;
      360x264 (0,417 u): 3,4-7,2 ms; curvas lisas no recorte ampliado;
      480x352 (0,313 u): 5,0-10,4 ms; sem ganho visível sobre 360.
    O custo cresce com os vértices (o fbm no VS domina: cada snoise a
    mais custa ~0,55 ms a 95 mil vértices), não com o fragment. 361x265
    = 95.665 vértices passam de 16 bits: índice Uint32. */
export const RELIEF_SURFACE_GRID = { width: 150, height: 110, gx: 360, gy: 264 } as const;

const TARGET = [0, -2, -20] as const;

/** Posição do atributo fixada em todos os programas: as duas geometrias
    têm UM VAO cada, compartilhado por todos os programas que as usam. */
const POSITION = 0;

/* ---------- original (INTACTO: referência do CEO) ---------- */

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

/** Fontes do original, expostas só para o teste travar a paridade. */
export const RELIEF_ORIGINAL_SRC = { vs: VS, fs: FS } as const;

/* ---------- variantes de brilho único ---------- */

/** Alfa da "mesh". Média do alfa do original, (0,10 + 0,55·vH), sobre
    os vértices VISÍVEIS da mesma malha com o sinal simulado do bench
    (scripts/gl-bench/sim.ts, 64 s): 0,146, e 0,147 ponderando pela
    névoa. Com os MESMOS índices (diagonais e arestas repetidas), 0,15
    mantém a tinta média do quadro; muda só a distribuição — as cristas
    deixam de acender e os vales deixam de sumir. */
export const RELIEF_MESH_ALPHA = 0.15;

/** Alfa da linha nas variantes por pixel. Elas desenham MENOS linha que
    a malha (sem diagonais nem arestas repetidas, uma família só, exceto
    a rede), então cada linha precisa ser mais forte para o quadro não
    ficar ralo. Com 0,55 (o brilho das cristas no original) os shots a
    1857x1048 saíram apagados perto do original; 0,8 deixa a linha
    fina (1,2 px) legível e ainda abaixo da tinta cheia. */
export const RELIEF_LINE_ALPHA = 0.8;

/** Espessura da linha na tela, em px (antialiasada: ~1 px de núcleo
    com meia rampa de cada lado). */
export const RELIEF_LINE_PX = 1.2;

/** ridges: espaçamento em z entre linhas, em unidades de mundo. 110 u de
    profundidade / 1,75 = ~63 linhas — a densidade da capa de Unknown
    Pleasures (80 linhas numa faixa) sem virar hachura no meio do
    quadro; as de trás esmaecem sozinhas pelo filtro de ~3 px. */
export const RELIEF_RIDGE_SPACING = 1.75;

/** contours: altura entre curvas de nível, em unidades de mundo. Com o
    sinal simulado a altura visível fica em p1..p99 = -5..+5 (extremos
    ±8,7); música alta com graves e batida chega perto de ±13. Passo
    0,75 dá ~7 anéis num morro típico de 5 u e ~17 no pico de ±13:
    lê como mapa topográfico sem empastar. */
export const RELIEF_CONTOUR_STEP = 0.75;

/** weave: espaçamento das duas famílias (u) e amplitude da deformação
    (u). Frequência do ruído: 0,07 por unidade (comprimento de onda de
    ~14 u = 7 células). O gradiente máximo do simplex nessa escala é
    0,48 por unidade (medido); com amplitude 1,4 a inclinação máxima da
    linha é 0,68 — curva bem, e como 1 - 0,68 > 0 duas linhas da mesma
    família nunca se cruzam nem se tocam: o espaçamento local fica entre
    S/1,68 e S/0,32 (0,6x a 3x) nos extremos do gradiente.
    Células irregulares sem degenerar. */
export const RELIEF_WEAVE_SPACING = 2.0;
export const RELIEF_WEAVE_AMP = 1.4;
const WEAVE_FREQ = 0.07;

const f = (v: number) => (Number.isInteger(v) ? v.toFixed(1) : String(v));

/** fbm de 3 oitavas, mesma lacunaridade e deslocamento do fbm de glsl.ts
    (que fica intocado: as outras cenas o usam). */
const FBM3 = `
float fbm3(vec2 p){float f=0.0,a=0.5;for(int i=0;i<3;i++){f+=a*snoise(p);p=p*2.02+vec2(17.3,9.1);a*=0.5;}return f;}
`;

/** VS das variantes de brilho único. Mesma forma de deformação do
    original com a reação calibrada (uAmp/uWave); o fbm muda com a forma. `dense` = superfície por pixel (passa ao FS
    o xz de mundo ANTES do deslocamento, a altura deslocada e, na rede,
    o ruído estático de baixa frequência — calculado aqui e interpolado:
    nada de ruído por fragmento). */
type LineKind = "mesh" | "ridges" | "contours" | "weave";

/** Varyings além de vD, só os que a variante lê: ridges e weave usam o
    xz de mundo, contours a altura, weave o ruído. */
const varyingsOf = (lines: LineKind, dir: "in" | "out") =>
  (lines === "ridges" || lines === "weave" ? ` ${dir} vec2 vXZ;` : "") +
  (lines === "contours" ? ` ${dir} float vH;` : "") +
  (lines === "weave" ? ` ${dir} vec2 vWarp;` : "");

function uniformVS(shape: ReliefShape, lines: LineKind): string {
  return HEAD + NOISE + (shape === "smooth" ? FBM3 : "") + `
in vec3 position;
uniform mat4 uView,uProj;
// uAmp: amplitude do fbm (5,5 em repouso, < 8,25 pelo teto);
// uWave: amplitude da onda dos médios (0..2,5). Os dois vêm prontos
// da CPU (gl/reliefReaction.ts): nada de reação calculada por vértice.
uniform float uTime,uAmp,uWave;
out float vD;${varyingsOf(lines, "out")}
void main(){
  vec3 p=position;
  vec2 q=p.xz*0.045+vec2(0.0,uTime*0.10);
  float h=${shape === "smooth" ? "fbm3" : "fbm"}(q)*uAmp;
  float ridge=sin(p.x*0.22+uTime*0.9)*exp(-abs(p.z+15.0)*0.05)*uWave;${lines === "ridges" || lines === "weave" ? "\n  vXZ=p.xz;" : ""}${
    lines === "contours" ? "\n  vH=h+ridge;" : ""
  }${
    lines === "weave"
      ? `\n  // Ruído ESTÁTICO no espaço (sem tempo): o terreno já se move por baixo.
  vWarp=vec2(snoise(p.xz*${f(WEAVE_FREQ)}),snoise(p.xz*${f(WEAVE_FREQ)}+vec2(31.7,-47.3)));`
      : ""
  }
  p.y+=h+ridge;
  vec4 mv=uView*vec4(p,1.0); vD=-mv.z;
  gl_Position=uProj*mv;
}`;
}

/** Névoa por distância, a mesma curva do original escrita com as bordas
    em ordem crescente (smoothstep com borda0 > borda1 é indefinido na
    especificação do GLSL; o original fica como está, por paridade). */
const FOG = `float fogOf(float d){return 1.0-smoothstep(25.0,140.0,d);}`;

const MESH_FS = HEAD + `
uniform vec3 uInk;
in float vD;
out vec4 outColor;
${FOG}
void main(){ outColor=vec4(uInk,${f(RELIEF_MESH_ALPHA)}*fogOf(vD)); }`;

/** Linha antialiasada sobre a coordenada u (uma linha a cada inteiro):
    d = distância à linha em px (fwidth converte u em px), rampa de 1 px
    em volta de meia espessura, e esmaecimento quando as linhas ficam a
    menos de ~4 px (fw > 0,25) até sumir em ~1,7 px (fw = 0,6). */
const LINE_AA = `
float lineAA(float u,float widthPx){
  float fw=max(fwidth(u),1e-5);
  float d=abs(fract(u-0.5)-0.5)/fw;
  float l=1.0-smoothstep(widthPx*0.5-0.5,widthPx*0.5+0.5,d);
  return l*(1.0-smoothstep(0.25,0.6,fw));
}`;

function lineFS(lines: Exclude<LineKind, "mesh">): string {
  const W = f(RELIEF_LINE_PX);
  const body =
    lines === "ridges"
      ? `lineAA(vXZ.y/${f(RELIEF_RIDGE_SPACING)},${W})`
      : lines === "contours"
        ? `lineAA(vH/${f(RELIEF_CONTOUR_STEP)},${W})`
        : `max(lineAA((vXZ.y+${f(RELIEF_WEAVE_AMP)}*vWarp.x)/${f(RELIEF_WEAVE_SPACING)},${W}),` +
          `lineAA((vXZ.x+${f(RELIEF_WEAVE_AMP)}*vWarp.y)/${f(RELIEF_WEAVE_SPACING)},${W}))`;
  return HEAD + `
uniform vec3 uCanvas,uInk;
uniform float uSolid;
in float vD;${varyingsOf(lines, "in")}
out vec4 outColor;
${FOG}
${LINE_AA}
void main(){
  float a=${body}*${f(RELIEF_LINE_ALPHA)}*fogOf(vD);
  // open (uSolid=0): cor da tinta com alfa a, blending alfa por cima.
  // solid (uSolid=1): opaco, canvas com a linha por cima (blending off).
  outColor=vec4(mix(uInk,mix(uCanvas,uInk,a),uSolid),mix(a,1.0,uSolid));
}`;
}

/* ---------- recursos ---------- */

interface Geometry {
  vao: WebGLVertexArrayObject;
  vbo: WebGLBuffer;
  ibo: WebGLBuffer;
  count: number;
  indexType: number;
  primitive: number;
}

/** Chave do cache de programa: "original", "mesh-<forma>", "<linhas>-<forma>".
    A superfície não entra: open/solid é o mesmo programa (uniform uSolid). */
function programKey(st: ReliefStyle): string {
  return st.lines === "original" ? "original" : `${st.lines}-${st.shape}`;
}

class Relief implements GlScene {
  private readonly gl: WebGL2RenderingContext;
  private readonly progs = new Map<string, Program>();
  private readonly geos: { wire: Geometry | null; surface: Geometry | null } = { wire: null, surface: null };
  private readonly view = mat4();
  private readonly proj = mat4();
  private readonly eye: [number, number, number] = [0, 13, 42];
  /** Estilo do último quadro (identidade do objeto do signal): só
      resolve variante quando o signal troca o objeto. */
  private style: ReliefStyle | null = null;
  private prog!: Program;
  private geo!: Geometry;
  private solid = false;
  private isOriginal = true;

  constructor(ctx: SceneCtx) {
    this.gl = ctx.gl;
    // Programa PRIMEIRO, geometria depois (contrato de gl/scene.ts):
    // select() compila antes de alocar buffers.
    this.select(effectiveReliefStyle());
  }

  private program(st: ReliefStyle): Program {
    const key = programKey(st);
    let p = this.progs.get(key);
    if (p) return p;
    const opts = { label: `relief/${key}`, attribs: { position: POSITION } };
    if (st.lines === "original") p = makeProgram(this.gl, VS, FS, opts);
    else if (st.lines === "mesh") p = makeProgram(this.gl, uniformVS(st.shape, "mesh"), MESH_FS, opts);
    else p = makeProgram(this.gl, uniformVS(st.shape, st.lines), lineFS(st.lines), opts);
    this.progs.set(key, p);
    return p;
  }

  private geometry(kind: "wire" | "surface"): Geometry {
    const have = this.geos[kind];
    if (have) return have;
    const gl = this.gl;
    const g = kind === "wire" ? RELIEF_GRID : RELIEF_SURFACE_GRID;
    const idx = kind === "wire" ? wireframeIndices(g.gx, g.gy) : surfaceIndices(g.gx, g.gy);
    const vbo = makeBuffer(gl, planeGridXZ(g.width, g.height, g.gx, g.gy));
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    attribF(gl, POSITION, vbo, 3);
    // O ELEMENT_ARRAY_BUFFER fica gravado no VAO: ligar com o VAO ativo.
    const ibo = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, null);
    const geo: Geometry = {
      vao,
      vbo,
      ibo,
      count: idx.length,
      indexType: idx instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
      primitive: kind === "wire" ? gl.LINES : gl.TRIANGLES,
    };
    this.geos[kind] = geo;
    return geo;
  }

  private select(st: ReliefStyle): void {
    this.style = st;
    this.prog = this.program(st);
    const byPixel = st.lines !== "original" && st.lines !== "mesh";
    this.geo = this.geometry(byPixel ? "surface" : "wire");
    this.isOriginal = st.lines === "original";
    this.solid = byPixel && st.surface === "solid";
  }

  resize(w: number, h: number): void {
    perspective(this.proj, 50, w / h, 0.1, 300);
  }

  frame(sig: GlSignal, pal: ScenePalette, _dt: number, w: number, h: number): void {
    const st = effectiveReliefStyle();
    if (st !== this.style) this.select(st);

    const gl = this.gl;
    this.eye[0] = Math.sin(sig.clock * 0.07) * 4;
    lookAt(this.view, this.eye, TARGET);

    clearTo(gl, pal.canvas);
    blend(gl, this.solid ? "off" : "alpha");
    const p = this.prog;
    p.use();
    p.common(sig, pal, w, h);
    if (!this.isOriginal) {
      p.f("uSolid", this.solid ? 1 : 0);
      p.f("uAmp", reliefAmp(sig));
      p.f("uWave", reliefWaveAmp(sig));
    }
    p.m4("uView", this.view);
    p.m4("uProj", this.proj);
    const g = this.geo;
    gl.bindVertexArray(g.vao);
    gl.drawElements(g.primitive, g.count, g.indexType, 0);
    gl.bindVertexArray(null);
    blend(gl, "off");
  }

  dispose(): void {
    const gl = this.gl;
    for (const p of this.progs.values()) p.dispose();
    this.progs.clear();
    for (const k of ["wire", "surface"] as const) {
      const g = this.geos[k];
      if (!g) continue;
      gl.deleteBuffer(g.vbo);
      gl.deleteBuffer(g.ibo);
      gl.deleteVertexArray(g.vao);
      this.geos[k] = null;
    }
  }
}

export const relief: SceneDef = {
  key: "relief",
  create: (ctx) => new Relief(ctx),
};
