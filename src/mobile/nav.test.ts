/* ============================================================
   nav.test.ts — qual aba acende para cada rota (CMR-213).

   Queue virou aba própria (Settings saiu do tabbar: já vive no
   header da Home). Sub-rotas continuam acendendo a aba de origem.
   ============================================================ */

import { describe, expect, it } from "vitest";
import { createComputed, createRoot } from "solid-js";
import { TABS, baseRoute, isNpOpen, navigateFromNp, tabForPath } from "./nav";

/** jsdom dispara hashchange de forma assíncrona; espera o evento chegar. */
function go(hash: string): Promise<void> {
  return new Promise((resolve) => {
    window.addEventListener("hashchange", () => resolve(), { once: true });
    window.location.hash = hash;
  });
}

/** Conta quantas vezes a rota base notificou (= quantas vezes screen() recria a tela). */
function watchBase() {
  let runs = -1;
  const dispose = createRoot((d) => {
    createComputed(() => {
      baseRoute();
      runs++;
    });
    return d;
  });
  return { runs: () => runs, dispose };
}

describe("baseRoute (mobile-v1)", () => {
  it("abrir e fechar o Now Playing não notifica a rota base", async () => {
    await go("#/library");
    const w = watchBase();
    await go("#/np");
    expect(isNpOpen()).toBe(true);
    await go("#/library");
    expect(isNpOpen()).toBe(false);
    expect(w.runs()).toBe(0);
    w.dispose();
  });

  it("navigateFromNp para a mesma rota base não remonta a tela", async () => {
    await go("#/album/Foo");
    const w = watchBase();
    await go("#/np");
    navigateFromNp("/album", "Foo");
    expect(baseRoute()).toEqual({ path: "/album", param: "Foo" });
    expect(w.runs()).toBe(0);
    w.dispose();
  });

  it("trocar de rota base continua notificando", async () => {
    await go("#/library");
    const w = watchBase();
    await go("#/album/Bar");
    expect(w.runs()).toBe(1);
    w.dispose();
  });
});

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
