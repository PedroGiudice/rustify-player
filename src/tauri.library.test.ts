/* ============================================================
   tauri.library.test.ts — Contrato dos wrappers de listagem da
   biblioteca: `limit: null` pede o acervo inteiro (o backend só
   trunca quando recebe um número); omitir o limit mantém o default.
   ============================================================ */
import { describe, it, expect, vi, beforeAll } from "vitest";

const invoke = vi.fn().mockResolvedValue([]);
let tauri: typeof import("./tauri");

beforeAll(async () => {
  // tauri.ts desestrutura window.__TAURI__.core no load do módulo.
  (window as any).__TAURI__.core.invoke = invoke;
  vi.resetModules();
  tauri = await import("./tauri");
});

describe("wrappers de listagem da biblioteca", () => {
  it("libGetAlbums({ limit: null }) pede tudo, sem corte", async () => {
    invoke.mockClear();
    await tauri.libGetAlbums({ limit: null });
    expect(invoke).toHaveBeenCalledWith("lib_list_albums", { artist: undefined, genre: undefined, limit: null });
  });

  it("libGetAlbums() sem limit mantém o default de 500", async () => {
    invoke.mockClear();
    await tauri.libGetAlbums();
    expect(invoke).toHaveBeenCalledWith("lib_list_albums", { artist: undefined, genre: undefined, limit: 500 });
  });

  it("libGetArtists({ limit: null }) pede tudo, sem corte", async () => {
    invoke.mockClear();
    await tauri.libGetArtists({ limit: null });
    expect(invoke).toHaveBeenCalledWith("lib_list_artists", { genre: undefined, limit: null });
  });

  it("libGetAlbumsByArtist(nome, null) filtra no backend sem corte", async () => {
    invoke.mockClear();
    await tauri.libGetAlbumsByArtist("Zeta", null);
    expect(invoke).toHaveBeenCalledWith("lib_list_albums", { artist: "Zeta", limit: null });
  });
});
