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
  pb: { positionMs: 0, durationMs: 0, isPlaying: false },
  previous: vi.fn(),
  queueContextId: () => null,
  queueOrigin: () => "manual",
  toggle: vi.fn(),
}));

import { Dock } from "./Dock";

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
  vi.clearAllMocks();
});

describe("tabbar", () => {
  it("tocar a aba ativa na raiz sobe a lista ao topo, sem empilhar histórico", () => {
    const view = mountView(900);
    const r = render(() => <Dock />);
    fireEvent.click(r.getByRole("button", { name: "Library" }));
    expect(view.scrollTop).toBe(0);
    expect(nav.navigate).not.toHaveBeenCalled();
  });

  it("numa sub-rota, a aba leva de volta à raiz dela", () => {
    nav.base = { path: "/folder", param: "Rap" };
    const r = render(() => <Dock />);
    fireEvent.click(r.getByRole("button", { name: "Library" }));
    expect(nav.navigate).toHaveBeenCalledWith("/library");
  });

  it("outra aba navega normalmente", () => {
    const r = render(() => <Dock />);
    fireEvent.click(r.getByRole("button", { name: "Home" }));
    expect(nav.navigate).toHaveBeenCalledWith("/home");
  });
});

describe("acessibilidade (mobile-20)", () => {
  it("a navegação tem nome e só a aba ativa é aria-current=page", () => {
    const r = render(() => <Dock />);
    expect(r.getByRole("navigation", { name: "Navegação principal" })).toBeTruthy();
    expect(r.getByRole("button", { name: "Library" }).getAttribute("aria-current")).toBe("page");
    expect(r.getByRole("button", { name: "Home" }).hasAttribute("aria-current")).toBe(false);
  });

  it("o mini player abre o Now Playing pelo teclado e pelo leitor de tela", () => {
    nav.playing = {
      id: "1",
      title: "Faixa",
      artist_name: "Fulano",
      album_cover_path: null,
    };
    const r = render(() => <Dock />);
    const open = r.getByRole("button", { name: "Abrir Now Playing: Faixa" });
    fireEvent.keyDown(open, { key: "Enter" });
    expect(nav.openNowPlaying).toHaveBeenCalledTimes(1);
    // Ativação do TalkBack chega como click sem gesto de ponteiro antes.
    fireEvent.click(open);
    expect(nav.openNowPlaying).toHaveBeenCalledTimes(2);
  });

  it("o click que segue um gesto de toque não abre o NP de novo", () => {
    nav.playing = { id: "1", title: "Faixa", artist_name: "Fulano", album_cover_path: null };
    const r = render(() => <Dock />);
    const open = r.getByRole("button", { name: "Abrir Now Playing: Faixa" });
    fireEvent.pointerDown(open, { clientX: 10, clientY: 10 });
    fireEvent.pointerUp(open, { clientX: 10, clientY: 10 });
    fireEvent.click(open);
    expect(nav.openNowPlaying).toHaveBeenCalledTimes(1);
  });
});
