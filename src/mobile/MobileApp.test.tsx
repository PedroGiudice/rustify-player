/* ============================================================
   MobileApp.test.tsx — o que está atrás do Now Playing aberto sai
   da árvore de acessibilidade.

   A correção do mobile-20 pôs inert no .np FECHADO. O contrário
   ficou de fora: com o NP aberto (z 30, cobrindo o .device), o
   .shell com a tela e o Dock seguia acessível, e a navegação linear
   do TalkBack saía do Now Playing para as linhas e abas escondidas
   atrás (revisão da fase 0, 25/09).
   ============================================================ */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";

const h = vi.hoisted(() => ({ npOpen: null as null | (() => boolean), setNpOpen: null as null | ((v: boolean) => void) }));

vi.mock("./nav", async () => {
  const { createSignal } = await import("solid-js");
  const [open, setOpen] = createSignal(false);
  h.npOpen = open;
  h.setNpOpen = setOpen;
  return {
    baseRoute: () => ({ path: "/home", param: null }),
    bootRoute: vi.fn(),
    isNpOpen: () => open(),
    rememberScroll: vi.fn(),
    restoreScroll: vi.fn(() => () => {}),
    savedScroll: () => null,
  };
});
vi.mock("./store", () => ({ bootStore: vi.fn(), current: () => null, pb: { isPlaying: false } }));
vi.mock("./components/Dock", () => ({ Dock: () => <nav class="dock-stub" /> }));
vi.mock("./components/NowPlaying", () => ({ NowPlaying: () => <div class="np-stub" /> }));
vi.mock("./components/Sheet", () => ({ Sheet: () => null }));
vi.mock("./components/ui", () => ({ Toast: () => null }));
vi.mock("./sheet", () => ({ initSheetHistory: vi.fn() }));
vi.mock("./screens/Home", () => ({ Home: () => <div class="home-stub" /> }));
vi.mock("./adaptiveColor", () => ({ applyAdaptiveColor: vi.fn() }));
vi.mock("./bg/beatSetting", () => ({ applyBeatMode: vi.fn() }));
vi.mock("./bg/spectrum", () => ({ mockFft: () => () => {}, mountSpectrum: () => () => {}, pushFft: vi.fn() }));
vi.mock("./bg/engine", () => ({ is2dActive: () => true }));
vi.mock("./ipc", () => ({ onFft: vi.fn(async () => () => {}) }));
vi.mock("./updater", () => ({ bootUpdater: vi.fn() }));

import { MobileApp } from "./MobileApp";

afterEach(() => {
  cleanup();
  h.setNpOpen?.(false);
});

describe("MobileApp: shell atrás do Now Playing", () => {
  it("NP fechado: o shell é navegável", () => {
    const { container } = render(() => <MobileApp />);
    const shell = container.querySelector<HTMLElement>(".shell")!;
    expect(shell.inert).toBeFalsy();
    expect(shell.getAttribute("aria-hidden")).toBeNull();
  });

  it("NP aberto: o shell (tela + dock) fica inerte e fora da árvore", () => {
    const { container } = render(() => <MobileApp />);
    h.setNpOpen!(true);
    const shell = container.querySelector<HTMLElement>(".shell")!;
    expect(shell.inert).toBe(true);
    expect(shell.getAttribute("aria-hidden")).toBe("true");
    // O NP em si continua fora do shell, então segue acessível.
    expect(shell.contains(container.querySelector(".np-stub"))).toBe(false);

    h.setNpOpen!(false);
    expect(shell.inert).toBeFalsy();
    expect(shell.getAttribute("aria-hidden")).toBeNull();
  });
});
