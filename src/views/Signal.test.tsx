/* ============================================================
   Signal.test.tsx — Smoke tests do view portado pra Solid.
   Cobre render dos 3 paineis, toggle bypass, activeBand muda
   ao clicar fader, presets embutidos e validação de nomes.
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
import { dsp, setBassFreq, setBassFloor } from "../store/dsp";
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
  it("renderiza os 3 paineis reais (EQ, Limiter, Bass) e barras top", () => {
    const { container, getByText } = render(() => <Signal />);
    expect(getByText("Signal")).toBeTruthy();
    expect(container.querySelector(".sig-master-bar")).toBeTruthy();
    expect(container.querySelector(".sig-stat-row")).toBeTruthy();
    expect(container.querySelector(".sig-chain")).toBeTruthy();
    expect(container.querySelector(".sig-presets")).toBeTruthy();
    const panels = container.querySelectorAll(".sig-panel");
    expect(panels.length).toBe(3);
  });

  it("não simula estágios inexistentes: sem painel Roadmap (estsig-14)", () => {
    const { container } = render(() => <Signal />);
    expect(container.querySelector(".plug-card")).toBeNull();
    expect(container.textContent).not.toContain("Roadmap");
    expect(container.textContent).not.toContain("in chain");
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

  it("toggle master tem a mesma polaridade dos estágios: ligado = processando (estsig-6)", () => {
    const { container } = render(() => <Signal />);
    const master = container.querySelector<HTMLButtonElement>(".sig-master-bar .tog")!;
    expect(dsp.bypass).toBe(false);
    expect(master.getAttribute("aria-pressed")).toBe("true");
    master.click();
    expect(dsp.bypass).toBe(true);
    expect(master.getAttribute("aria-pressed")).toBe("false");
    master.click();
  });

  it("bypass e estágio desligado aparecem nos painéis e nos tiles (estsig-6)", () => {
    const { container } = render(() => <Signal />);
    const master = container.querySelector<HTMLButtonElement>(".sig-master-bar .tog")!;
    const panels = () => Array.from(container.querySelectorAll<HTMLElement>(".sig-panel"));
    // Limiter e Bass começam desligados no default; EQ ligado.
    const [eq, lim, bass] = panels();
    expect(eq.dataset.live).toBe("true");
    expect(lim.dataset.live).toBe("false");
    expect(lim.querySelector(".sig-panel__state")?.textContent).toBe("off");
    expect(bass.dataset.live).toBe("false");

    master.click(); // bypass
    for (const p of panels()) {
      expect(p.dataset.live).toBe("false");
      expect(p.querySelector(".sig-panel__state")?.textContent).toBe("bypassed");
    }
    const eqTile = container.querySelector<HTMLElement>(".sig-stat")!;
    expect(eqTile.querySelector(".sig-stat__value")?.textContent).toBe("bypassed");
    master.click();
  });

  it("bypass não desliga a normalização na tela, porque não desliga no backend (motor-v2)", () => {
    const { container } = render(() => <Signal />);
    const master = container.querySelector<HTMLButtonElement>(".sig-master-bar .tog")!;
    const normTile = () =>
      Array.from(container.querySelectorAll<HTMLElement>(".sig-stat")).find((t) =>
        t.textContent?.includes("Normalize"),
      )!;
    const normOn = normTile().dataset.on;
    master.click(); // bypass
    expect(normTile().dataset.on).toBe(normOn);
    const normNode = Array.from(container.querySelectorAll<HTMLElement>(".sig-chain__node")).find((n) =>
      n.textContent?.includes("norm_gain"),
    )!;
    expect(normNode.dataset.on).toBe(normOn);
    expect(container.querySelector(".sig-master-bar")!.textContent).not.toMatch(/entire chain/i);
    master.click();
  });

  it("Scope e Floor do Bass aparecem formatados no tile e no cabeçalho (motor-v3)", () => {
    // Valor cru que o ParamRow antigo gravava no store (e que segue
    // persistido em localStorage de quem já arrastou).
    setBassFreq(137.46376811594203);
    setBassFloor(33.3333333);
    const { container } = render(() => <Signal />);
    const text = container.textContent ?? "";
    expect(text).toContain("scope 137 Hz · floor 33 Hz");
    expect(text).not.toMatch(/137\.46/);
    setBassFreq(120);
    setBassFloor(20);
  });

  it("click em fader atualiza activeBand do store", () => {
    const { container } = render(() => <Signal />);
    const faders = container.querySelectorAll<HTMLElement>(".fader");
    faders[5].click();
    expect(dsp.activeBand).toBe(5);
  });

  it("chip Flat zera o EQ e o chip Padrão aplica a curva default (estsig-5)", () => {
    const { getByText } = render(() => <Signal />);
    getByText("Padrão").click();
    expect(dsp.eq.bands.some((b) => b.gain_db !== 0)).toBe(true);
    getByText("Flat").click();
    expect(dsp.eq.bands.every((b) => b.gain_db === 0)).toBe(true);
  });

  it("salvar com nome de preset embutido é recusado (motor-v5)", () => {
    localStorage.removeItem("rustify-dsp-presets");
    vi.spyOn(window, "prompt").mockReturnValue("Flat");
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    const { getByText } = render(() => <Signal />);
    getByText("Save").click();
    expect(alertSpy).toHaveBeenCalled();
    expect(localStorage.getItem("rustify-dsp-presets")).toBeNull();
  });

  it("renomear para um nome que já existe é recusado (motor-v5)", () => {
    localStorage.removeItem("rustify-dsp-presets");
    const promptSpy = vi.spyOn(window, "prompt");
    vi.spyOn(window, "alert").mockImplementation(() => {});
    const { getByText, container } = render(() => <Signal />);
    promptSpy.mockReturnValueOnce("Aki");
    getByText("Save").click();
    promptSpy.mockReturnValueOnce("Rock");
    getByText("Save").click();
    // "Rock" ativo; renomear para "Aki" colidiria.
    promptSpy.mockReturnValueOnce("Aki");
    getByText("Rename").click();
    const names = Array.from(container.querySelectorAll(".sig-pre")).map((b) => b.textContent);
    expect(names.filter((n) => n === "Aki").length).toBe(1);
    expect(names).toContain("Rock");
    localStorage.removeItem("rustify-dsp-presets");
  });

});
