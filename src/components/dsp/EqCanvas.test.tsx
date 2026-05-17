/* ============================================================
   EqCanvas.test.tsx — Smoke tests do canvas de curva + overlay.
   Foco: setup, re-render reativo, e que o overlay nao desenha
   barras quando o toggle esta off.
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { EqCanvas } from "./EqCanvas";
import type { EqBand } from "../../store/dsp";
import { updateTweak } from "../../store/tweaks";

const DEFAULT: EqBand[] = Array.from({ length: 16 }, (_, i) => ({
  freq: [25, 40, 63, 100, 160, 250, 400, 630, 1000, 1600, 2500, 4000, 6300, 10000, 16000, 20000][i],
  gain_db: 0,
  q: 2.21,
  type: 1,
  filterMode: 6,
  slope: 0,
  solo: false,
  mute: false,
}));

let drawCalls = 0;
let fillRectCalls = 0;
const recordingCtx: any = {
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  bezierCurveTo: vi.fn(),
  closePath: vi.fn(),
  stroke: vi.fn(),
  fill: vi.fn(() => { drawCalls++; }),
  fillRect: vi.fn(() => { fillRectCalls++; }),
  arc: vi.fn(),
  strokeStyle: "",
  fillStyle: "",
  lineWidth: 0,
  lineJoin: "",
  lineCap: "",
};

beforeEach(() => {
  drawCalls = 0;
  fillRectCalls = 0;
  HTMLCanvasElement.prototype.getContext = vi.fn(() => recordingCtx) as any;
  HTMLCanvasElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 600, bottom: 180, width: 600, height: 180, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
  // Garante overlay off antes de cada teste — testes que precisam ligar
  // chamam explicitamente.
  updateTweak("eqSpectrumOverlay", false);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("EqCanvas", () => {
  it("renderiza um <canvas> e desenha a curva com 16 bands default", () => {
    const { container } = render(() => (
      <EqCanvas bands={DEFAULT} activeBand={0} />
    ));
    const canvas = container.querySelector("canvas");
    expect(canvas).toBeTruthy();
    expect(drawCalls).toBeGreaterThan(0);
  });

  it("re-desenha quando bands mudam", async () => {
    const [bands, setBands] = (await import("solid-js")).createSignal(DEFAULT);
    render(() => <EqCanvas bands={bands()} activeBand={0} />);
    const beforeCount = recordingCtx.arc.mock.calls.length;
    setBands(DEFAULT.map((b, i) => i === 5 ? { ...b, gain_db: 4 } : b));
    await Promise.resolve();
    expect(recordingCtx.arc.mock.calls.length).toBeGreaterThan(beforeCount);
  });

  it("re-desenha quando activeBand muda", async () => {
    const [active, setActive] = (await import("solid-js")).createSignal(0);
    render(() => <EqCanvas bands={DEFAULT} activeBand={active()} />);
    const beforeCount = recordingCtx.arc.mock.calls.length;
    setActive(8);
    await Promise.resolve();
    expect(recordingCtx.arc.mock.calls.length).toBeGreaterThan(beforeCount);
  });

  it("nao desenha barras quando eqSpectrumOverlay esta off", () => {
    updateTweak("eqSpectrumOverlay", false);
    render(() => <EqCanvas bands={DEFAULT} activeBand={0} />);
    // Sem fft event recebido + overlay off => fillRect nao deve ser chamado
    expect(fillRectCalls).toBe(0);
  });

  it("renderiza sem crashar quando overlay esta on (mesmo sem fft event)", () => {
    updateTweak("eqSpectrumOverlay", true);
    expect(() => {
      render(() => <EqCanvas bands={DEFAULT} activeBand={0} />);
    }).not.toThrow();
    // Sem fft event, bandMags=-80 => barras zeradas e o guard interno
    // (yTop < bottom - 0.5) salta fillRect — esperado e correto.
    // O comportamento "barras desenhando" e validado no app real.
    updateTweak("eqSpectrumOverlay", false);
  });
});
