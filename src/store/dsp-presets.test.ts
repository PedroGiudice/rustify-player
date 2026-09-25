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

import { dsp, resetToFlat, resetToDefault } from "./dsp";
import {
  FLAT_PRESET,
  DEFAULT_PRESET,
  resolveActivePreset,
  presetNameError,
  importPresetName,
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

describe("presets embutidos Flat e Padrão (estsig-5)", () => {
  test("resetToFlat zera o ganho de todas as bandas", () => {
    resetToDefault();
    expect(dsp.eq.bands.some((b) => b.gain_db !== 0)).toBe(true); // Padrão é colorido
    resetToFlat();
    expect(dsp.eq.bands.every((b) => b.gain_db === 0)).toBe(true);
    expect(dsp.eq.bands.every((b) => b.type === 1 && !b.solo && !b.mute)).toBe(true);
    expect(dsp.eq.input_gain).toBe(0);
    expect(dsp.eq.output_gain).toBe(0);
  });

  test("resetToDefault aplica a curva padrão (antiga 'Flat')", () => {
    resetToFlat();
    resetToDefault();
    expect(dsp.eq.bands[2].gain_db).toBe(1.5);
    expect(dsp.eq.bands[4].gain_db).toBe(-2.5);
  });

  test("resolveActivePreset não marca Flat quando a curva não é plana", () => {
    resetToDefault();
    expect(resolveActivePreset(FLAT_PRESET, dsp.eq.bands)).toBe(DEFAULT_PRESET);
    expect(resolveActivePreset("", dsp.eq.bands)).toBe(DEFAULT_PRESET);
    resetToFlat();
    expect(resolveActivePreset(FLAT_PRESET, dsp.eq.bands)).toBe(FLAT_PRESET);
    expect(resolveActivePreset("", dsp.eq.bands)).toBe(FLAT_PRESET);
    expect(resolveActivePreset("Aki", dsp.eq.bands)).toBe("Aki");
    const custom = dsp.eq.bands.map((b, i) => (i === 0 ? { ...b, gain_db: 5 } : b));
    expect(resolveActivePreset(FLAT_PRESET, custom)).toBe("");
  });
});

describe("validação de nome de preset (motor-v5)", () => {
  test("nome de preset embutido é recusado", () => {
    expect(presetNameError("Flat", [])).toMatch(/embutido/);
    expect(presetNameError(" Padrão ", [])).toMatch(/embutido/);
    expect(presetNameError("Meu", [])).toBeNull();
  });

  test("nome vazio é recusado", () => {
    expect(presetNameError("   ", [])).toMatch(/vazio/);
  });

  test("renomear para um nome que já existe é recusado", () => {
    expect(presetNameError("Aki", ["Aki", "Rock"], "Rock")).toMatch(/Já existe/);
    expect(presetNameError("Rock", ["Aki", "Rock"], "Rock")).toBeNull();
  });

  test("import com nome embutido ganha sufixo", () => {
    expect(importPresetName("Flat")).toBe("Flat (importado)");
    expect(importPresetName("Padrão")).toBe("Padrão (importado)");
    expect(importPresetName("Rock")).toBe("Rock");
  });
});
