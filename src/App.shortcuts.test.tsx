/* ============================================================
   App.shortcuts.test.tsx — atalhos globais N/H/L do shell.

   Auditoria de UI 25/09 (shell-13, cfg-10, nowplaying-v4): o filtro
   ignorava só input e textarea. Com foco no <select> de fonte do
   Tweaks, digitar "n" para chegar a "Noto Sans" ia para o Now
   Playing. O filtro agora também cobre select, contenteditable e
   composição de IME.
   ============================================================ */

import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("./router", () => ({
  RouterView: () => null,
  navigate: navigateMock,
  route: () => ({ path: "/home", param: null }),
}));
vi.mock("./components/Titlebar", () => ({ Titlebar: () => null }));
vi.mock("./components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("./components/PlayerBar", () => ({ PlayerBar: () => null }));
vi.mock("./components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./components/QueueDrawer", () => ({ QueueDrawer: () => null }));
vi.mock("./components/TrackContextMenu", () => ({ TrackContextMenu: () => null }));
vi.mock("./components/SpectrumCanvas", () => ({ SpectrumCanvas: () => null }));
vi.mock("./views/Tweaks", () => ({ Tweaks: () => null }));
vi.mock("./store/tweaks", () => ({
  loadTweaks: () => {},
  tweaks: () => ({ bgEngine: "2d" }),
}));

import App from "./App";

afterEach(() => {
  cleanup();
  navigateMock.mockClear();
  document.body.querySelectorAll("[data-test-field]").forEach((el) => el.remove());
});

function pressOn(el: EventTarget, key: string, init: KeyboardEventInit = {}) {
  el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...init }));
}

describe("atalhos globais do App", () => {
  it("N fora de campo navega para o Now Playing", () => {
    render(() => <App />);
    pressOn(document.body, "n");
    expect(navigateMock).toHaveBeenCalledWith("/now-playing");
  });

  it("N, H e L com foco num <select> não navegam (typeahead do select)", () => {
    render(() => <App />);
    const sel = document.createElement("select");
    sel.setAttribute("data-test-field", "");
    document.body.appendChild(sel);
    pressOn(sel, "n");
    pressOn(sel, "h");
    pressOn(sel, "l");
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("N dentro de contenteditable não navega", () => {
    render(() => <App />);
    const ed = document.createElement("div");
    ed.setAttribute("contenteditable", "true");
    ed.setAttribute("data-test-field", "");
    document.body.appendChild(ed);
    pressOn(ed, "n");
    expect(navigateMock).not.toHaveBeenCalled();
  });

  it("N durante composição de IME não navega", () => {
    render(() => <App />);
    pressOn(document.body, "n", { isComposing: true });
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
