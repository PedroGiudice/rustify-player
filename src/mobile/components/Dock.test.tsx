/* ============================================================
   Dock.test.tsx — tabbar (mobile-4).

   Tocar a aba JÁ ativa, na raiz dela, não fazia nada (navigate()
   retorna quando o hash já é o alvo). O esperado é subir a lista
   ao topo. Numa sub-rota a aba continua levando de volta à raiz.
   ============================================================ */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@solidjs/testing-library";

const nav = vi.hoisted(() => ({
  base: { path: "/library", param: null as string | null },
  navigate: vi.fn(),
  openNowPlaying: vi.fn(),
  playing: null as null | Record<string, unknown>,
  isPlaying: false,
  shuffleAll: vi.fn(),
  playTrackFrom: vi.fn(),
  recents: [] as Array<Record<string, unknown>>,
}));

vi.mock("../nav", () => ({
  activeTab: () => (nav.base.path === "/folder" ? "/library" : nav.base.path),
  baseRoute: () => nav.base,
  navigate: nav.navigate,
  openNowPlaying: nav.openNowPlaying,
}));

vi.mock("../ipc", () => ({ assetSrc: () => null }));

vi.mock("../store", () => ({
  current: () => nav.playing,
  next: vi.fn(),
  pb: {
    positionMs: 0,
    durationMs: 0,
    get isPlaying() {
      return nav.isPlaying;
    },
  },
  previous: vi.fn(),
  queueContextId: () => null,
  queueOrigin: () => "manual",
  toggle: vi.fn(),
  recents: () => nav.recents,
  tracks: () => [{ id: "9" }],
  shuffleAll: nav.shuffleAll,
  playTrackFrom: nav.playTrackFrom,
}));

import { Dock } from "./Dock";
import { pushFft } from "../bg/spectrum";

function mountView(scrollTop: number) {
  const view = document.createElement("div");
  view.className = "view";
  document.body.appendChild(view);
  view.scrollTop = scrollTop;
  return view;
}

afterEach(() => {
  cleanup();
  document.querySelectorAll(".view").forEach((v) => v.remove());
  nav.base = { path: "/library", param: null };
  nav.playing = null;
  nav.isPlaying = false;
  vi.clearAllMocks();
});

describe("tabbar", () => {
  it("tocar a aba ativa na raiz sobe a lista ao topo, sem empilhar histórico", () => {
    const view = mountView(900);
    const r = render(() => <Dock />);
    fireEvent.click(r.getByRole("button", { name: "Biblioteca" }));
    expect(view.scrollTop).toBe(0);
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it("numa sub-rota, a aba leva de volta à raiz dela", () => {
    nav.base = { path: "/folder", param: "Rap" };
    const r = render(() => <Dock />);
    fireEvent.click(r.getByRole("button", { name: "Biblioteca" }));
    expect(nav.navigate).toHaveBeenCalledWith("/library");
  });

  it("outra aba navega normalmente", () => {
    const r = render(() => <Dock />);
    fireEvent.click(r.getByRole("button", { name: "Início" }));
    expect(nav.navigate).toHaveBeenCalledWith("/home");
  });
});

describe("acessibilidade (mobile-20)", () => {
  it("a navegação tem nome e só a aba ativa é aria-current=page", () => {
    const r = render(() => <Dock />);
    expect(r.getByRole("navigation", { name: "Navegação principal" })).toBeTruthy();
    expect(r.getByRole("button", { name: "Biblioteca" }).getAttribute("aria-current")).toBe("page");
    expect(r.getByRole("button", { name: "Início" }).hasAttribute("aria-current")).toBe(false);
  });

  it("o mini player abre o Now Playing pelo teclado e pelo leitor de tela", () => {
    nav.playing = {
      id: "1",
      title: "Faixa",
      artist_name: "Fulano",
      album_cover_path: null,
    };
    const r = render(() => <Dock />);
    const open = r.getByRole("button", { name: "Abrir a tela da faixa tocando: Faixa" });
    fireEvent.keyDown(open, { key: "Enter" });
    expect(nav.openNowPlaying).toHaveBeenCalledTimes(1);
    // Ativação do TalkBack chega como click sem gesto de ponteiro antes.
    fireEvent.click(open);
    expect(nav.openNowPlaying).toHaveBeenCalledTimes(2);
  });

  it("o click que segue um gesto de toque não abre o NP de novo", () => {
    nav.playing = { id: "1", title: "Faixa", artist_name: "Fulano", album_cover_path: null };
    const r = render(() => <Dock />);
    const open = r.getByRole("button", { name: "Abrir a tela da faixa tocando: Faixa" });
    fireEvent.pointerDown(open, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(open, { clientX: 10, clientY: 10 });
    fireEvent.click(open);
    expect(nav.openNowPlaying).toHaveBeenCalledTimes(1);
  });
});

describe("VU do mini (A56)", () => {
  const playing = { id: "1", title: "Faixa", artist_name: "Fulano", album_cover_path: null };
  const bars = (r: ReturnType<typeof render>) =>
    [...r.container.querySelectorAll<HTMLElement>(".vu i")].map((i) => i.style.transform);

  it("tocando, as barras seguem o FFT (grave alto, agudo baixo)", () => {
    nav.playing = playing;
    nav.isPlaying = true;
    const r = render(() => <Dock />);
    pushFft(0.9, 0.3, 0.05);
    const t = bars(r);
    expect(t).toHaveLength(4);
    const sy = t.map((v) => parseFloat(/scaleY\(([\d.]+)\)/.exec(v)![1]));
    expect(sy[0]).toBeGreaterThan(sy[3]);
    // o mesmo quadro duas vezes dá a mesma altura: medição, não sorteio
    pushFft(0.9, 0.3, 0.05);
    expect(bars(r)).toEqual(t);
  });

  it("pausado, o FFT não mexe nas barras", () => {
    nav.playing = playing;
    nav.isPlaying = false;
    const r = render(() => <Dock />);
    const rest = bars(r);
    pushFft(0.9, 0.9, 0.9);
    expect(bars(r)).toEqual(rest);
  });
});

describe("gestos do mini (A58)", () => {
  const playing = { id: "1", title: "Faixa", artist_name: "Fulano", album_cover_path: null };

  it("arrastar para cima abre o Now Playing", () => {
    nav.playing = playing;
    const r = render(() => <Dock />);
    const mini = r.container.querySelector(".mini")!;
    fireEvent.pointerDown(mini, { clientX: 100, clientY: 100 });
    fireEvent.pointerUp(mini, { clientX: 100, clientY: 30 });
    expect(nav.openNowPlaying).toHaveBeenCalledTimes(1);
  });

  it("pointercancel no meio zera o gesto: o pointerup que sobrar não abre", () => {
    nav.playing = playing;
    const r = render(() => <Dock />);
    const mini = r.container.querySelector(".mini")!;
    fireEvent.pointerDown(mini, { clientX: 100, clientY: 100 });
    fireEvent.pointerCancel(mini, { clientX: 100, clientY: 60 });
    fireEvent.pointerUp(mini, { clientX: 100, clientY: 30 });
    expect(nav.openNowPlaying).not.toHaveBeenCalled();
  });
});

describe("mini vazio (A64)", () => {
  it("sem faixa, oferece continuar a última e o aleatório", () => {
    nav.recents = [{ id: "3", title: "Última", artist_name: "X", album_cover_path: null }];
    const r = render(() => <Dock />);
    fireEvent.click(r.getByRole("button", { name: "Continuar Última" }));
    expect(nav.playTrackFrom).toHaveBeenCalledWith(nav.recents, 0);
    fireEvent.click(r.getByRole("button", { name: "Tudo em aleatório" }));
    expect(nav.shuffleAll).toHaveBeenCalledTimes(1);
    nav.recents = [];
  });
});
