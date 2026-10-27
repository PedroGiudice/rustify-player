/* ============================================================
   gl/engine.ts — o motor do fundo WebGL2 (sem three.js).

   Um ÚNICO contexto WebGL2 vive enquanto o fundo WebGL estiver
   ligado. Trocar de cena destrói os recursos da cena anterior
   (programas, buffers, texturas) e cria os da nova, mas NUNCA o
   contexto: contexto de WebGL é recurso escasso no WebKitGTK e
   recriá-lo a cada troca acaba em "too many contexts" com o canvas
   preto.

   Orçamento: DPR fixo em 1 (a cmr-auto é UHD 620 a 1366x768).
   Sem antialias, sem alpha, sem depth/stencil — as cenas limpam em
   preto puro (GL_CANVAS) e desenham por cima, aditivas ou com
   alfa, sem oclusão. Cena com SceneDef.maxRows desenha num buffer
   reduzido que o motor compõe na tela com filtro linear e dither.

   Falhas: sem WebGL2 o construtor lança; shader que não compila
   faz setScene lançar com a mensagem do driver; contexto perdido
   chama onLost. Em todos os casos quem hospeda (gl/host.ts) põe
   glStatus.ok = false e o App volta ao fundo 2D — tela preta
   nunca.

   Transição (overdrive, 27/10): trocar de cena não é mais um corte
   seco. setScene(key, true) desenha a cena que sai UMA última vez
   num retrato (textura do tamanho da tela), libera a cena e monta a
   nova; durante XFADE_SCENE_S o retrato se dissolve por cima da cena
   nova enquanto avança 6% para a câmera (a cena antiga "passa por
   trás" da nova). O primeiro setScene com fade (motor ligando, app
   abrindo) nasce do preto em XFADE_START_S. Custo: um passe de tela
   cheia com uma leitura de textura, só enquanto a transição dura; o
   retrato é liberado no fim. Versão calma (still: reduzir animação ou
   Speed = 0): só a dissolução, sem o avanço. A cena nova já roda por
   baixo desde o primeiro quadro: nada espera a transição, e o som
   nunca passa por aqui.

   Contrato das cenas: gl/scene.ts. Registro: gl/registry.ts.
   ============================================================ */

import { IGN, HEAD, VS_TRI } from "./glsl";
import { makeProgram, makeTarget, type Program, type Target } from "./glkit";
import { reducedBufferSize } from "./budget";
import { SCENES } from "./registry";
import type { SceneKey } from "./meta";
import type { GlPalette } from "./palette";
import type { GlCaps, GlScene, SceneCtx, SceneDef, ScenePalette } from "./scene";
import type { GlSignal } from "./signal";

const CONTEXT_ATTRS: WebGLContextAttributes = {
  alpha: false,
  antialias: false,
  depth: false,
  stencil: false,
  premultipliedAlpha: true,
  preserveDrawingBuffer: false,
  powerPreference: "high-performance",
};

/** Composite do buffer reduzido: amostra na resolução da tela e soma
    meio degrau de 8 bits de ruído IGN, que some com o banding que a
    escala linear revelaria no gradiente escuro. */
const COMPOSITE_FS = HEAD + `
uniform sampler2D uTex; uniform vec2 uRes;
out vec4 outColor;
` + IGN + `
void main(){
  vec3 c=texture(uTex,gl_FragCoord.xy/uRes).rgb;
  outColor=vec4(dither(c),1.0);
}`;

/* ---------- transição ---------- */

/** Dissolução entre cenas (s). Transição de fundo = segundos (rustify-cto,
    Movimento); 1,4 s deixa ver as duas cenas sem virar espera. */
export const XFADE_SCENE_S = 1.4;
/** Chegada do motor, do preto (s): o fundo "acende" ao abrir o app. */
export const XFADE_START_S = 1.8;
/** Quanto o retrato da cena que sai avança para a câmera (fração). */
export const XFADE_ZOOM = 0.06;

/** Retrato da cena que sai, por cima da nova: amostra com zoom em torno
    do centro e escurece um pouco enquanto some. */
const XFADE_SNAP_FS = HEAD + `
uniform sampler2D uTex; uniform vec2 uRes; uniform float uAlpha,uZoom,uDim;
out vec4 outColor;
void main(){
  vec2 uv=(gl_FragCoord.xy/uRes-0.5)/uZoom+0.5;
  outColor=vec4(texture(uTex,uv).rgb*uDim,uAlpha);
}`;

/** Véu de cor sólida (o canvas preto) para a chegada do motor. */
const XFADE_SOLID_FS = HEAD + `
uniform vec3 uColor; uniform float uAlpha;
out vec4 outColor;
void main(){ outColor=vec4(uColor,uAlpha); }`;

const smoother = (x: number) => x * x * x * (x * (x * 6 - 15) + 10);

/** Curva da transição no progresso p (0..1): alfa do que sai, zoom e
    escurecimento do retrato. `still` (calma, Speed = 0): sem zoom. */
export function xfadeAt(p: number, still: boolean): { alpha: number; zoom: number; dim: number } {
  const t = p > 0 ? (p < 1 ? p : 1) : 0;
  const e = smoother(t);
  // Ease-out cúbico no avanço: o retrato arranca e desacelera.
  const go = 1 - (1 - t) * (1 - t) * (1 - t);
  return { alpha: 1 - e, zoom: still ? 1 : 1 + XFADE_ZOOM * go, dim: 1 - 0.25 * e };
}

/** Meio degrau de 8 bits: mudança de paleta menor que isso não avisa a cena. */
const PALETTE_EPS = 0.5 / 255;

export interface GlEngineOptions {
  /** Contexto perdido pelo driver/navegador (não dispara no dispose). */
  onLost?: (reason: string) => void;
  /** Registro de cenas. Padrão: gl/registry.ts. */
  scenes?: Readonly<Record<string, SceneDef>>;
  /** Escala do tempo da transição (padrão 1). O bench usa ~0 para medir
      a cena COM o véu da dissolução ativo o tempo todo. */
  fadeTimeScale?: number;
}

export class GlEngine {
  readonly gl: WebGL2RenderingContext;
  readonly caps: GlCaps;
  private readonly canvas: HTMLCanvasElement;
  private readonly scenes: Readonly<Record<string, SceneDef>>;
  private readonly onLostCb?: (reason: string) => void;
  private readonly fadeTimeScale: number;
  private readonly ctx: SceneCtx;
  private readonly composite: Program;
  private readonly fadeSnap: Program;
  private readonly fadeSolid: Program;
  private readonly emptyVao: WebGLVertexArrayObject;

  private key: SceneKey | null = null;
  private def: SceneDef | null = null;
  private scene: GlScene | null = null;
  private rt: Target | null = null;
  private w = 1;
  private h = 1;
  private outW = 1;
  private outH = 1;
  private lost = false;
  private disposed = false;

  /** Framebuffer final da cena: a tela (null) ou o retrato da transição. */
  private target: WebGLFramebuffer | null = null;
  /** Retrato da cena que saiu (vivo só durante a dissolução). */
  private snap: Target | null = null;
  /** Transição em curso: 0 = nenhuma, 1 = do preto, 2 = do retrato. */
  private fadeKind: 0 | 1 | 2 = 0;
  private fadeT = 0;
  private fadeDur = 1;
  /** Último sinal desenhado (o retrato redesenha a cena com ele). */
  private lastSig: GlSignal | null = null;

  /** Paleta em float, mutada no lugar (as cenas leem por referência). */
  readonly pal: ScenePalette = {
    canvas: new Float32Array(3),
    ink: new Float32Array(3),
    ink2: new Float32Array(3),
    soft: new Float32Array(3),
  };
  private readonly palArrs = [this.pal.canvas, this.pal.ink, this.pal.ink2, this.pal.soft] as const;
  /** Última paleta avisada via onPalette (canvas, ink, ink2, soft). */
  private readonly notified = new Float32Array(12).fill(-1);

  /** @throws se o navegador não der um contexto WebGL2. */
  constructor(canvas: HTMLCanvasElement, opts: GlEngineOptions = {}) {
    this.canvas = canvas;
    this.scenes = opts.scenes ?? SCENES;
    this.onLostCb = opts.onLost;
    this.fadeTimeScale = opts.fadeTimeScale ?? 1;
    const gl = canvas.getContext("webgl2", CONTEXT_ATTRS) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 indisponível neste navegador");
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", this.handleLost);

    this.caps = {
      colorBufferFloat: !!gl.getExtension("EXT_color_buffer_float"),
      maxPointSize: Number((gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array | null)?.[1] ?? 1),
    };
    try {
      const vao = gl.createVertexArray();
      if (!vao) throw new Error("WebGL2 sem vertex array object (contexto perdido?)");
      this.emptyVao = vao;
      this.composite = makeProgram(gl, VS_TRI, COMPOSITE_FS, { label: "composite" });
      this.fadeSnap = makeProgram(gl, VS_TRI, XFADE_SNAP_FS, { label: "xfade" });
      this.fadeSolid = makeProgram(gl, VS_TRI, XFADE_SOLID_FS, { label: "xfade-solid" });
    } catch (e) {
      // Motor que não subiu devolve o contexto na hora (teto de contextos).
      canvas.removeEventListener("webglcontextlost", this.handleLost);
      try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* ok */ }
      throw e;
    }
    this.ctx = {
      gl,
      caps: this.caps,
      bindOutput: () => this.bindOutput(),
      fullscreen: () => this.fullscreen(),
    };
  }

  /** Chave da cena montada (null = nenhuma, ou a última falhou). */
  get sceneKey(): SceneKey | null {
    return this.scene ? this.key : null;
  }

  /** Tamanho da saída da cena atual (o buffer reduzido, se houver). */
  get outputSize(): { w: number; h: number } {
    return { w: this.outW, h: this.outH };
  }

  /** Nome do renderer GL exposto pelo driver — diagnóstico no Tweaks.
      No WebKitGTK é mascarado ("Apple GPU"), não identifica hardware. */
  rendererName(): string {
    try {
      const gl = this.gl;
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      const name = dbg
        ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string)
        : (gl.getParameter(gl.RENDERER) as string);
      return name || "desconhecido";
    } catch {
      return "não exposto";
    }
  }

  /** Transição em curso (0..1) ou null — diagnóstico e testes. */
  get transition(): { kind: "start" | "scene"; progress: number } | null {
    if (!this.fadeKind) return null;
    return { kind: this.fadeKind === 1 ? "start" : "scene", progress: Math.min(1, this.fadeT / this.fadeDur) };
  }

  /**
   * Monta a cena `key`, liberando a anterior. Idempotente para a mesma
   * chave — inclusive depois de uma falha: a cena que não compilou não é
   * recompilada a cada quadro.
   *
   * `fade`: dissolve a partir da cena atual (retrato) ou, sem cena
   * desenhada ainda, nasce do preto. Falso = corte seco (bench, medição).
   * @throws com a mensagem do driver se a cena não montar.
   */
  setScene(key: SceneKey, fade = false): void {
    if (this.disposed) return;
    if (key === this.key) return;
    if (fade && !this.lost) this.beginFade();
    else this.endFade();
    this.dropScene();
    this.key = key;
    const def = this.scenes[key];
    if (!def) throw new Error(`cena desconhecida: ${key}`);
    this.def = def;
    this.layout();
    let scene: GlScene;
    try {
      scene = def.create(this.ctx);
    } catch (e) {
      this.def = null;
      this.layout();
      const msg = e instanceof Error ? e.message : String(e);
      // makeProgram já prefixa o rótulo, que por convenção começa pela chave.
      throw new Error(msg.startsWith(key) ? `cena ${msg}` : `cena ${key}: ${msg}`);
    }
    this.scene = scene;
    scene.resize(this.outW, this.outH);
    this.notified.fill(-1);
    this.notifyPalette();
  }

  /** Paleta 0..255 (gl/palette.ts). Chamada por quadro, com o lerp. */
  setPalette(p: GlPalette): void {
    const { canvas, ink, ink2, soft } = this.pal;
    canvas[0] = p.canvas.r / 255; canvas[1] = p.canvas.g / 255; canvas[2] = p.canvas.b / 255;
    ink[0] = p.ink.r / 255; ink[1] = p.ink.g / 255; ink[2] = p.ink.b / 255;
    ink2[0] = p.ink2.r / 255; ink2[1] = p.ink2.g / 255; ink2[2] = p.ink2.b / 255;
    soft[0] = p.soft.r / 255; soft[1] = p.soft.g / 255; soft[2] = p.soft.b / 255;
    this.notifyPalette();
  }

  /** Tamanho do canvas em pixels CSS (DPR fixo em 1). */
  resize(w: number, h: number): void {
    if (this.disposed) return;
    this.w = Math.max(1, Math.round(w));
    this.h = Math.max(1, Math.round(h));
    if (this.canvas.width !== this.w) this.canvas.width = this.w;
    if (this.canvas.height !== this.h) this.canvas.height = this.h;
    // Retrato de outro tamanho não serve: a dissolução vira véu preto.
    if (this.snap && (this.snap.w !== this.w || this.snap.h !== this.h)) {
      this.snap.dispose();
      this.snap = null;
      if (this.fadeKind === 2) this.fadeKind = 1;
    }
    this.layout();
    this.scene?.resize(this.outW, this.outH);
  }

  /**
   * Desenha um quadro. `still` = versão calma (reduzir animação) ou
   * Speed = 0: a transição só dissolve, sem o avanço do retrato.
   */
  frame(sig: GlSignal, dt: number, still = false): void {
    if (this.lost || this.disposed) return;
    this.lastSig = sig;
    this.drawScene(sig, dt);
    if (this.fadeKind) this.drawFade(dt, still);
  }

  /** Cena atual no framebuffer final (this.target), com o composite do
      buffer reduzido se houver. */
  private drawScene(sig: GlSignal, dt: number): void {
    const gl = this.gl;
    gl.bindVertexArray(null);
    gl.disable(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.RASTERIZER_DISCARD);
    gl.activeTexture(gl.TEXTURE0);
    this.bindOutput();

    if (!this.scene) {
      // Sem cena (a última falhou): preto, nunca lixo do quadro anterior.
      const c = this.pal.canvas;
      gl.clearColor(c[0], c[1], c[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      return;
    }
    this.scene.frame(sig, this.pal, dt, this.outW, this.outH);
    if (this.rt) this.compose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.dropScene();
    const gl = this.gl;
    try {
      this.rt?.dispose();
      this.rt = null;
      this.snap?.dispose();
      this.snap = null;
      this.composite.dispose();
      this.fadeSnap.dispose();
      this.fadeSolid.dispose();
      gl.deleteVertexArray(this.emptyVao);
    } catch { /* contexto já perdido */ }
    this.canvas.removeEventListener("webglcontextlost", this.handleLost);
    // Solta o contexto de verdade: sem isto o WebKitGTK segura o contexto
    // até o GC e ligar/desligar o motor várias vezes esbarra no teto de
    // contextos do processo.
    try { gl.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* ok */ }
  }

  /* ---------- internos ---------- */

  private readonly handleLost = (): void => {
    if (this.disposed || this.lost) return;
    this.lost = true;
    this.onLostCb?.("contexto WebGL perdido pelo driver");
  };

  private bindOutput(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.rt ? this.rt.fb : this.target);
    gl.viewport(0, 0, this.outW, this.outH);
  }

  private fullscreen(): void {
    const gl = this.gl;
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  private compose(): void {
    const gl = this.gl;
    const rt = this.rt!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target);
    gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.BLEND);
    this.composite.use();
    this.composite.v2("uRes", this.w, this.h);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rt.tex);
    this.composite.i("uTex", 0);
    this.fullscreen();
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** Decide a saída da cena atual: a tela, ou um buffer reduzido quando
      o SceneDef pede maxRows e a tela tem mais linhas que isso. */
  private layout(): void {
    const maxRows = this.def?.maxRows;
    const want = maxRows ? reducedBufferSize(this.w, this.h, maxRows) : null;
    if (!want || (want.w >= this.w && want.h >= this.h)) {
      this.rt?.dispose();
      this.rt = null;
      this.outW = this.w;
      this.outH = this.h;
      return;
    }
    if (!this.rt || this.rt.w !== want.w || this.rt.h !== want.h) {
      this.rt?.dispose();
      this.rt = makeTarget(this.gl, want.w, want.h);
    }
    this.outW = want.w;
    this.outH = want.h;
  }

  /** Começa a transição: retrato da cena atual se ela já desenhou algum
      quadro; senão (motor ligando, cena anterior falhou) nasce do preto. */
  private beginFade(): void {
    // Troca em rajada (cliques seguidos no Tweaks): enquanto o véu ainda
    // cobre mais da metade, ele segue cobrindo a troca nova. Recapturar
    // aqui faria o retrato antigo sumir de uma vez (um estalo).
    if (this.fadeKind && this.fadeT < 0.5 * this.fadeDur) return;
    const sig = this.lastSig;
    if (this.scene && sig) {
      try {
        if (!this.snap || this.snap.w !== this.w || this.snap.h !== this.h) {
          this.snap?.dispose();
          this.snap = null;
          this.snap = makeTarget(this.gl, this.w, this.h);
        }
        // Mesmo sinal do quadro que está na tela e dt 0: as cenas com
        // estado próprio não avançam, o retrato é o último quadro visto.
        this.target = this.snap.fb;
        this.drawScene(sig, 0);
        this.fadeKind = 2;
        this.fadeDur = XFADE_SCENE_S;
        this.fadeT = 0;
        return;
      } catch {
        // Sem memória para o retrato (ou cena que falhou no redesenho):
        // a transição ainda acontece, do preto.
        this.snap?.dispose();
        this.snap = null;
      } finally {
        this.target = null;
      }
    }
    this.fadeKind = 1;
    this.fadeDur = this.scene ? XFADE_SCENE_S : XFADE_START_S;
    this.fadeT = 0;
  }

  private endFade(): void {
    this.fadeKind = 0;
    this.snap?.dispose();
    this.snap = null;
  }

  /** Véu da transição por cima da cena nova, na tela. */
  private drawFade(dt: number, still: boolean): void {
    const gl = this.gl;
    this.fadeT += dt > 0 ? dt * this.fadeTimeScale : 0;
    const p = this.fadeT / this.fadeDur;
    if (p >= 1) {
      this.endFade();
      return;
    }
    const k = xfadeAt(p, still);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (this.fadeKind === 2 && this.snap) {
      const prog = this.fadeSnap;
      prog.use();
      prog.v2("uRes", this.w, this.h);
      prog.f("uAlpha", k.alpha);
      prog.f("uZoom", k.zoom);
      prog.f("uDim", k.dim);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.snap.tex);
      prog.i("uTex", 0);
      this.fullscreen();
      gl.bindTexture(gl.TEXTURE_2D, null);
    } else {
      const prog = this.fadeSolid;
      prog.use();
      prog.v3("uColor", this.pal.canvas);
      prog.f("uAlpha", k.alpha);
      this.fullscreen();
    }
    gl.disable(gl.BLEND);
  }

  private dropScene(): void {
    const s = this.scene;
    this.scene = null;
    this.def = null;
    this.key = null;
    if (s) {
      try { s.dispose(); } catch { /* contexto já perdido */ }
    }
  }

  private notifyPalette(): void {
    const arrs = this.palArrs;
    const n = this.notified;
    let changed = false;
    for (let i = 0; i < 12; i++) {
      if (Math.abs(arrs[(i / 3) | 0][i % 3] - n[i]) > PALETTE_EPS) { changed = true; break; }
    }
    if (!changed) return;
    for (let i = 0; i < 12; i++) n[i] = arrs[(i / 3) | 0][i % 3];
    this.scene?.onPalette?.(this.pal);
  }
}
