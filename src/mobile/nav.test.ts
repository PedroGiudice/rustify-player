/* ============================================================
   nav.test.ts — qual aba acende para cada rota (CMR-213).

   Queue virou aba própria (Settings saiu do tabbar: já vive no
   header da Home). Sub-rotas continuam acendendo a aba de origem.
   ============================================================ */

import { describe, expect, it } from "vitest";
import { createComputed, createRoot } from "solid-js";
import {
  TABS,
  baseRoute,
  isNpOpen,
  navigateFromNp,
  rememberScroll,
  restoreScroll,
  savedScroll,
  tabForPath,
} from "./nav";

/** jsdom dispara hashchange de forma assíncrona: espera o evento QUE LEVA a
 *  `hash` (um evento atrasado de navegação anterior não pode liberar a espera). */
function arrival(hash: string): Promise<void> {
  return new Promise((resolve) => {
    const on = (e: HashChangeEvent) => {
      if (!e.newURL.endsWith(hash)) return;
      window.removeEventListener("hashchange", on);
      resolve();
    };
    window.addEventListener("hashchange", on);
  });
}

function go(hash: string): Promise<void> {
  if (window.location.hash === hash) return Promise.resolve();
  const p = arrival(hash);
  window.location.hash = hash;
  return p;
}

function goBack(to: string): Promise<void> {
  const p = arrival(to);
  window.history.back();
  return p;
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
    const replaced = arrival("#/album/Foo");
    navigateFromNp("/album", "Foo");
    expect(baseRoute()).toEqual({ path: "/album", param: "Foo" });
    await replaced; // o hashchange do replace chama sync() de novo
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

describe("rolagem por entrada do histórico (mobile-3)", () => {
  it("voltar devolve a rolagem da entrada; entrada nova abre no topo", async () => {
    await go("#/library");
    rememberScroll(640);
    await go("#/album/X");
    expect(savedScroll()).toBeNull();
    rememberScroll(80);
    await goBack("#/library");
    expect(baseRoute().path).toBe("/library");
    expect(savedScroll()).toBe(640);
  });

  it("abrir e fechar o NP não troca a entrada da base", async () => {
    await go("#/search");
    rememberScroll(300);
    await go("#/np");
    expect(savedScroll()).toBe(300);
    await goBack("#/search");
    expect(savedScroll()).toBe(300);
  });
});

describe("restoreScroll", () => {
  /** .view de mentira: o scrollTop trava na altura que a lista já tem. */
  function fakeView(max: { v: number }) {
    let y = 0;
    return {
      get scrollTop() {
        return y;
      },
      set scrollTop(v: number) {
        y = Math.max(0, Math.min(v, max.v));
      },
    };
  }

  it("reaplica a cada quadro até a lista crescer o bastante", () => {
    const max = { v: 300 };
    const el = fakeView(max);
    const frames: Array<() => void> = [];
    restoreScroll(el, 1000, (cb) => frames.push(cb));
    expect(el.scrollTop).toBe(300);
    while (frames.length) {
      max.v += 400; // a sentinela do LazyList carregou mais um lote
      frames.shift()!();
    }
    expect(el.scrollTop).toBe(1000);
  });

  it("cancelado, para de brigar com o dedo do usuário", () => {
    const max = { v: 300 };
    const el = fakeView(max);
    const frames: Array<() => void> = [];
    const cancel = restoreScroll(el, 1000, (cb) => frames.push(cb));
    cancel();
    max.v = 5000;
    el.scrollTop = 120; // o usuário rolou
    while (frames.length) frames.shift()!();
    expect(el.scrollTop).toBe(120);
  });

  it("desiste depois de maxFrames se a lista nunca chega lá", () => {
    const el = fakeView({ v: 200 });
    let calls = 0;
    const frames: Array<() => void> = [];
    restoreScroll(
      el,
      1000,
      (cb) => {
        calls++;
        frames.push(cb);
      },
      5,
    );
    while (frames.length) frames.shift()!();
    expect(calls).toBeLessThanOrEqual(5);
    expect(el.scrollTop).toBe(200);
  });
});
