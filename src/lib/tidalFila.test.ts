import { describe, it, expect } from "vitest";
import {
  shortTidalLink, tidalStatusLabel, tidalStatusTone, isTidalActive, tidalArrivedCount,
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

describe("isTidalActive", () => {
  it("só fila e baixando estão em andamento", () => {
    expect(["fila", "baixando", "ok", "parcial", "falhou", "recusada"].filter((st) => isTidalActive(st as never)))
      .toEqual(["fila", "baixando"]);
  });
});

describe("tidalArrivedCount", () => {
  it("lê o que chegou na cmr-auto do resumo da fila", () => {
    expect(tidalArrivedCount({ resumo: "Mix: 12 novas, 3 já no acervo, 0 falhas de 15; 10 na cmr-auto", n_faixas: null })).toBe(10);
  });
  it("sem envio no resumo, as novas", () => {
    expect(tidalArrivedCount({ resumo: "Mix: 7 novas, 0 já no acervo, 0 falhas de 7", n_faixas: 30 })).toBe(7);
  });
  it("zero novas = nada chegou", () => {
    expect(tidalArrivedCount({ resumo: "X: 0 novas, 9 já no acervo, 0 falhas de 9", n_faixas: null })).toBe(0);
  });
  it("resumo vazio: as faixas do pedido, ou 1", () => {
    expect(tidalArrivedCount({ resumo: "", n_faixas: 18 })).toBe(18);
    expect(tidalArrivedCount({ resumo: "", n_faixas: null })).toBe(1);
  });
});
