/* ============================================================
   StationViz.test.tsx — Smoke tests do canvas de stations.
   Cobre setup do canvas + cleanup do RAF.
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { StationViz } from "./StationViz";

let rafIds = 0;
let cancelCalled = 0;
const ctxRecorder: any = {
  setTransform: vi.fn(),
  clearRect: vi.fn(),
  fillRect: vi.fn(),
  beginPath: vi.fn(),
  moveTo: vi.fn(),
  lineTo: vi.fn(),
  stroke: vi.fn(),
  fill: vi.fn(),
  arc: vi.fn(),
  strokeStyle: "",
  fillStyle: "",
  lineWidth: 0,
};

beforeEach(() => {
  rafIds = 0;
  cancelCalled = 0;
  HTMLCanvasElement.prototype.getContext = vi.fn(() => ctxRecorder) as any;
  HTMLCanvasElement.prototype.getBoundingClientRect = function () {
    return { left: 0, top: 0, right: 480, bottom: 320, width: 480, height: 320, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  };
  (globalThis as any).requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
    rafIds += 1;
    // nao executa cb pra evitar loop infinito em testes; o primeiro draw ja roda em onMount
    return rafIds;
  });
  (globalThis as any).cancelAnimationFrame = vi.fn(() => { cancelCalled += 1; });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("StationViz", () => {
  it("monta um <canvas> dentro do wrapper", () => {
    const { container } = render(() => <StationViz />);
    expect(container.querySelector("canvas")).toBeTruthy();
  });

  it("dispara primeiro draw em onMount", () => {
    render(() => <StationViz />);
    // draw chama clearRect ao menos uma vez
    expect(ctxRecorder.clearRect).toHaveBeenCalled();
  });

  it("registra requestAnimationFrame para o loop", () => {
    render(() => <StationViz />);
    expect((globalThis as any).requestAnimationFrame).toHaveBeenCalled();
  });

  it("cancela o RAF no cleanup", () => {
    const { unmount } = render(() => <StationViz />);
    unmount();
    expect(cancelCalled).toBeGreaterThan(0);
  });

  it("aceita props seedCount/genCount", () => {
    const { container } = render(() => <StationViz seedCount={5} genCount={40} />);
    expect(container.querySelector("canvas")).toBeTruthy();
  });

  it("re-deriva seeds/generated quando props mudam pos-mount", () => {
    // Captura o callback do RAF pra rodar frames manualmente.
    let lastCb: FrameRequestCallback | null = null;
    (globalThis as any).requestAnimationFrame = vi.fn((cb: FrameRequestCallback) => {
      lastCb = cb;
      rafIds += 1;
      return rafIds;
    });
    const [gen, setGen] = createSignal(10);
    render(() => <StationViz seedCount={3} genCount={gen()} />);

    // Por frame: 1 arc por generated dot + 2 arcs por seed (halo + core).
    ctxRecorder.arc.mockClear();
    lastCb!(0);
    expect(ctxRecorder.arc).toHaveBeenCalledTimes(10 + 3 * 2);

    // Mudar genCount pos-mount precisa refletir no proximo frame — antes
    // era snapshot congelado no corpo do componente.
    setGen(20);
    ctxRecorder.arc.mockClear();
    lastCb!(0);
    expect(ctxRecorder.arc).toHaveBeenCalledTimes(20 + 3 * 2);
  });
});
