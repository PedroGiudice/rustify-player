/* ============================================================
   test-setup.ts — Stub do __TAURI__ global para testes.
   O store/dsp.ts importa de ./tauri.ts, que toca window.__TAURI__
   no top-level. Em ambiente jsdom o objeto nao existe — stubamos
   com no-ops para o import nao explodir.
   ============================================================ */

(globalThis as any).window = globalThis.window || globalThis;

// Path2D nao existe em jsdom — stub minimo so pra nao explodir em testes
// de canvas. Em producao o browser fornece a impl real.
if (typeof (globalThis as any).Path2D === "undefined") {
  (globalThis as any).Path2D = class {
    moveTo() {}
    lineTo() {}
    bezierCurveTo() {}
    closePath() {}
  };
}

(window as any).__TAURI__ = {
  core: {
    invoke: async () => undefined,
    convertFileSrc: (p: string) => p,
  },
  event: {
    listen: async () => () => {},
  },
};
