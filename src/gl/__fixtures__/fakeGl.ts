/* ============================================================
   __fixtures__/fakeGl.ts — WebGL2 falso para os testes do motor.

   O jsdom não tem WebGL. Este dublê responde ao que o motor e as
   cenas chamam, e RASTREIA os recursos criados/apagados: o teste de
   vazamento (engine.test.ts) passa por todas as cenas registradas e
   exige que a troca de cena e o dispose devolvam tudo. Cena nova
   entra no teste sozinha.

   Constantes (gl.COMPILE_STATUS etc.) são números estáveis derivados
   do nome; métodos desconhecidos viram no-op que só registra a chamada.
   ============================================================ */

export interface FakeGlOptions {
  /** Devolve o log de erro para fontes que "não compilam" (null = compila). */
  failCompile?: (src: string) => string | null;
  /** Anuncia EXT_color_buffer_float. */
  colorBufferFloat?: boolean;
  /** Status do framebuffer; recebe se a textura ligada é half-float. */
  framebufferComplete?: (half: boolean) => boolean;
}

type Kind = "shader" | "program" | "buffer" | "texture" | "framebuffer" | "vertexArray" | "transformFeedback";

export interface FakeResource {
  kind: Kind;
  id: number;
  src?: string;
  half?: boolean;
}

export interface FakeGl {
  gl: WebGL2RenderingContext;
  /** Recursos criados e ainda não apagados. */
  live: Set<FakeResource>;
  calls: Array<[string, unknown[]]>;
  count(name: string): number;
  loseContext: { calls: number };
}

function constOf(name: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
  return (h >>> 0) % 0x7fffffff;
}

export function makeFakeGl(opts: FakeGlOptions = {}): FakeGl {
  const live = new Set<FakeResource>();
  const calls: Array<[string, unknown[]]> = [];
  const loseContext = { calls: 0 };
  let nextId = 1;
  let boundTex: FakeResource | null = null;
  const make = (kind: Kind): FakeResource => {
    const r: FakeResource = { kind, id: nextId++ };
    live.add(r);
    return r;
  };
  const del = (r: unknown) => {
    if (r) live.delete(r as FakeResource);
  };
  const C = (n: string) => constOf(n);

  const impl: Record<string, unknown> = {
    createShader: () => make("shader"),
    createProgram: () => make("program"),
    createBuffer: () => make("buffer"),
    createTexture: () => make("texture"),
    createFramebuffer: () => make("framebuffer"),
    createVertexArray: () => make("vertexArray"),
    createTransformFeedback: () => make("transformFeedback"),
    deleteShader: del,
    deleteProgram: del,
    deleteBuffer: del,
    deleteTexture: del,
    deleteFramebuffer: del,
    deleteVertexArray: del,
    deleteTransformFeedback: del,
    shaderSource: (s: FakeResource, src: string) => { s.src = src; },
    getShaderParameter: (s: FakeResource) => !(opts.failCompile?.(s.src ?? "")),
    getShaderInfoLog: (s: FakeResource) => opts.failCompile?.(s.src ?? "") ?? "",
    getProgramParameter: () => true,
    getProgramInfoLog: () => "",
    getUniformLocation: (_p: unknown, name: string) => ({ uniform: name }),
    getAttribLocation: (_p: unknown, name: string) => (constOf(name) % 8),
    getExtension: (name: string) => {
      if (name === "EXT_color_buffer_float") return opts.colorBufferFloat ? {} : null;
      if (name === "WEBGL_lose_context") return { loseContext: () => { loseContext.calls++; } };
      return null;
    },
    getParameter: (p: number) => {
      if (p === C("ALIASED_POINT_SIZE_RANGE")) return new Float32Array([1, 64]);
      if (p === C("RENDERER")) return "Fake GPU";
      return 0;
    },
    getError: () => 0,
    bindTexture: (_t: number, tex: FakeResource | null) => { boundTex = tex; },
    texImage2D: (...a: unknown[]) => {
      if (boundTex) boundTex.half = a[2] === C("RGBA16F");
    },
    checkFramebufferStatus: () =>
      (opts.framebufferComplete ? opts.framebufferComplete(!!boundTex?.half) : true)
        ? C("FRAMEBUFFER_COMPLETE")
        : C("FRAMEBUFFER_INCOMPLETE_ATTACHMENT"),
  };

  const gl = new Proxy(impl, {
    get(t, p) {
      if (typeof p !== "string") return undefined;
      if (p in t) {
        const v = t[p];
        if (typeof v !== "function") return v;
        return (...args: unknown[]) => {
          calls.push([p, args]);
          return (v as (...a: unknown[]) => unknown)(...args);
        };
      }
      if (/^[A-Z0-9_]+$/.test(p)) return constOf(p);
      return (...args: unknown[]) => {
        calls.push([p, args]);
        return undefined;
      };
    },
  }) as unknown as WebGL2RenderingContext;

  return {
    gl,
    live,
    calls,
    count: (name) => calls.filter((c) => c[0] === name).length,
    loseContext,
  };
}

export interface FakeCanvas {
  canvas: HTMLCanvasElement;
  fire(type: string): void;
}

export function makeFakeCanvas(gl: WebGL2RenderingContext | null): FakeCanvas {
  const listeners = new Map<string, Set<(e: Event) => void>>();
  const canvas = {
    width: 300,
    height: 150,
    isConnected: true,
    getBoundingClientRect: () => ({ width: 800, height: 450, top: 0, left: 0, right: 800, bottom: 450 }),
    getContext: (kind: string) => (kind === "webgl2" ? gl : null),
    addEventListener: (type: string, fn: (e: Event) => void) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: (e: Event) => void) => listeners.get(type)?.delete(fn),
  } as unknown as HTMLCanvasElement;
  return {
    canvas,
    fire(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn(new Event(type));
    },
  };
}
