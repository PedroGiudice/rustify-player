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
  { freq: 25,    gain_db: 0,    q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 40,    gain_db: 0,    q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 63,    gain_db: 1.5,  q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 100,   gain_db: 0,    q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 160,   gain_db: -2.5, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 250,   gain_db: -0.5, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 400,   gain_db: 0,    q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 630,   gain_db: 0.5,  q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 1000,  gain_db: 2,    q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 1600,  gain_db: 0,    q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 2500,  gain_db: 2.5,  q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 4000,  gain_db: -0.5, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 6300,  gain_db: 0,    q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 10000, gain_db: 0,    q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 16000, gain_db: 1,    q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 20000, gain_db: 0,    q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
];

const STATE_KEY = "rustify-dsp-state";
const DSP_STATE_VERSION = 2;

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
    if (!saved || saved._v !== DSP_STATE_VERSION) return defaultState();
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
    const { activeBand: _, ...toSave } = dsp;
    localStorage.setItem(STATE_KEY, JSON.stringify({ _v: DSP_STATE_VERSION, ...toSave }));
  } catch {}
}

// ── Debounced IPC ──────────────────────────────────────────────

const _debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
export function ipcDebounced(cmd: () => Promise<void>, delay = 50, key = "default") {
  const prev = _debounceTimers.get(key);
  if (prev) clearTimeout(prev);
  _debounceTimers.set(key, setTimeout(() => {
    _debounceTimers.delete(key);
    cmd().catch(console.error);
    persistDsp();
  }, delay));
}

// ── Apply full state to backend ───────────────────────────────
// Chamado no boot do app (main.tsx) e no mount da view Signal.

let _applyRunning = false;
let _applyQueued = false;

export async function applyFullDspState() {
  if (_applyRunning) { _applyQueued = true; return; }
  _applyRunning = true;
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
    await ipc.dspSetLimiterMode(limiter.mode);
    await ipc.dspSetLimiterOversampling(limiter.ovs);
    await ipc.dspSetLimiterDither(limiter.dither);
    await ipc.dspSetLimiterKnee(limiter.knee);
    await ipc.dspSetLimiterLookahead(limiter.lookahead);
    await ipc.dspSetLimiterAttack(limiter.attack);
    await ipc.dspSetLimiterRelease(limiter.release);
    await ipc.dspSetLimiterScPreamp(limiter.sc_preamp);
    await ipc.dspSetLimiterStereoLink(limiter.stereo_link);
    await ipc.dspSetLimiterBoost(limiter.boost);
    await ipc.dspSetLimiterGain(limiter.input_gain, limiter.output_gain);
    await ipc.dspSetLimiterAlr(limiter.alr);
    await ipc.dspSetLimiterAlrAttack(limiter.alr_attack);
    await ipc.dspSetLimiterAlrRelease(limiter.alr_release);
    await ipc.dspSetBassBypass(!bass.enabled);
    await ipc.dspSetBassAmount(bass.amount);
    await ipc.dspSetBassDrive(bass.drive);
    await ipc.dspSetBassBlend(bass.blend);
    await ipc.dspSetBassFreq(bass.freq);
    await ipc.dspSetBassFloor(bass.floor);
    await ipc.dspSetBassFloorActive(bass.floor_active);
    await ipc.dspSetBassListen(bass.listen);
    await ipc.dspSetBassLevels(bass.input_gain, bass.output_gain);
  } catch (e) {
    console.error("[dsp] apply state failed:", e);
  } finally {
    _applyRunning = false;
    if (_applyQueued) { _applyQueued = false; applyFullDspState(); }
  }
}

// ── Mutações de EQ ────────────────────────────────────────────

export function setEqBandGain(bandIdx: number, gainDb: number) {
  setDsp("eq", "bands", bandIdx, "gain_db", gainDb);
  ipcDebounced(() => ipc.dspSetEqBand(bandIdx, dsp.eq.bands[bandIdx].freq, gainDb, dsp.eq.bands[bandIdx].q), 50, `eq-band-${bandIdx}`);
}

export function setEqBandType(bandIdx: number, type: number) {
  setDsp("eq", "bands", bandIdx, "type", type);
  ipcDebounced(() => ipc.dspSetEqFilterType(bandIdx, type), 100, `eq-type-${bandIdx}`);
}

export function setEqBandMode(bandIdx: number, mode: number) {
  setDsp("eq", "bands", bandIdx, "filterMode", mode);
  ipcDebounced(() => ipc.dspSetEqFilterMode(bandIdx, mode), 100, `eq-mode-${bandIdx}`);
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

export function setEqBandSlope(bandIdx: number, slope: number) {
  setDsp("eq", "bands", bandIdx, "slope", slope);
  ipcDebounced(() => ipc.dspSetEqSlope(bandIdx, slope), 100, `eq-slope-${bandIdx}`);
}

export function setEqBandSolo(bandIdx: number, solo: boolean) {
  setDsp("eq", "bands", bandIdx, "solo", solo);
  ipcDebounced(() => ipc.dspSetEqSolo(bandIdx, solo), 50, `eq-solo-${bandIdx}`);
}

export function setEqBandMute(bandIdx: number, mute: boolean) {
  setDsp("eq", "bands", bandIdx, "mute", mute);
  ipcDebounced(() => ipc.dspSetEqMute(bandIdx, mute), 50, `eq-mute-${bandIdx}`);
}

export function setEqMode(mode: number) {
  setDsp("eq", "mode", mode);
  ipcDebounced(() => ipc.dspSetEqMode(mode), 100, "eq-mode");
}

export function setEqGain(input: number, output: number) {
  setDsp("eq", "input_gain", input);
  setDsp("eq", "output_gain", output);
  ipcDebounced(() => ipc.dspSetEqGain(input, output), 100, "eq-gain");
}

// ── Mutações de Limiter ───────────────────────────────────────

export function setLimiterMode(mode: number) {
  setDsp("limiter", "mode", mode);
  ipcDebounced(() => ipc.dspSetLimiterMode(mode), 50, "lim-mode");
}

export function setLimiterOvs(ovs: number) {
  setDsp("limiter", "ovs", ovs);
  ipcDebounced(() => ipc.dspSetLimiterOversampling(ovs), 50, "lim-ovs");
}

export function setLimiterDither(dither: number) {
  setDsp("limiter", "dither", dither);
  ipcDebounced(() => ipc.dspSetLimiterDither(dither), 50, "lim-dither");
}

export function setLimiterThreshold(threshold: number) {
  setDsp("limiter", "threshold", threshold);
  ipcDebounced(() => ipc.dspSetLimiterThreshold(threshold), 50, "lim-threshold");
}

export function setLimiterKnee(knee: number) {
  setDsp("limiter", "knee", knee);
  ipcDebounced(() => ipc.dspSetLimiterKnee(knee), 50, "lim-knee");
}

export function setLimiterLookahead(lookahead: number) {
  setDsp("limiter", "lookahead", lookahead);
  ipcDebounced(() => ipc.dspSetLimiterLookahead(lookahead), 50, "lim-lookahead");
}

export function setLimiterAttack(attack: number) {
  setDsp("limiter", "attack", attack);
  ipcDebounced(() => ipc.dspSetLimiterAttack(attack), 50, "lim-attack");
}

export function setLimiterRelease(release: number) {
  setDsp("limiter", "release", release);
  ipcDebounced(() => ipc.dspSetLimiterRelease(release), 50, "lim-release");
}

export function setLimiterScPreamp(preamp: number) {
  setDsp("limiter", "sc_preamp", preamp);
  ipcDebounced(() => ipc.dspSetLimiterScPreamp(preamp), 50, "lim-sc-preamp");
}

export function setLimiterStereoLink(link: number) {
  setDsp("limiter", "stereo_link", link);
  ipcDebounced(() => ipc.dspSetLimiterStereoLink(link), 50, "lim-stereo-link");
}

export function setLimiterBoost(boost: boolean) {
  setDsp("limiter", "boost", boost);
  ipc.dspSetLimiterBoost(boost).catch(console.error);
  persistDsp();
}

export function setLimiterGain(input: number, output: number) {
  setDsp("limiter", "input_gain", input);
  setDsp("limiter", "output_gain", output);
  ipcDebounced(() => ipc.dspSetLimiterGain(input, output), 50, "lim-gain");
}

export function setLimiterAlr(alr: boolean) {
  setDsp("limiter", "alr", alr);
  ipc.dspSetLimiterAlr(alr).catch(console.error);
  persistDsp();
}

export function setLimiterAlrAttack(attack: number) {
  setDsp("limiter", "alr_attack", attack);
  ipcDebounced(() => ipc.dspSetLimiterAlrAttack(attack), 50, "lim-alr-attack");
}

export function setLimiterAlrRelease(release: number) {
  setDsp("limiter", "alr_release", release);
  ipcDebounced(() => ipc.dspSetLimiterAlrRelease(release), 50, "lim-alr-release");
}

// ── Mutações de Bass ──────────────────────────────────────────

export function setBassAmount(amount: number) {
  setDsp("bass", "amount", amount);
  ipcDebounced(() => ipc.dspSetBassAmount(amount), 50, "bass-amount");
}

export function setBassDrive(drive: number) {
  setDsp("bass", "drive", drive);
  ipcDebounced(() => ipc.dspSetBassDrive(drive), 50, "bass-drive");
}

export function setBassBlend(blend: number) {
  setDsp("bass", "blend", blend);
  ipcDebounced(() => ipc.dspSetBassBlend(blend), 50, "bass-blend");
}

export function setBassFreq(freq: number) {
  setDsp("bass", "freq", freq);
  ipcDebounced(() => ipc.dspSetBassFreq(freq), 50, "bass-freq");
}

export function setBassFloor(floor: number) {
  setDsp("bass", "floor", floor);
  ipcDebounced(() => ipc.dspSetBassFloor(floor), 50, "bass-floor");
}

export function setBassFloorActive(active: boolean) {
  setDsp("bass", "floor_active", active);
  ipc.dspSetBassFloorActive(active).catch(console.error);
  persistDsp();
}

export function setBassListen(listen: boolean) {
  setDsp("bass", "listen", listen);
  ipc.dspSetBassListen(listen).catch(console.error);
  persistDsp();
}

export function setBassLevels(input: number, output: number) {
  setDsp("bass", "input_gain", input);
  setDsp("bass", "output_gain", output);
  ipcDebounced(() => ipc.dspSetBassLevels(input, output), 50, "bass-levels");
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
