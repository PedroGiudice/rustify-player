import { describe, it, expect, beforeEach } from "vitest";
import {
  shortTidalLink, tidalStatusLabel, tidalStatusTone, loadLastTidalDest, saveLastTidalDest,
} from "./tidalFila";

describe("shortTidalLink", () => {
  it("corta tudo até depois de tidal.com/", () => {
    expect(shortTidalLink("https://tidal.com/mix/abc123")).toBe("mix/abc123");
    expect(shortTidalLink("https://listen.tidal.com/browse/album/xyz")).toBe("browse/album/xyz");
  });
  it("sem tidal.com devolve o link inteiro", () => {
    expect(shortTidalLink("https://soundcloud.com/x")).toBe("https://soundcloud.com/x");
  });
});

describe("tidalStatusLabel", () => {
  it("mapeia os 6 estados para o rótulo em PT-BR da página web", () => {
    expect(tidalStatusLabel("fila")).toBe("na fila");
    expect(tidalStatusLabel("baixando")).toBe("baixando");
    expect(tidalStatusLabel("ok")).toBe("na cmr-auto");
    expect(tidalStatusLabel("parcial")).toBe("parcial");
    expect(tidalStatusLabel("falhou")).toBe("falhou");
    expect(tidalStatusLabel("recusada")).toBe("recusada");
  });
});

describe("tidalStatusTone", () => {
  it("mapeia cada estado para o tom do chip", () => {
    expect(tidalStatusTone("fila")).toBe("sub");
    expect(tidalStatusTone("baixando")).toBe("live");
    expect(tidalStatusTone("ok")).toBe("ready");
    expect(tidalStatusTone("parcial")).toBe("warn");
    expect(tidalStatusTone("falhou")).toBe("err");
    expect(tidalStatusTone("recusada")).toBe("err");
  });
});

describe("destino persistido (kv-crate-tidal-dest)", () => {
  beforeEach(() => localStorage.clear());
  it("null quando nunca foi salvo", () => {
    expect(loadLastTidalDest()).toBeNull();
  });
  it("salva e recupera", () => {
    saveLastTidalDest("Jazz");
    expect(loadLastTidalDest()).toBe("Jazz");
  });
});
