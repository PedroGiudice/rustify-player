/* ============================================================
   EqCanvas.test.tsx — Smoke tests do canvas de curva.
   Foco: setup correto e re-render reativo. Visual validado
   manualmente.
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { EqCanvas } from "./EqCanvas";
import type { EqBand } from "../../store/dsp";

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
  arc: vi.fn(),
  strokeStyle: "",
  fillStyle: "",
  lineWidth: 0,
  lineJoin: "",
  lineCap: "",
};

beforeEach(() => {
  drawCalls = 0;
  HTMLCanvasElement.prototype.getContext = vi.fn(() => recordingCtx) as any;
  HTMLCanvasElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 600, bottom: 180, width: 600, height: 180, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  (globalThis as any).ResizeObserver = class { observe() {} disconnect() {} };
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
    // draw chamou fill (carbon fill) pelo menos uma vez
    expect(drawCalls).toBeGreaterThan(0);
  });

  it("re-desenha quando bands mudam", async () => {
    const [bands, setBands] = (await import("solid-js")).createSignal(DEFAULT);
    render(() => <EqCanvas bands={bands()} activeBand={0} />);
    const beforeCount = recordingCtx.arc.mock.calls.length;
    setBands(DEFAULT.map((b, i) => i === 5 ? { ...b, gain_db: 4 } : b));
    // micro-task tick para createEffect rodar
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
});
