import { describe, it, expect } from "vitest";
import { mosaicCells } from "./mosaic";

describe("mosaicCells — playlist com poucas capas não mostra quadrante vazio", () => {
  it("sem capa: nenhuma célula de imagem (o tom aparece)", () => {
    expect(mosaicCells([])).toEqual([]);
  });
  it("uma capa ocupa o quadro inteiro", () => {
    expect(mosaicCells(["a"])).toEqual(["a"]);
  });
  it("duas capas se cruzam na diagonal", () => {
    expect(mosaicCells(["a", "b"])).toEqual(["a", "b", "b", "a"]);
  });
  it("três capas: a primeira repete no último quadrante", () => {
    expect(mosaicCells(["a", "b", "c"])).toEqual(["a", "b", "c", "a"]);
  });
  it("quatro ou mais: as quatro primeiras", () => {
    expect(mosaicCells(["a", "b", "c", "d", "e"])).toEqual(["a", "b", "c", "d"]);
  });
});
