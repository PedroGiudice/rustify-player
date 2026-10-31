/* ============================================================
   dsp.test.ts — Smoke tests para os setters de DSP.
   Cobertura: 1 setter representativo por categoria (EQ, Limiter,
   Bass). Os outros setters da mesma categoria sao copias do mesmo
   padrao; um falhando indica que o padrao quebrou, logo todos
   precisariam ser reescritos.
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock do modulo tauri ANTES de importar o store, porque o store
// importa ipc no top-level e o vi.mock e hoisted.
vi.mock("../tauri", () => ({
  themeVar: () => null,
  clearThemeVars: vi.fn(),
  dspSetEqSlope: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterThreshold: vi.fn().mockResolvedValue(undefined),
  dspSetBassAmount: vi.fn().mockResolvedValue(undefined),
  // Stubs adicionais que o store importa mas nao usamos diretamente
  // nos testes — applyFullDspState e setters existentes os chamam.
  dspSetBypass: vi.fn().mockResolvedValue(undefined),
  dspSetEqEnabled: vi.fn().mockResolvedValue(undefined),
  dspSetEqMode: vi.fn().mockResolvedValue(undefined),
  dspSetEqGain: vi.fn().mockResolvedValue(undefined),
  dspSetEqBand: vi.fn().mockResolvedValue(undefined),
  dspSetEqFilterType: vi.fn().mockResolvedValue(undefined),
  dspSetEqFilterMode: vi.fn().mockResolvedValue(undefined),
  dspSetEqSolo: vi.fn().mockResolvedValue(undefined),
  dspSetEqMute: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterEnabled: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterMode: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterOversampling: vi.fn().mockResolvedValue(undefined),
  dspSetLimiterDither: vi.fn().mockResolvedValue(undefined),
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
  dspSetBassDrive: vi.fn().mockResolvedValue(undefined),
  dspSetBassBlend: vi.fn().mockResolvedValue(undefined),
  dspSetBassFreq: vi.fn().mockResolvedValue(undefined),
  dspSetBassFloor: vi.fn().mockResolvedValue(undefined),
  dspSetBassFloorActive: vi.fn().mockResolvedValue(undefined),
  dspSetBassListen: vi.fn().mockResolvedValue(undefined),
  dspSetBassLevels: vi.fn().mockResolvedValue(undefined),
}));

import * as ipc from "../tauri";
import {
  dsp,
  setEqBandSlope,
  setLimiterThreshold,
  setBassAmount,
  dspError,
  clearDspError,
  applyFullDspState,
  reapplyDsp,
} from "./dsp";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("dsp setters — smoke", () => {
  it("setEqBandSlope updates store and debounces IPC call", () => {
    setEqBandSlope(3, 2);
    // Store atualizado imediatamente
    expect(dsp.eq.bands[3].slope).toBe(2);
    // IPC ainda nao disparado (debounce de 100ms)
    expect(ipc.dspSetEqSlope).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(ipc.dspSetEqSlope).toHaveBeenCalledWith(3, 2);
  });

  it("setLimiterThreshold updates store and debounces IPC call", () => {
    setLimiterThreshold(-12);
    expect(dsp.limiter.threshold).toBe(-12);
    expect(ipc.dspSetLimiterThreshold).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(ipc.dspSetLimiterThreshold).toHaveBeenCalledWith(-12);
  });

  it("setBassAmount updates store and debounces IPC call", () => {
    setBassAmount(0.42);
    expect(dsp.bass.amount).toBeCloseTo(0.42);
    expect(ipc.dspSetBassAmount).not.toHaveBeenCalled();
    vi.advanceTimersByTime(50);
    expect(ipc.dspSetBassAmount).toHaveBeenCalledWith(0.42);
  });
});

/* A32: ajuste recusado parecia aplicado (o erro ia só para o console) e,
   na restauração, a primeira falha abortava os ~40 comandos seguintes. */
describe("dsp: recusa do motor", () => {
  afterEach(() => clearDspError());

  it("setter recusado acende dspError", async () => {
    vi.mocked(ipc.dspSetLimiterThreshold).mockRejectedValueOnce(new Error("engine down"));
    setLimiterThreshold(-9);
    vi.advanceTimersByTime(50);
    vi.useRealTimers();
    await vi.waitFor(() => expect(dspError()).not.toBeNull());
  });

  it("restauração segue depois de uma falha e conta as recusas", async () => {
    vi.useRealTimers();
    vi.mocked(ipc.dspSetBypass).mockRejectedValueOnce(new Error("x"));
    vi.mocked(ipc.dspSetLimiterMode).mockRejectedValueOnce(new Error("y"));
    const failed = await applyFullDspState();
    expect(failed).toBe(2);
    expect(ipc.dspSetEqEnabled).toHaveBeenCalled();
    expect(ipc.dspSetBassLevels).toHaveBeenCalled();
    expect(dspError()).not.toBeNull();
  });

  it("Reaplicar limpa o aviso quando o motor aceita", async () => {
    vi.useRealTimers();
    vi.mocked(ipc.dspSetBypass).mockRejectedValueOnce(new Error("x"));
    await applyFullDspState();
    expect(dspError()).not.toBeNull();
    await reapplyDsp();
    expect(dspError()).toBeNull();
  });
});
