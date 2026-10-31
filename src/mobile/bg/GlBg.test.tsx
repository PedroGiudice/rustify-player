/* ============================================================
   GlBg.test.tsx — o que o fundo WebGL do S24 entrega ao host.

   - A53: "Remover animações" acalma o fundo (cfg calmo, calm e
     reduced), como no desktop;
   - A55: o modo segue o Now Playing (ambient desfocado NA GPU), e o
     wrapper leva data-engine="webgl" para o filter CSS do 2D não valer.
   ============================================================ */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@solidjs/testing-library";
import type { GlHostOptions } from "../../gl/host";

const h = vi.hoisted(() => ({
  opts: null as GlHostOptions | null,
  stop: vi.fn(),
  npOpen: false,
}));

vi.mock("../../gl/host", () => ({
  startGlHost: (o: GlHostOptions) => {
    h.opts = o;
    return h.stop;
  },
}));

vi.mock("../nav", () => ({ isNpOpen: () => h.npOpen }));

import { GlBg } from "./GlBg";
import { setReducedMotion } from "../motion";
import { CALM_SPEED } from "../../gl/signal";

function mount() {
  return render(() => (
    <div class="app-bg">
      <GlBg />
    </div>
  ));
}

afterEach(() => {
  cleanup();
  setReducedMotion(false);
  h.opts = null;
  h.npOpen = false;
  vi.clearAllMocks();
});

describe("GlBg — reduzir animação (A53)", () => {
  it("sem a preferência: cfg cheio, nada calmo", () => {
    mount();
    const o = h.opts!;
    o.palette();
    expect(o.cfg().speed).toBe(1);
    expect(o.cfg().beatMode).not.toBe("off");
    expect(o.calm?.()).toBe(false);
    expect(o.reduced?.()).toBe(false);
  });

  it("com a preferência: relógio a CALM_SPEED, sem batida, calm e reduced", () => {
    mount();
    const o = h.opts!;
    setReducedMotion(true);
    o.palette(); // a cfg é reamostrada junto da paleta (~3 Hz)
    expect(o.cfg().speed).toBeCloseTo(CALM_SPEED);
    expect(o.cfg().beatMode).toBe("off");
    expect(o.calm?.()).toBe(true);
    expect(o.reduced?.()).toBe(true);
  });
});

describe("GlBg — ambient na GPU (A55)", () => {
  it("modo acompanha o Now Playing", () => {
    mount();
    const o = h.opts!;
    expect(o.mode?.()).toBe("ambient");
    h.npOpen = true;
    expect(o.mode?.()).toBe("focused");
  });

  it("marca o wrapper com data-engine=webgl e tira no desmonte", () => {
    const r = mount();
    const wrap = r.container.querySelector(".app-bg")!;
    expect(wrap.getAttribute("data-engine")).toBe("webgl");
    cleanup();
    expect(wrap.hasAttribute("data-engine")).toBe(false);
    expect(h.stop).toHaveBeenCalled();
  });

  it("o ganho do ambient mistura com a base do S24, não com o preto", () => {
    mount();
    document.documentElement.style.setProperty("--s-base", "#0c0c0c");
    const p = h.opts!.palette();
    expect(p.back).toEqual({ r: 12, g: 12, b: 12 });
    document.documentElement.style.removeProperty("--s-base");
  });
});
