/* ============================================================
   store/dsp-presets.test.ts — smoke tests da camada de CRUD
   de presets + applyPresetToStore. parseEasyEffects/toEasyEffects
   tem cobertura indireta via integration manual.
   ============================================================ */

import { beforeEach, describe, expect, test, vi } from "vitest";

// Mock IPC ANTES de importar o store (vi.mock e hoisted). applyPresetToStore
// chama applyFullDspState que percorre TODOS os ipc.dspSetX — stubamos todos.
vi.mock("../tauri", () => {
  const ipcStubs: Record<string, ReturnType<typeof vi.fn>> = {};
  const names = [
    "dspSetBypass", "dspSetEqEnabled", "dspSetEqMode", "dspSetEqGain", "dspSetEqBand",
    "dspSetEqFilterType", "dspSetEqFilterMode", "dspSetEqSlope", "dspSetEqSolo", "dspSetEqMute",
    "dspSetLimiterEnabled", "dspSetLimiterThreshold", "dspSetLimiterMode", "dspSetLimiterOversampling",
    "dspSetLimiterDither", "dspSetLimiterKnee", "dspSetLimiterLookahead", "dspSetLimiterAttack",
    "dspSetLimiterRelease", "dspSetLimiterScPreamp", "dspSetLimiterStereoLink", "dspSetLimiterBoost",
    "dspSetLimiterGain", "dspSetLimiterAlr", "dspSetLimiterAlrAttack", "dspSetLimiterAlrRelease",
    "dspSetBassBypass", "dspSetBassAmount", "dspSetBassDrive", "dspSetBassBlend", "dspSetBassFreq",
    "dspSetBassFloor", "dspSetBassFloorActive", "dspSetBassListen", "dspSetBassLevels",
    "normGetState", "normSetEnabled",
  ];
  for (const n of names) ipcStubs[n] = vi.fn().mockResolvedValue(undefined);
  return { ...ipcStubs, themeVar: () => null, clearThemeVars: vi.fn() };
});

import { dsp } from "./dsp";
import {
  loadPresets,
  savePresets,
  getActivePresetName,
  setActivePresetName,
  snapshotCurrentDsp,
  applyPresetToStore,
  type DspPreset,
} from "./dsp-presets";

beforeEach(() => {
  localStorage.clear();
});

describe("dsp-presets CRUD", () => {
  test("loadPresets retorna [] quando nada salvo", () => {
    expect(loadPresets()).toEqual([]);
  });

  test("savePresets persiste array; loadPresets le de volta", () => {
    const arr: DspPreset[] = [snapshotCurrentDsp("flat-copy")];
    savePresets(arr);
    const loaded = loadPresets();
    expect(loaded.length).toBe(1);
    expect(loaded[0].name).toBe("flat-copy");
    expect(loaded[0].eq.bands.length).toBe(16);
  });

  test("active preset name round-trip", () => {
    setActivePresetName("Aki");
    expect(getActivePresetName()).toBe("Aki");
  });

  test("applyPresetToStore aplica gains do preset no store", () => {
    const preset: DspPreset = snapshotCurrentDsp("test");
    preset.eq.bands[0].gain_db = 5.5;
    preset.eq.bands[8].gain_db = -3.2;

    applyPresetToStore(preset);

    expect(dsp.eq.bands[0].gain_db).toBe(5.5);
    expect(dsp.eq.bands[8].gain_db).toBe(-3.2);
  });
});
