/* ============================================================
   App.cinema.test.tsx — o estado do cinema é canônico no App e o
   NowPlaying espelha pelo evento "rustify:cinema". O Esc mudava o
   estado sem emitir o evento: o ícone do Now Playing ficava em
   "shrink" e o próximo clique mandava detail=false, exigindo dois
   cliques para voltar ao cinema (achado np-8, auditoria 25/09).
   ============================================================ */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";

vi.mock("./components/Titlebar", () => ({ Titlebar: () => null }));
vi.mock("./components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("./components/PlayerBar", () => ({ PlayerBar: () => null }));
vi.mock("./components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./components/QueueDrawer", () => ({ QueueDrawer: () => null }));
vi.mock("./components/TrackContextMenu", () => ({ TrackContextMenu: () => null }));
vi.mock("./components/SpectrumCanvas", () => ({ SpectrumCanvas: () => null }));
vi.mock("./views/Tweaks", () => ({ Tweaks: () => null }));
vi.mock("./router", () => ({
  RouterView: () => null,
  navigate: vi.fn(),
  route: () => ({ path: "/now-playing", param: null }),
}));
vi.mock("./store/tweaks", () => ({
  loadTweaks: vi.fn(),
  tweaks: () => ({ bgEngine: "2d" }),
}));

import App from "./App";

afterEach(() => cleanup());

describe("App — cinema", () => {
  it("Esc sai do cinema e avisa quem espelha o estado", () => {
    render(() => <App />);
    window.dispatchEvent(new CustomEvent<boolean>("rustify:cinema", { detail: true }));
    expect(document.getElementById("rustify-app")?.getAttribute("data-cinema")).toBe("true");

    const seen: boolean[] = [];
    const onCinema = (e: Event) => seen.push((e as CustomEvent<boolean>).detail);
    window.addEventListener("rustify:cinema", onCinema);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    window.removeEventListener("rustify:cinema", onCinema);

    expect(document.getElementById("rustify-app")?.getAttribute("data-cinema")).toBe("false");
    expect(seen).toEqual([false]);
  });

  it("Esc fora do cinema não emite nada", () => {
    render(() => <App />);
    const seen: boolean[] = [];
    const onCinema = (e: Event) => seen.push((e as CustomEvent<boolean>).detail);
    window.addEventListener("rustify:cinema", onCinema);
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    window.removeEventListener("rustify:cinema", onCinema);
    expect(seen).toEqual([]);
  });
});
