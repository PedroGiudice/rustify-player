/* ============================================================
   store/dsp.ts — Estado do DSP chain (EQ, Limiter, Bass).
   Migra signal.js para store reativo Solid.
   Mantém compatibilidade total com o backend Rust.
   ============================================================ */

import { createStore, produce } from "solid-js/store";
import * as ipc from "../tauri";

// ── Constantes ─────────────────────────────────────────────────

export const FILTER_TYPES = ["Off","Bell","Hi-pass","Hi-shelf","Lo-pass","Lo-shelf","Notch","Resonance","Allpass","Bandpass","Ladder-pass","Ladder-rej"] as const;
export const FILTER_MODES = ["RLC (BT)","RLC (MT)","BWC (BT)","BWC (MT)","LRX (BT)","LRX (MT)","APO (DR)"] as const;
export const SLOPES = ["x1","x2","x3","x4"] as const;
export const LIMITER_MODES = ["Herm Thin","Herm Wide","Herm Tail","Herm Duck","Exp Thin","Exp Wide","Exp Tail","Exp Duck"] as const;
export const LIMITER_OVS = ["None","Half x2/16","Half x2/24","Half x3/16","Half x3/24","Half x4/16","Half x4/24","Half x6/16","Half x6/24","Half x8/16","Half x8/24","Full x2/16","Full x2/24","Full x3/16","Full x3/24","Full x4/16","Full x4/24","Full x6/16","Full x6/24","Full x8/16","Full x8/24"] as const;
export const LIMITER_DITHER = ["None","7bit","8bit","11bit","12bit"] as const;
export const DB_RANGE = 36;

// ── Tipos ──────────────────────────────────────────────────────

export interface EqBand {
  freq: number;
  gain_db: number;
  q: number;
  type: number;
  filterMode: number;
  slope: number;
  solo: boolean;
  mute: boolean;
}

export interface DspStore {
  bypass: boolean;
  activeBand: number;
  eq: {
    enabled: boolean;
    mode: number;
    input_gain: number;
    output_gain: number;
    bands: EqBand[];
  };
  limiter: {
    enabled: boolean;
    mode: number;
    ovs: number;
    dither: number;
    threshold: number;
    knee: number;
    lookahead: number;
    attack: number;
    release: number;
    sc_preamp: number;
    stereo_link: number;
    boost: boolean;
    alr: boolean;
    alr_attack: number;
    alr_release: number;
    input_gain: number;
    output_gain: number;
  };
  bass: {
    enabled: boolean;
    amount: number;
    drive: number;
    blend: number;
    freq: number;
    floor: number;
    floor_active: boolean;
    listen: boolean;
    input_gain: number;
    output_gain: number;
  };
}

// ── Defaults ───────────────────────────────────────────────────

const DEFAULT_BANDS: EqBand[] = [
  { freq: 20,   gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 26,   gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 38,   gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 55,   gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 72,   gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 110,  gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 160,  gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 220,  gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 300,  gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 400,  gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 560,  gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 800,  gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 1100, gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 1600, gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 2300, gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 3300, gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
];

const STATE_KEY = "rustify-dsp-state";

function defaultState(): DspStore {
  return {
    bypass: false,
    activeBand: 0,
    eq: {
      enabled: true,
      mode: 0,
      input_gain: 0,
      output_gain: 0,
      bands: DEFAULT_BANDS.map((b) => ({ ...b })),
    },
    limiter: {
      enabled: false, mode: 0, ovs: 0, dither: 0,
      threshold: -6, knee: 3, lookahead: 5, attack: 5, release: 20,
      sc_preamp: 1, stereo_link: 100, boost: false,
      alr: false, alr_attack: 5, alr_release: 50,
      input_gain: 0, output_gain: 0,
    },
    bass: {
      enabled: false, amount: 0, drive: 1, blend: 0,
      freq: 120, floor: 20, floor_active: true, listen: false,
      input_gain: 0, output_gain: 0,
    },
  };
}

function loadPersistedState(): DspStore {
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY) ?? "null");
    if (!saved) return defaultState();
    const def = defaultState();
    return {
      bypass: saved.bypass ?? def.bypass,
      activeBand: 0,
      eq: {
        ...def.eq, ...saved.eq,
        bands: (saved.eq?.bands ?? def.eq.bands).map((b: EqBand, i: number) => ({
          ...def.eq.bands[i], ...b,
        })),
      },
      limiter: { ...def.limiter, ...saved.limiter },
      bass: { ...def.bass, ...saved.bass },
    };
  } catch {
    return defaultState();
  }
}

// ── Store singleton ────────────────────────────────────────────

export const [dsp, setDsp] = createStore<DspStore>(loadPersistedState());

// ── Persistência ───────────────────────────────────────────────

export function persistDsp() {
  try {
    // Não persistir activeBand — é UI state
    const { activeBand: _, ...toSave } = dsp;
    localStorage.setItem(STATE_KEY, JSON.stringify(toSave));
  } catch {}
}

// ── Debounced IPC ──────────────────────────────────────────────

let _debounceTimer: ReturnType<typeof setTimeout>;
export function ipcDebounced(cmd: () => Promise<void>, delay = 50) {
  clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    cmd().catch(console.error);
    persistDsp();
  }, delay);
}

// ── Apply full state to backend ───────────────────────────────
// Chamado no boot do app (main.tsx) e no mount da view Signal.

export async function applyFullDspState() {
  persistDsp();
  const { eq, limiter, bass, bypass } = dsp;
  try {
    await ipc.dspSetBypass(bypass);
    await ipc.dspSetEqEnabled(eq.enabled);
    await ipc.dspSetEqMode(eq.mode);
    await ipc.dspSetEqGain(eq.input_gain, eq.output_gain);
    for (let i = 0; i < eq.bands.length; i++) {
      const b = eq.bands[i];
      await ipc.dspSetEqBand(i, b.freq, b.gain_db, b.q);
      await ipc.dspSetEqFilterType(i, b.type);
      await ipc.dspSetEqFilterMode(i, b.filterMode).catch(() => {});
      await ipc.dspSetEqSlope(i, b.slope).catch(() => {});
      await ipc.dspSetEqSolo(i, b.solo).catch(() => {});
      await ipc.dspSetEqMute(i, b.mute).catch(() => {});
    }
    await ipc.dspSetLimiterEnabled(limiter.enabled);
    await ipc.dspSetLimiterThreshold(limiter.threshold);
    await ipc.dspSetBassBypass(!bass.enabled);
    await ipc.dspSetBassAmount(bass.amount);
  } catch (e) {
    console.error("[dsp] apply state failed:", e);
  }
}

// ── Mutações de EQ ────────────────────────────────────────────

export function setEqBandGain(bandIdx: number, gainDb: number) {
  setDsp("eq", "bands", bandIdx, "gain_db", gainDb);
  ipcDebounced(() => ipc.dspSetEqBand(bandIdx, dsp.eq.bands[bandIdx].freq, gainDb, dsp.eq.bands[bandIdx].q));
}

export function setEqBandType(bandIdx: number, type: number) {
  setDsp("eq", "bands", bandIdx, "type", type);
  ipcDebounced(() => ipc.dspSetEqFilterType(bandIdx, type));
}

export function setEqBandMode(bandIdx: number, mode: number) {
  setDsp("eq", "bands", bandIdx, "filterMode", mode);
  ipcDebounced(() => ipc.dspSetEqFilterMode(bandIdx, mode));
}

export function setActiveBand(idx: number) {
  setDsp("activeBand", idx);
}

export function toggleEq() {
  setDsp("eq", "enabled", (v) => !v);
  ipc.dspSetEqEnabled(dsp.eq.enabled).catch(console.error);
  persistDsp();
}

export function toggleBypass() {
  setDsp("bypass", (v) => !v);
  ipc.dspSetBypass(dsp.bypass).catch(console.error);
  persistDsp();
}

export function toggleLimiter() {
  setDsp("limiter", "enabled", (v) => !v);
  ipc.dspSetLimiterEnabled(dsp.limiter.enabled).catch(console.error);
  persistDsp();
}

export function toggleBass() {
  setDsp("bass", "enabled", (v) => !v);
  ipc.dspSetBassBypass(!dsp.bass.enabled).catch(console.error);
  persistDsp();
}

// ── Reset / Preset ────────────────────────────────────────────

export function resetToFlat() {
  const def = defaultState();
  setDsp(produce((s) => {
    s.eq.bands = def.eq.bands.map((b) => ({ ...b }));
    s.eq.input_gain = 0;
    s.eq.output_gain = 0;
  }));
  applyFullDspState();
}
