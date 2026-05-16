/* ============================================================
   test-setup.ts — Stub do __TAURI__ global para testes.
   O store/dsp.ts importa de ./tauri.ts, que toca window.__TAURI__
   no top-level. Em ambiente jsdom o objeto nao existe — stubamos
   com no-ops para o import nao explodir.
   ============================================================ */

(globalThis as any).window = globalThis.window || globalThis;
(window as any).__TAURI__ = {
  core: {
    invoke: async () => undefined,
    convertFileSrc: (p: string) => p,
  },
  event: {
    listen: async () => () => {},
  },
};
