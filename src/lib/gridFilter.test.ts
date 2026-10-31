import { describe, it, expect } from "vitest";
import { filterByText } from "./gridFilter";

const ALBUMS = [
  { title: "Açúcar", artist: "Céu" },
  { title: "Greatest Hits", artist: "Queen" },
  { title: "Greatest Hits", artist: "ABBA" },
];
const text = (a: (typeof ALBUMS)[number]) => `${a.title} ${a.artist}`;

describe("filterByText (B3)", () => {
  it("vazio devolve a lista inteira, na mesma ordem", () => {
    expect(filterByText(ALBUMS, "  ", text)).toEqual(ALBUMS);
  });

  it("sem acento nem caixa", () => {
    expect(filterByText(ALBUMS, "acucar", text).map((a) => a.artist)).toEqual(["Céu"]);
    expect(filterByText(ALBUMS, "CEU", text).map((a) => a.title)).toEqual(["Açúcar"]);
  });

  it("todas as palavras precisam casar, em qualquer campo e ordem", () => {
    expect(filterByText(ALBUMS, "queen greatest", text).map((a) => a.artist)).toEqual(["Queen"]);
    expect(filterByText(ALBUMS, "hits", text)).toHaveLength(2);
    expect(filterByText(ALBUMS, "hits nirvana", text)).toHaveLength(0);
  });
});
