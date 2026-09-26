/* ============================================================
   gl/glkit.ts — o ajudante mínimo de WebGL2 que as cenas usam.

   Nasceu do lab v2 (docs/design-refs/fundo-lab-v2): programa com
   cache de uniforms, render target com half-float opcional,
   transform feedback e blending nomeado. É tudo o que as cenas
   precisam; se crescer muito, a alternativa avaliada é twgl.js.
   ============================================================ */

import type { GlSignal } from "./signal";
import type { ScenePalette, Vec3 } from "./scene";

/* ---------- programa ---------- */

export interface ProgramOptions {
  /** Nome que aparece na mensagem de erro (ex.: "dust/pontos"). */
  label?: string;
  /** Varyings capturados por transform feedback, na ordem dos
      TRANSFORM_FEEDBACK_BUFFER índices 0, 1, ... */
  feedback?: readonly string[];
  /** SEPARATE (padrão, um buffer por varying) ou INTERLEAVED. */
  feedbackMode?: "separate" | "interleaved";
  /** Posições fixas de atributo, ligadas antes do link. Útil quando
      dois programas leem o mesmo VAO (simulação + desenho). */
  attribs?: Readonly<Record<string, number>>;
}

export interface Program {
  readonly p: WebGLProgram;
  use(): void;
  /** Localização do uniform (cacheada; null = otimizado fora pelo driver,
      e gl.uniform* com null é no-op). */
  loc(name: string): WebGLUniformLocation | null;
  /** Localização do atributo (cacheada; -1 = ausente). */
  attrib(name: string): number;
  f(name: string, v: number): void;
  i(name: string, v: number): void;
  u(name: string, v: number): void;
  v2(name: string, a: number, b: number): void;
  v3(name: string, c: ArrayLike<number>): void;
  v4(name: string, a: number, b: number, c: number, d: number): void;
  m4(name: string, m: Float32Array): void;
  /** uRes, uTime (= sig.clock), uLow/uMid/uHigh/uBeat e as 4 cores. */
  common(sig: GlSignal, pal: ScenePalette, w: number, h: number): void;
  dispose(): void;
}

/**
 * Monta a mensagem de erro de compilação com as linhas do fonte que o
 * driver acusou. Os drivers usam "ERROR: 0:<linha>:"; sem número, só
 * o log vai.
 */
export function formatShaderError(stage: string, label: string, log: string, src: string): string {
  const head = `${label ? label + ": " : ""}${stage} não compilou: ${(log || "(driver sem log)").trim()}`;
  const lines = src.split("\n");
  const seen = new Set<number>();
  const re = /(?:ERROR|WARNING):\s*\d+:(\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(log || "")) && seen.size < 3) seen.add(parseInt(m[1], 10));
  if (!seen.size) return head;
  const ctx = [...seen]
    .filter((n) => n >= 1 && n <= lines.length)
    .map((n) => `  ${n}| ${lines[n - 1].trim().slice(0, 160)}`);
  return ctx.length ? `${head}\n${ctx.join("\n")}` : head;
}

export function makeProgram(
  gl: WebGL2RenderingContext,
  vsSrc: string,
  fsSrc: string,
  opts: ProgramOptions = {},
): Program {
  const label = opts.label ?? "";
  const compile = (type: number, src: string, stage: string) => {
    const s = gl.createShader(type);
    if (!s) throw new Error(`${label ? label + ": " : ""}createShader falhou (contexto perdido?)`);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s) ?? "";
      gl.deleteShader(s);
      throw new Error(formatShaderError(stage, label, log, src));
    }
    return s;
  };
  const vs = compile(gl.VERTEX_SHADER, vsSrc, "shader de vértice");
  let fs: WebGLShader;
  try {
    fs = compile(gl.FRAGMENT_SHADER, fsSrc, "shader de fragmento");
  } catch (e) {
    gl.deleteShader(vs);
    throw e;
  }
  const p = gl.createProgram();
  if (!p) {
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    throw new Error(`${label ? label + ": " : ""}createProgram falhou (contexto perdido?)`);
  }
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  if (opts.attribs) for (const [n, idx] of Object.entries(opts.attribs)) gl.bindAttribLocation(p, idx, n);
  if (opts.feedback?.length) {
    gl.transformFeedbackVaryings(
      p,
      opts.feedback as string[],
      opts.feedbackMode === "interleaved" ? gl.INTERLEAVED_ATTRIBS : gl.SEPARATE_ATTRIBS,
    );
  }
  gl.linkProgram(p);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = (gl.getProgramInfoLog(p) ?? "").trim();
    gl.deleteProgram(p);
    throw new Error(`${label ? label + ": " : ""}programa não ligou: ${log || "(driver sem log)"}`);
  }

  const ulocs = new Map<string, WebGLUniformLocation | null>();
  const alocs = new Map<string, number>();
  const loc = (n: string) => {
    let l = ulocs.get(n);
    if (l === undefined) {
      l = gl.getUniformLocation(p, n);
      ulocs.set(n, l);
    }
    return l;
  };

  const prog: Program = {
    p,
    use: () => gl.useProgram(p),
    loc,
    attrib(n) {
      let a = alocs.get(n);
      if (a === undefined) {
        a = gl.getAttribLocation(p, n);
        alocs.set(n, a);
      }
      return a;
    },
    f: (n, v) => gl.uniform1f(loc(n), v),
    i: (n, v) => gl.uniform1i(loc(n), v),
    u: (n, v) => gl.uniform1ui(loc(n), v >>> 0),
    v2: (n, a, b) => gl.uniform2f(loc(n), a, b),
    v3: (n, c) => gl.uniform3f(loc(n), c[0], c[1], c[2]),
    v4: (n, a, b, c, d) => gl.uniform4f(loc(n), a, b, c, d),
    m4: (n, m) => gl.uniformMatrix4fv(loc(n), false, m),
    common(sig, pal, w, h) {
      gl.uniform2f(loc("uRes"), w, h);
      gl.uniform1f(loc("uTime"), sig.clock);
      gl.uniform1f(loc("uLow"), sig.low);
      gl.uniform1f(loc("uMid"), sig.mid);
      gl.uniform1f(loc("uHigh"), sig.high);
      gl.uniform1f(loc("uBeat"), sig.beat);
      gl.uniform3fv(loc("uCanvas"), pal.canvas);
      gl.uniform3fv(loc("uInk"), pal.ink);
      gl.uniform3fv(loc("uInk2"), pal.ink2);
      gl.uniform3fv(loc("uSoft"), pal.soft);
    },
    dispose: () => gl.deleteProgram(p),
  };
  return prog;
}

/* ---------- render target ---------- */

export interface TargetOptions {
  /** RGBA16F quando o driver renderiza em float (EXT_color_buffer_float);
      senão cai em RGBA8 e `half` sai false. */
  half?: boolean;
  filter?: "linear" | "nearest";
  wrap?: "clamp" | "repeat";
}

export interface Target {
  readonly tex: WebGLTexture;
  readonly fb: WebGLFramebuffer;
  readonly w: number;
  readonly h: number;
  /** true = a textura é RGBA16F. */
  readonly half: boolean;
  dispose(): void;
}

export function makeTarget(gl: WebGL2RenderingContext, w: number, h: number, opts: TargetOptions = {}): Target {
  const tex = gl.createTexture();
  const fb = gl.createFramebuffer();
  if (!tex || !fb) throw new Error("makeTarget: textura/framebuffer não criados (contexto perdido?)");
  let half = !!opts.half && !!gl.getExtension("EXT_color_buffer_float");
  const filter = opts.filter === "nearest" ? gl.NEAREST : gl.LINEAR;
  const wrap = opts.wrap === "repeat" ? gl.REPEAT : gl.CLAMP_TO_EDGE;
  const alloc = () =>
    gl.texImage2D(
      gl.TEXTURE_2D, 0, half ? gl.RGBA16F : gl.RGBA8, w, h, 0,
      gl.RGBA, half ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE, null,
    );
  gl.bindTexture(gl.TEXTURE_2D, tex);
  alloc();
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
  gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (half && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    // Extensão anunciada mas o framebuffer não fecha (driver): cai pra 8 bits.
    half = false;
    alloc();
  }
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.bindTexture(gl.TEXTURE_2D, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    gl.deleteTexture(tex);
    gl.deleteFramebuffer(fb);
    throw new Error(`makeTarget: framebuffer ${w}x${h} incompleto (0x${status.toString(16)})`);
  }
  return {
    tex, fb, w, h, half,
    dispose() {
      gl.deleteTexture(tex);
      gl.deleteFramebuffer(fb);
    },
  };
}

/* ---------- transform feedback ---------- */

export interface FeedbackRun {
  tf: WebGLTransformFeedback;
  /** VAO com os atributos de ENTRADA (nunca o buffer de saída). */
  vao: WebGLVertexArrayObject;
  /** Buffer(s) de saída, na ordem dos varyings do programa. */
  out: WebGLBuffer | readonly WebGLBuffer[];
  count: number;
  /** POINTS (padrão), LINES ou TRIANGLES. */
  primitive?: number;
}

/**
 * Roda um passo de simulação por transform feedback com o programa JÁ
 * em uso (e uniforms setados). Cuida das armadilhas do WebGL2: o buffer
 * de saída não pode estar ligado em ARRAY_BUFFER, a rasterização fica
 * desligada durante o passo e tudo é desligado no fim.
 */
export function runFeedback(gl: WebGL2RenderingContext, r: FeedbackRun): void {
  const outs = Array.isArray(r.out) ? (r.out as readonly WebGLBuffer[]) : [r.out as WebGLBuffer];
  const prim = r.primitive ?? gl.POINTS;
  gl.bindBuffer(gl.ARRAY_BUFFER, null);
  gl.bindVertexArray(r.vao);
  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, r.tf);
  for (let i = 0; i < outs.length; i++) gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, i, outs[i]);
  gl.enable(gl.RASTERIZER_DISCARD);
  gl.beginTransformFeedback(prim);
  gl.drawArrays(prim, 0, r.count);
  gl.endTransformFeedback();
  gl.disable(gl.RASTERIZER_DISCARD);
  for (let i = 0; i < outs.length; i++) gl.bindBufferBase(gl.TRANSFORM_FEEDBACK_BUFFER, i, null);
  gl.bindTransformFeedback(gl.TRANSFORM_FEEDBACK, null);
  gl.bindVertexArray(null);
}

/* ---------- buffers e estado ---------- */

/** Cria um ARRAY_BUFFER com os dados e devolve-o (deixa desligado). */
export function makeBuffer(
  gl: WebGL2RenderingContext,
  data: AllowSharedBufferSource | number,
  usage: number = gl.STATIC_DRAW,
  target: number = gl.ARRAY_BUFFER,
): WebGLBuffer {
  const b = gl.createBuffer();
  if (!b) throw new Error("makeBuffer: createBuffer falhou (contexto perdido?)");
  gl.bindBuffer(target, b);
  if (typeof data === "number") gl.bufferData(target, data, usage);
  else gl.bufferData(target, data, usage);
  gl.bindBuffer(target, null);
  return b;
}

/** Liga um atributo float de `size` componentes ao VAO corrente. */
export function attribF(
  gl: WebGL2RenderingContext,
  loc: number,
  buf: WebGLBuffer,
  size: number,
  stride = 0,
  offset = 0,
  divisor = 0,
): void {
  if (loc < 0) return; // otimizado fora pelo driver
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
  if (divisor) gl.vertexAttribDivisor(loc, divisor);
}

export function clearTo(gl: WebGL2RenderingContext, c: Vec3): void {
  gl.clearColor(c[0], c[1], c[2], 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

/**
 * Blending nomeado.
 *   "add"       ONE, ONE — soma pura (cor já pré-multiplicada no shader).
 *   "add-alpha" SRC_ALPHA, ONE — o AdditiveBlending do three (material
 *               não pré-multiplicado): soma rgb*alpha.
 *   "alpha"     SRC_ALPHA, ONE_MINUS_SRC_ALPHA — o NormalBlending do three.
 *   "off"       desliga.
 */
export function blend(gl: WebGL2RenderingContext, mode: "add" | "add-alpha" | "alpha" | "off"): void {
  if (mode === "off") {
    gl.disable(gl.BLEND);
    return;
  }
  gl.enable(gl.BLEND);
  gl.blendEquation(gl.FUNC_ADD);
  if (mode === "add") gl.blendFunc(gl.ONE, gl.ONE);
  else if (mode === "add-alpha") gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE, gl.ONE, gl.ONE);
  else gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
}
