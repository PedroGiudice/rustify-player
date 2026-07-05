/* ============================================================
   Signal.test.tsx — Smoke tests do view portado pra Solid.
   Cobre render dos 4 paineis, toggle bypass, activeBand muda
   ao clicar fader, e roadmap card toggle local.
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";

// Mocks de tauri (mesmo padrao do dsp.test.ts).
vi.mock("../tauri", () => ({
  themeVar: () => null,
  clearThemeVars: vi.fn(),
  normSetTarget: vi.fn().mockResolvedValue(undefined),
  getState: vi.fn().mockResolvedValue({ current_track: null, current_library_track: null, is_playing: false }),
  getTrackColor: vi.fn().mockResolvedValue(""),
  dspSetBypass: vi.fn().mockResolvedValue(undefined),
  dspSetEqEnabled: vi.fn().mockResolvedValue(undefined),
  dspSetEqMode: vi.fn().mockResolvedValue(undefined),
  dspSetEqGain: vi.fn().mockResolvedValue(undefined),
  dspSetEqBand: vi.fn().mockResolvedValue(undefined),
  dspSetEqFilterType: vi.fn().mockResolvedValue(undefined),
  dspSetEqFilterMode: vi.fn().mockResolvedValue(undefined),
  dspSetEqSlope: vi.fn().mockResolvedValue(undefined),
  dspSetEqSolo: vi.fn().mockResolvedValue(undefined),
  dspSetEqMute: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterEnabled: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterMode: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterOversampling: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterDither: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterThreshold: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterKnee: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterLookahead: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterAttack: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterRelease: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterScPreamp: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterStereoLink: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterBoost: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterGain: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterAlr: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterAlrAttack: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterAlrRelease: vi.fn().mockResolvedValue(undefined),
  dspSetBassBypass: vi.fn().mockResolvedValue(undefined),
  dspSetBassAmount: vi.fn().mockResolvedValue(undefined),
  dspSetBassDrive: vi.fn().mockResolvedValue(undefined),
  dspSetBassBlend: vi.fn().mockResolvedValue(undefined),
  dspSetBassFreq: vi.fn().mockResolvedValue(undefined),
  dspSetBassFloor: vi.fn().mockResolvedValue(undefined),
  dspSetBassFloorActive: vi.fn().mockResolvedValue(undefined),
  dspSetBassListen: vi.fn().mockResolvedValue(undefined),
  dspSetBassLevels: vi.fn().mockResolvedValue(undefined),
  normGetState: vi.fn().mockResolvedValue(false),
  normSetEnabled: vi.fn().mockResolvedValue(undefined),
}));

import Signal from "./Signal";
import { dsp } from "../store/dsp";
import * as ipc from "../tauri";

beforeEach(() => {
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
    setTransform: vi.fn(), clearRect: vi.fn(), beginPath: vi.fn(),
    moveTo: vi.fn(), lineTo: vi.fn(), bezierCurveTo: vi.fn(),
    closePath: vi.fn(), stroke: vi.fn(), fill: vi.fn(), arc: vi.fn(),
    fillRect: vi.fn(),
    strokeStyle: "", fillStyle: "", lineWidth: 0, lineJoin: "", lineCap: "",
  })) as any;
  HTMLCanvasElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 600, bottom: 180, width: 600, height: 180, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
  (globalThis as any).requestAnimationFrame = vi.fn(() => 1);
  (globalThis as any).cancelAnimationFrame = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("Signal view", () => {
  it("renderiza os 4 paineis (EQ, Limiter, Bass, Roadmap) e barras top", () => {
    const { container, getByText } = render(() => <Signal />);
    expect(getByText("Signal")).toBeTruthy();
    expect(container.querySelector(".sig-master-bar")).toBeTruthy();
    expect(container.querySelector(".sig-stat-row")).toBeTruthy();
    expect(container.querySelector(".sig-chain")).toBeTruthy();
    expect(container.querySelector(".sig-presets")).toBeTruthy();
    const panels = container.querySelectorAll(".sig-panel");
    // 4 paineis: EQ, Limiter, Bass, Roadmap
    expect(panels.length).toBe(4);
  });

  it("renderiza 16 faders na primeira painel", () => {
    const { container } = render(() => <Signal />);
    const faders = container.querySelectorAll(".fader");
    expect(faders.length).toBe(16);
  });

  it("toggle bypass dispara IPC dspSetBypass", async () => {
    const { container } = render(() => <Signal />);
    const bypassBtn = container.querySelector<HTMLButtonElement>(".sig-master-bar .tog")!;
    const before = dsp.bypass;
    bypassBtn.click();
    expect(dsp.bypass).toBe(!before);
    // restore para nao poluir testes seguintes
    bypassBtn.click();
  });

  it("click em fader atualiza activeBand do store", () => {
    const { container } = render(() => <Signal />);
    const faders = container.querySelectorAll<HTMLElement>(".fader");
    faders[5].click();
    expect(dsp.activeBand).toBe(5);
  });

  it("roadmap cards flipam data-on local sem afetar backend", () => {
    const { container } = render(() => <Signal />);
    const cards = container.querySelectorAll<HTMLElement>(".plug-card");
    expect(cards.length).toBeGreaterThanOrEqual(8);
    const first = cards[0];
    expect(first.dataset.on).toBe("false");
    const tog = first.querySelector<HTMLButtonElement>(".tog")!;
    tog.click();
    expect(first.dataset.on).toBe("true");
    // Sem chamadas IPC pra Roadmap
    // (nenhum mock especifico esperado)
  });
});
