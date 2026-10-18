/* ============================================================
   scenes/lorem.ts — Lorem: parágrafos de uma escrita que não existe,
   acesos por ondas que partem de cada kick.

   Referência: a gravação do CEO de 18/10 (fundo do Claude Desktop):
   uma grade de caracteres monoespaçados em duas cores sobre preto,
   quase apagada, com uma névoa lenta decidindo onde o texto aparece e
   ondas circulares que partem de cada clique e acendem os glifos ao
   passar. Aqui o clique vira o kick (pulse): cada batida abre uma onda
   num ponto novo da tela, a frente acende em ink2 e deixa um rastro
   que apaga em ~1 s; os glifos que a frente atravessa são REDIGITADOS
   (trocam de glifo), como o texto do vídeo. No lugar do código, um
   alfabeto asêmico rasterizado na CPU (gl/glyphAtlas.ts), em
   parágrafos com indentação, margem direita irregular e linhas em
   branco entre eles.

   Sinal (relativo à faixa, gl/signal.ts): graves (swell) sobem a
   névoa; médios (midRel) mudam a velocidade da deriva da névoa, que é
   INTEGRADA na CPU (CMR-267); agudos (highLift) cintilam células
   soltas. Ondas: estado na CPU (stepLoremWaves), raio integrado pelo
   relógio virtual, 8 por vez.

   Custo: 1 leitura de textura + 3 oitavas de ruído de valor por
   pixel, em resolução cheia (glifo fino não aceita buffer reduzido).
   gl-bench na cmr-auto (WebKitGTK, 1857x1048, 18/10): 5,4 ms por quadro.
   ============================================================ */

import { FS_COMMON, HEAD, VS_TRI } from "../glsl";
import { makeProgram, type Program } from "../glkit";
import type { GlScene, SceneCtx, SceneDef, ScenePalette } from "../scene";
import type { GlSignal } from "../signal";
import { ATLAS_COLS, ATLAS_H, ATLAS_ROWS, ATLAS_W, GLYPH_H, GLYPH_W, makeGlyphAtlas } from "../glyphAtlas";
import { stepKickCount, type KickCount } from "./riso";

export const LOREM_WAVES = 8;
/** Raio da onda cresce isto por segundo (unidade = altura da tela). */
export const WAVE_SPEED = 0.7;
/** A onda apaga com esta constante de tempo (s). */
export const WAVE_TAU = 1.3;
/** Ondas mais velhas que isto saem do shader (amplitude < 2%). */
export const WAVE_LIFE = 5;
/** Deriva da névoa (unidades de ruído por segundo) em repouso. */
export const MIST_DRIFT = 0.035;

const FS = HEAD + FS_COMMON + `
uniform sampler2D uAtlas;
uniform vec2 uMist;
uniform vec4 uWaves[${LOREM_WAVES}];   // origem xy (altura = 1), raio, amplitude
uniform float uGlow, uSpark, uRetype;

const vec2 CELL = vec2(${GLYPH_W}.0, ${GLYPH_H}.0);
const vec2 ATLAS = vec2(${ATLAS_COLS}.0, ${ATLAS_ROWS}.0);

// hash sem seno (Hoskins): o de seno sai enviesado neste WebKitGTK com
// entradas inteiras pequenas (faísca em 8-15% das células em vez de 2,5%,
// espaços com padrão periódico — medido pelo revisor em 18/10)
float h21(vec2 p) { vec3 q = fract(vec3(p.xyx) * 0.1031); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
// o ruído da névoa é suave: o hash de seno (mais barato, 1,3 ms a menos a
// 1857x1048) basta nele
float hs(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hs(i), hs(i + vec2(1, 0)), f.x), mix(hs(i + vec2(0, 1)), hs(i + vec2(1, 1)), f.x), f.y);
}
float fbm3(vec2 p) { return (vn(p) + 0.5 * vn(p * 2.03 + 7.1) + 0.25 * vn(p * 4.1 + 3.3)) / 1.75; }

void main() {
  vec2 cell = floor(gl_FragCoord.xy / CELL);
  vec2 inCell = fract(gl_FragCoord.xy / CELL);
  vec2 centre = ((cell + 0.5) * CELL - 0.5 * uRes) / uRes.y;

  // parágrafos: linha em branco, indentação e margem direita irregular
  float row = cell.y, col = cell.x;
  float rowH = h21(vec2(row, 1.7));
  float blank = step(rowH, 0.09);
  float indent = step(0.09, rowH) * step(rowH, 0.22) * 3.0;
  float cols = uRes.x / CELL.x;
  float lineEnd = cols * (0.5 + 0.5 * h21(vec2(row, 5.3)));
  float space = step(h21(vec2(col, row * 13.0)), 0.15);
  float visible = (1.0 - blank) * step(indent, col) * step(col, lineEnd) * (1.0 - space);

  // ondas: frente, rastro e quantas já passaram por esta célula
  float front = 0.0, trail = 0.0, passed = 0.0;
  for (int i = 0; i < ${LOREM_WAVES}; i++) {
    vec4 w = uWaves[i];
    float d = length(centre - w.xy);
    float f = exp(-pow((d - w.z) / 0.045, 2.0));
    front += w.w * f;
    // rastro: o MÁXIMO entre as ondas, não a soma — somar saturava a tela.
    // É uma FAIXA estreita atrás da frente (~0,4 s de onda), não o disco
    // inteiro: com ~1,4 kick/s o disco cheio acendia a tela toda e o anel
    // deixava de ser legível.
    trail = max(trail, w.w * smoothstep(w.z, w.z - 0.04, d) * smoothstep(w.z - 0.14, w.z - 0.04, d));
    passed += step(d, w.z);
  }

  // glifo: redigitado a cada onda que passa (e a cada ciclo lento)
  float id = floor(h21(cell * 0.37 + (passed + uRetype) * 7.13) * ${ATLAS_COLS * ATLAS_ROWS}.0);
  vec2 slot = vec2(mod(id, ATLAS.x), floor(id / ATLAS.x));
  float g = texture(uAtlas, (slot + vec2(inCell.x, 1.0 - inCell.y)) / ATLAS).r;

  // névoa lenta decide onde o texto respira
  float mist = fbm3(cell * vec2(0.032, 0.05) + uMist);
  float base = smoothstep(0.58, 0.70, mist) * (0.16 + 0.2 * uGlow) + 0.02;
  float spark = step(h21(cell + floor(uTime * 9.0)), uSpark * 0.012);

  // duas tintas intercaladas por célula, como no vídeo (duas cores de texto)
  vec3 tinta = mix(uInk, uInk2, step(0.5, h21(cell * 1.91 + 0.3)));
  vec3 col3 = tinta * min(base + trail * 0.4 + spark * 0.4, 1.0) + mix(tinta, uSoft, 0.6) * min(front * 2.6, 1.0);
  float lum = g * visible;
  outColor = vec4(dither(uCanvas + clamp(col3, 0.0, 1.0) * lum), 1.0);
}`;

export interface LoremWave {
  x: number;
  y: number;
  /** Idade em segundos de relógio virtual; < 0 = vaga livre. */
  age: number;
  amp: number;
}

export interface LoremState {
  waves: LoremWave[];
  kick: KickCount;
  mistX: number;
  mistY: number;
  retype: number;
}

export function createLoremState(): LoremState {
  const waves: LoremWave[] = [];
  for (let i = 0; i < LOREM_WAVES; i++) waves.push({ x: 0, y: 0, age: -1, amp: 0 });
  return { waves, kick: { n: 0, armed: true }, mistX: 0, mistY: 0, retype: 0 };
}

/** dt máximo (s): o relógio pode saltar (volta do background, bench). */
const DCLOCK_MAX = 0.1;

/**
 * Um passo da cena: envelhece as ondas, abre uma nova no kick (ponto
 * sorteado dentro da tela, dentro da proporção `asp` = largura/altura),
 * integra a deriva da névoa e o ciclo lento de redigitação.
 * Puro além de `rnd`; devolve o mesmo objeto, mutado (sem alocação).
 */
export function stepLoremWaves(st: LoremState, sig: GlSignal, dClock: number, asp: number, rnd: () => number = Math.random): LoremState {
  const dt = Math.min(Math.max(dClock, 0), DCLOCK_MAX);
  for (const w of st.waves) {
    if (w.age < 0) continue;
    w.age += dt;
    if (w.age > WAVE_LIFE) w.age = -1;
  }
  const before = st.kick.n;
  st.kick = stepKickCount(st.kick, sig.pulse);
  if (st.kick.n !== before) {
    // vaga livre, senão a mais velha
    let slot = st.waves.find((w) => w.age < 0);
    if (!slot) slot = st.waves.reduce((a, b) => (a.age > b.age ? a : b));
    slot.x = (rnd() - 0.5) * asp * 0.9;
    slot.y = (rnd() - 0.5) * 0.9;
    slot.age = 0;
    slot.amp = 0.6 + 0.4 * Math.min(1, sig.pulse);
  }
  // deriva da névoa: velocidade muda com os médios, posição integrada
  const v = MIST_DRIFT * (1 + 0.8 * sig.midRel);
  st.mistX += dt * v;
  st.mistY += dt * v * 0.6;
  // redigitação lenta de fundo: uma letra nova a cada ~9 s por célula
  st.retype += dt / 9;
  return st;
}

/** Empacota as ondas para o uniform (x, y, raio, amplitude) sem alocar. */
export function packLoremWaves(st: LoremState, out: Float32Array): Float32Array {
  for (let i = 0; i < LOREM_WAVES; i++) {
    const w = st.waves[i];
    const o = i * 4;
    if (w.age < 0) {
      out[o] = 0; out[o + 1] = 0; out[o + 2] = -1; out[o + 3] = 0;
      continue;
    }
    out[o] = w.x;
    out[o + 1] = w.y;
    out[o + 2] = w.age * WAVE_SPEED;
    out[o + 3] = w.amp * Math.exp(-w.age / WAVE_TAU);
  }
  return out;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

class Lorem implements GlScene {
  private readonly gl: WebGL2RenderingContext;
  private readonly prog: Program;
  private readonly tex: WebGLTexture;
  private readonly st = createLoremState();
  private readonly packed = new Float32Array(LOREM_WAVES * 4);
  private lastClock: number | null = null;

  constructor(private readonly ctx: SceneCtx) {
    const gl = (this.gl = ctx.gl);
    this.prog = makeProgram(gl, VS_TRI, FS, { label: "lorem" });
    const tex = gl.createTexture();
    if (!tex) throw new Error("lorem: textura do atlas não criada (contexto perdido?)");
    this.tex = tex;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, ATLAS_W, ATLAS_H, 0, gl.RED, gl.UNSIGNED_BYTE, makeGlyphAtlas());
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  resize(): void {}

  frame(sig: GlSignal, pal: ScenePalette, _dt: number, w: number, h: number): void {
    const gl = this.gl;
    const dClock = this.lastClock === null ? 0 : sig.clock - this.lastClock;
    this.lastClock = sig.clock;
    stepLoremWaves(this.st, sig, dClock, w / h);
    packLoremWaves(this.st, this.packed);

    const p = this.prog;
    p.use();
    p.common(sig, pal, w, h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    p.i("uAtlas", 0);
    p.v2("uMist", this.st.mistX, this.st.mistY);
    gl.uniform4fv(p.loc("uWaves[0]"), this.packed);
    p.f("uGlow", clamp01(sig.swell));
    p.f("uSpark", clamp01(sig.highLift));
    p.f("uRetype", Math.floor(this.st.retype));
    this.ctx.fullscreen();
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  dispose(): void {
    this.prog.dispose();
    this.gl.deleteTexture(this.tex);
  }
}

export const lorem: SceneDef = {
  key: "lorem",
  create: (ctx) => new Lorem(ctx),
};
