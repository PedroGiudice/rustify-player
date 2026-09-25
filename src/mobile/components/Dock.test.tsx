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
}));

vi.mock("../nav", () => ({
  activeTab: () => (nav.base.path === "/folder" ? "/library" : nav.base.path),
  baseRoute: () => nav.base,
  navigate: nav.navigate,
  openNowPlaying: vi.fn(),
}));

vi.mock("../ipc", () => ({ assetSrc: () => null }));

vi.mock("../store", () => ({
  current: () => null,
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
