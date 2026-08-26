/* ============================================================
   nav.test.ts — qual aba acende para cada rota (CMR-213).

   Queue virou aba própria (Settings saiu do tabbar: já vive no
   header da Home). Sub-rotas continuam acendendo a aba de origem.
   ============================================================ */

import { describe, expect, it } from "vitest";
import { TABS, tabForPath } from "./nav";

describe("TABS", () => {
  it("tem Queue no lugar de Settings", () => {
    expect(TABS).toEqual(["/home", "/search", "/library", "/queue"]);
  });
});

describe("tabForPath", () => {
  it("abas diretas acendem a si mesmas", () => {
    for (const t of TABS) expect(tabForPath(t)).toBe(t);
  });

  it("a fila é aba própria — não acende mais Library", () => {
    expect(tabForPath("/queue")).toBe("/queue");
  });

  it("sub-rotas do acervo acendem Library", () => {
    expect(tabForPath("/folder")).toBe("/library");
    expect(tabForPath("/album")).toBe("/library");
    expect(tabForPath("/artist")).toBe("/library");
  });

  it("stations e settings (abertos pelo header da Home) acendem Home", () => {
    expect(tabForPath("/stations")).toBe("/home");
    expect(tabForPath("/settings")).toBe("/home");
  });

  it("rota desconhecida cai em Home", () => {
    expect(tabForPath("/nada")).toBe("/home");
  });
});
