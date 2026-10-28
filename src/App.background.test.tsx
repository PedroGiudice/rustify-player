/* ============================================================
   App.background.test.tsx — a ligação App -> GlBackground -> host que
   evita o B6 voltar (26/10: o filter CSS de tela cheia no .app-bg
   derrubava a Home a 46,9 fps). Com o WebGL montado o .app-bg leva
   data-engine="webgl" (o CSS do ambient não vale) e o motor recebe o
   modo da rota; o WebGL caindo para o 2D tira a marca, religar põe de
   novo.
   ============================================================ */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, waitFor } from "@solidjs/testing-library";
import type { GlHostOptions } from "./gl/host";

const hostCalls = vi.hoisted(() => ({ opts: [] as GlHostOptions[], stops: 0 }));
const nav = vi.hoisted(() => ({ set: (_p: string) => {} }));

vi.mock("./components/Titlebar", () => ({ Titlebar: () => null }));
vi.mock("./components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("./components/PlayerBar", () => ({ PlayerBar: () => null }));
vi.mock("./components/CommandPalette", () => ({ CommandPalette: () => null }));
vi.mock("./components/QueueDrawer", () => ({ QueueDrawer: () => null }));
vi.mock("./components/TrackContextMenu", () => ({ TrackContextMenu: () => null }));
vi.mock("./components/SpectrumCanvas", () => ({ SpectrumCanvas: () => <canvas class="spectrum-2d" /> }));
vi.mock("./views/Tweaks", () => ({ Tweaks: () => null }));
vi.mock("./router", async () => {
  const { createSignal } = await import("solid-js");
  const [path, setPath] = createSignal("/");
  nav.set = setPath;
  return { RouterView: () => null, navigate: vi.fn(), route: () => ({ path: path(), param: null }) };
});
vi.mock("./store/tweaks", () => ({
  loadTweaks: vi.fn(),
  tweaks: () => ({
    bgEngine: "webgl",
    bgScene: "paint",
    bgBassGain: 1, bgMidGain: 1, bgTrebleGain: 1, bgSmoothing: 0.5,
    bgSpeed: 1, bgBeatMode: "pulse", bgBeatDepth: 1,
  }),
  bgCalm: () => false,
  reducedMotion: () => false,
}));
vi.mock("./tauri", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  onAudioFft: () => Promise.resolve(() => {}),
  spectrumSubscribe: () => Promise.resolve(),
}));
vi.mock("./gl/host", () => ({
  startGlHost: (o: GlHostOptions) => {
    hostCalls.opts.push(o);
    return () => { hostCalls.stops++; };
  },
}));

import App from "./App";
import { resetGlStatus, setGlStatus } from "./gl/meta";

afterEach(() => cleanup());

describe("App — fundo WebGL e o modo ambient", () => {
  it("marca o .app-bg, entrega o modo da rota ao motor e solta a marca quando o WebGL cai", async () => {
    render(() => <App />);
    const bg = document.querySelector(".app-bg")!;
    await waitFor(() => expect(bg.getAttribute("data-engine")).toBe("webgl"));
    expect(bg.getAttribute("data-mode")).toBe("ambient");
    const o = hostCalls.opts.at(-1)!;
    expect(o.mode?.()).toBe("ambient");
    expect(o.reduced?.()).toBe(false);
    // O canvas do motor mora dentro do .app-bg (a marca vai no pai dele).
    expect(o.canvas.parentElement).toBe(bg);

    nav.set("/now-playing");
    expect(o.mode?.()).toBe("focused");
    nav.set("/");

    // WebGL caiu: o App volta ao 2D, a marca sai e o CSS do 2D vale.
    setGlStatus({ ok: false, renderer: "", error: "perdido", fps: 0 });
    await waitFor(() => expect(bg.hasAttribute("data-engine")).toBe(false));
    expect(bg.querySelector(".spectrum-2d")).not.toBeNull();
    expect(hostCalls.stops).toBeGreaterThan(0);

    // Religar o motor (Tweaks): a marca volta.
    resetGlStatus();
    await waitFor(() => expect(bg.getAttribute("data-engine")).toBe("webgl"));
  });
});
