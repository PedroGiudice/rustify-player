/* ============================================================
   LevelMeter.test.tsx — medidor L/R da barra (A24, 31/10).
   - Sem faixa, o medidor some mas guarda o lugar (40 px).
   - O DOM só é escrito quando a fração quantizada (1/80) ou o clip
     mudam: a balística roda a 60 quadros por segundo, o estilo não.
   - Clip marca o canal inteiro (o trilho tinge enquanto o pico dura).
   ============================================================ */

import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import type { MeterState } from "../lib/meter";

const h = vi.hoisted(() => ({ cb: null as null | ((m: MeterState) => void) }));
vi.mock("../lib/levels", () => ({
  subscribeLevels: (cb: (m: MeterState) => void) => { h.cb = cb; return () => { h.cb = null; }; },
}));

import { LevelMeter } from "./LevelMeter";
import { quantFrac } from "../lib/meter";
import { setPlayer } from "../store/player";
import type { Track } from "../tauri";

const TRACK = { id: "m1", title: "x", path: "/x" } as Track;
const state = (vu: number, peakDb: number): MeterState =>
  ({ vu: [vu, vu], peakDb: [peakDb, peakDb], hold: [0, 0] });

beforeEach(() => {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {} })) as never;
});
afterEach(() => {
  cleanup();
  setPlayer({ currentTrack: null, isPlaying: false });
});

describe("quantFrac", () => {
  it("arredonda para 1/80 e prende em 0..1", () => {
    expect(quantFrac(0.5)).toBe(0.5);
    expect(quantFrac(0.506)).toBe(0.5);
    expect(quantFrac(0.507)).toBeCloseTo(41 / 80);
    expect(quantFrac(-1)).toBe(0);
    expect(quantFrac(2)).toBe(1);
  });
});

describe("LevelMeter", () => {
  it("sem faixa fica oculto, guardando o lugar", () => {
    const { container } = render(() => <LevelMeter />);
    const root = container.querySelector(".pb-meter")!;
    expect(root.getAttribute("data-empty")).toBe("true");
    setPlayer({ currentTrack: TRACK });
    expect(root.getAttribute("data-empty")).toBeNull();
  });

  it("só reescreve o estilo quando a fração quantizada muda", () => {
    setPlayer({ currentTrack: TRACK, isPlaying: true });
    const { container } = render(() => <LevelMeter />);
    const fill = container.querySelector(".pb-meter__fill") as HTMLElement;
    h.cb!(state(0.5, -6));
    const first = fill.style.transform;
    expect(first).toMatch(/^scaleX\(/);
    fill.style.transform = "scaleX(0.123)";
    h.cb!(state(0.5001, -6));
    expect(fill.style.transform).toBe("scaleX(0.123)");
    h.cb!(state(0.05, -6));
    expect(fill.style.transform).not.toBe("scaleX(0.123)");
  });

  it("clip marca o canal enquanto o pico retido está acima do limite", () => {
    setPlayer({ currentTrack: TRACK, isPlaying: true });
    const { container } = render(() => <LevelMeter />);
    const ch = container.querySelector(".pb-meter__ch") as HTMLElement;
    h.cb!(state(0.9, -0.1));
    expect(ch.dataset.clip).toBe("true");
    h.cb!(state(0.5, -6));
    expect(ch.dataset.clip).toBe("false");
  });
});
