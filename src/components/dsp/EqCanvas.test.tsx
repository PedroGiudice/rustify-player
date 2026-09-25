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

  it("re-desenha quando o tipo, o slope ou o solo da banda mudam (estsig-4)", async () => {
    // Store como no app (dsp.eq.bands): a mutação é fina, por propriedade.
    const { createStore } = await import("solid-js/store");
    const [store, setStore] = createStore({ bands: DEFAULT.map((b) => ({ ...b })) });
    render(() => <EqCanvas bands={store.bands} activeBand={0} />);
    for (const [key, value] of [["type", 3], ["slope", 2], ["solo", true], ["filterMode", 0]] as const) {
      const before = recordingCtx.arc.mock.calls.length;
      setStore("bands", 4, key, value as never);
      await Promise.resolve();
      expect(recordingCtx.arc.mock.calls.length).toBeGreaterThan(before);
    }
  });

  it("a escala do eixo Y cresce para mostrar ganhos acima de 18 dB (estsig-4)", async () => {
    const [bands, setBands] = (await import("solid-js")).createSignal(DEFAULT);
    const { container } = render(() => <EqCanvas bands={bands()} activeBand={0} />);
    const labels = () => Array.from(container.querySelectorAll(".eq-yaxis span")).map((s) => s.textContent);
    expect(labels()).toEqual(["+18", "+9", "0", "-9", "-18"]);
    setBands(DEFAULT.map((b, i) => (i === 8 ? { ...b, gain_db: 30 } : b)));
    await Promise.resolve();
    expect(labels()).toEqual(["+36", "+18", "0", "-18", "-36"]);
  });

  it("grade horizontal cai nos valores rotulados do eixo Y (estsig-23)", () => {
    recordingCtx.moveTo.mockClear();
    render(() => <EqCanvas bands={DEFAULT} activeBand={0} />);
    // h=180: mid=90, ±R em 90∓81, ±R/2 em 90∓40,5 (+0,5 de hairline).
    const ys = recordingCtx.moveTo.mock.calls.filter((c: number[]) => c[0] === 26).map((c: number[]) => c[1]);
    for (const y of [9.5, 50, 131, 171.5]) expect(ys).toContain(y);
  });

  it("rótulos do eixo X ficam na posição logarítmica real (estsig-23)", () => {
    const { container } = render(() => <EqCanvas bands={DEFAULT} activeBand={0} />);
    const spans = Array.from(container.querySelectorAll<HTMLElement>(".eq-xaxis span"));
    const k1 = spans.find((s) => s.textContent === "1k")!;
    // u(1 kHz) = (3 - log10 20) / 3 = 0.5663
    expect(k1.style.left).toContain("0.5663");
    const k20 = spans.find((s) => s.textContent === "20")!;
    // 20 Hz = u 0: começa no PAD_X do canvas (+1px de borda do wrap).
    // jsdom normaliza o calc() (a ordem dos fatores pode mudar).
    expect(k20.style.left).toMatch(/27px \+ 0 \*|\* 0\)/);
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
