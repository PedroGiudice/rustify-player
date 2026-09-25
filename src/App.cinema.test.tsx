/* ============================================================
   App.cinema.test.tsx — o estado do cinema é canônico no App e o
   NowPlaying espelha pelo evento "rustify:cinema". O Esc mudava o
   estado sem emitir o evento: o ícone do Now Playing ficava em
   "shrink" e o próximo clique mandava detail=false, exigindo dois
   cliques para voltar ao cinema (achado np-8, auditoria 25/09).

   Revisão da fase 0 (25/09): no cinema, o Esc que fechava a fila ou o
   menu de contexto também saía do cinema no mesmo toque — o handler do
   App é registrado antes dos overlays no window. Com uma camada aberta
   na pilha (lib/escLayers), o Esc é dela.
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
import { pushEscLayer } from "./lib/escLayers";

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

  it("com uma camada aberta (fila, menu), o Esc fecha a camada e fica no cinema", () => {
    render(() => <App />);
    window.dispatchEvent(new CustomEvent<boolean>("rustify:cinema", { detail: true }));
    // Registrada DEPOIS do App, como a fila e o menu de contexto reais.
    let closed = 0;
    const pop = pushEscLayer(() => { closed++; pop(); });

    const seen: boolean[] = [];
    const onCinema = (e: Event) => seen.push((e as CustomEvent<boolean>).detail);
    window.addEventListener("rustify:cinema", onCinema);
    const esc = () => window.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", cancelable: true }),
    );
    esc();
    expect(closed).toBe(1);
    expect(seen).toEqual([]);
    expect(document.getElementById("rustify-app")?.getAttribute("data-cinema")).toBe("true");

    // Sem camada, o próximo Esc volta a sair do cinema.
    esc();
    window.removeEventListener("rustify:cinema", onCinema);
    expect(seen).toEqual([false]);
  });

  it("Esc já consumido por um controle focado não sai do cinema", () => {
    render(() => <App />);
    window.dispatchEvent(new CustomEvent<boolean>("rustify:cinema", { detail: true }));
    const btn = document.createElement("button");
    document.body.appendChild(btn);
    btn.addEventListener("keydown", (e) => e.preventDefault());
    try {
      btn.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      expect(document.getElementById("rustify-app")?.getAttribute("data-cinema")).toBe("true");
    } finally {
      btn.remove();
    }
  });
});
