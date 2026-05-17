/* ============================================================
   store/dsp-presets.ts — Import/Export EasyEffects.

   Funcoes portadas de src/js/views/signal.js (legacy vanilla).
   Convertem entre o formato EasyEffects (JSON) e o snapshot do
   DSP store (subset de DspStore).

   Uso pra preset I/O e nada mais. Estado vivo do DSP fica em
   store/dsp.ts.
   ============================================================ */

import { produce } from "solid-js/store";
import {
  FILTER_TYPES, FILTER_MODES, SLOPES, LIMITER_MODES,
  type EqBand, type DspStore,
  dsp, setDsp, applyFullDspState,
} from "./dsp";

export interface DspPreset {
  name: string;
  eq: {
    mode: string;
    input_gain: number;
    output_gain: number;
    bands: EqBand[];
  };
  limiter: DspStore["limiter"];
  bass_enhancer: DspStore["bass"];
}

// ── Helpers ────────────────────────────────────────────────────

function modeIdx(mode: string | undefined): number {
  if (!mode) return 0;
  const i = (FILTER_MODES as readonly string[]).indexOf(mode);
  return i >= 0 ? i : 6; // default APO (DR)
}

function typeIdx(type: string | undefined): number {
  if (!type) return 1;
  const i = (FILTER_TYPES as readonly string[]).indexOf(type);
  return i >= 0 ? i : 1; // default Bell
}

function slopeIdx(slope: string | undefined): number {
  if (!slope) return 0;
  const i = (SLOPES as readonly string[]).indexOf(slope);
  return i >= 0 ? i : 0;
}

function limiterModeIdx(mode: string | undefined): number {
  if (!mode) return 0;
  const i = (LIMITER_MODES as readonly string[]).indexOf(mode);
  return i >= 0 ? i : 0;
}

// ── parseEasyEffects ──────────────────────────────────────────
// Entrada: JSON de preset EasyEffects (formato output).
// Saida: DspPreset. Defaults sao aplicados pra qualquer campo ausente.

export function parseEasyEffects(json: any, name: string): DspPreset {
  const o = json?.output ?? json ?? {};

  const preset: DspPreset = {
    name,
    eq: { mode: "IIR", input_gain: 0, output_gain: 0, bands: [] },
    limiter: {
      enabled: false, mode: 0, ovs: 0, dither: 0,
      threshold: 0, knee: 0, lookahead: 5,
      attack: 5, release: 20, sc_preamp: 1, stereo_link: 100,
      boost: false, alr: true, alr_attack: 5, alr_release: 50,
      input_gain: 0, output_gain: 0,
    },
    bass_enhancer: {
      enabled: false, amount: 0, drive: 0, blend: 0, freq: 120, floor: 20,
      floor_active: true, listen: false, input_gain: 0, output_gain: 0,
    },
  };

  const eq = o["equalizer#0"];
  if (eq) {
    preset.eq.mode = eq.mode || "IIR";
    preset.eq.input_gain = eq["input-gain"] ?? 0;
    preset.eq.output_gain = eq["output-gain"] ?? 0;
    const left = eq.left || {};
    const numBands = eq["num-bands"] || Object.keys(left).length;
    for (let i = 0; i < numBands; i++) {
      const b = left[`band${i}`];
      if (!b) continue;
      preset.eq.bands.push({
        freq: b.frequency ?? 100,
        gain_db: b.gain ?? 0,
        q: b.q ?? 2.21,
        type: typeIdx(b.type),
        filterMode: modeIdx(b.mode),
        slope: slopeIdx(b.slope),
        solo: !!b.solo,
        mute: !!b.mute,
      });
    }
  }

  const be = o["bass_enhancer#0"];
  if (be) {
    preset.bass_enhancer = {
      enabled: !be.bypass,
      amount: be.amount ?? 0,
      drive: be.harmonics ?? 0,
      blend: be.blend ?? 0,
      freq: be.scope ?? 120,
      floor: be.floor ?? 20,
      floor_active: be["floor-active"] !== false,
      listen: !!be.listen,
      input_gain: be["input-gain"] ?? 0,
      output_gain: be["output-gain"] ?? 0,
    };
  }

  const lim = o["limiter#0"];
  if (lim) {
    preset.limiter = {
      enabled: !lim.bypass,
      mode: limiterModeIdx(lim.mode),
      ovs: lim.ovs ?? 0,
      dither: lim.dither ?? 0,
      threshold: lim.threshold ?? 0,
      knee: lim.knee ?? 0,
      lookahead: lim.lookahead ?? 5,
      attack: lim.attack ?? 5,
      release: lim.release ?? 20,
      sc_preamp: lim["sidechain-preamp"] ?? 1,
      stereo_link: lim["stereo-link"] ?? 100,
      boost: !!lim.boost,
      alr: lim.alr !== false,
      alr_attack: lim["alr-attack"] ?? 5,
      alr_release: lim["alr-release"] ?? 50,
      input_gain: lim["input-gain"] ?? 0,
      output_gain: lim["output-gain"] ?? 0,
    };
  }

  return preset;
}

// ── toEasyEffects ─────────────────────────────────────────────
// Entrada: snapshot parcial do DSP. Saida: JSON EasyEffects export.

export interface DspSnapshot {
  eq: { mode?: string; input_gain: number; output_gain: number; bands: EqBand[] };
  limiter: DspStore["limiter"];
  bass: DspStore["bass"];
}

export function toEasyEffects(snap: DspSnapshot): any {
  const bands = snap.eq.bands;
  const left: Record<string, any> = {};
  const right: Record<string, any> = {};
  bands.forEach((b, i) => {
    const band = {
      frequency: b.freq,
      gain: b.gain_db,
      mode: FILTER_MODES[b.filterMode] || "APO (DR)",
      mute: !!b.mute,
      q: b.q,
      slope: SLOPES[b.slope] || "x1",
      solo: !!b.solo,
      type: FILTER_TYPES[b.type] || "Bell",
      width: 4.0,
    };
    left[`band${i}`] = { ...band };
    right[`band${i}`] = { ...band };
  });

  const be = snap.bass;
  const lim = snap.limiter;

  return {
    output: {
      "bass_enhancer#0": {
        amount: be.amount,
        blend: be.blend,
        bypass: !be.enabled,
        floor: be.floor,
        "floor-active": be.floor_active,
        harmonics: be.drive,
        listen: be.listen,
        "input-gain": be.input_gain,
        "output-gain": be.output_gain,
        scope: be.freq,
      },
      "limiter#0": {
        mode: LIMITER_MODES[lim.mode] || "Herm Thin",
        ovs: lim.ovs,
        dither: lim.dither,
        threshold: lim.threshold,
        knee: lim.knee,
        lookahead: lim.lookahead,
        attack: lim.attack,
        release: lim.release,
        "sidechain-preamp": lim.sc_preamp,
        "stereo-link": lim.stereo_link,
        boost: lim.boost,
        alr: lim.alr,
        "alr-attack": lim.alr_attack,
        "alr-release": lim.alr_release,
        "input-gain": lim.input_gain,
        "output-gain": lim.output_gain,
        bypass: !lim.enabled,
      },
      blocklist: [],
      "equalizer#0": {
        balance: 0,
        bypass: false,
        "input-gain": snap.eq.input_gain,
        left,
        mode: snap.eq.mode || "IIR",
        "num-bands": bands.length,
        "output-gain": snap.eq.output_gain,
        right,
      },
      plugins_order: ["equalizer#0", "limiter#0", "bass_enhancer#0"],
    },
  };
}

// ── CRUD persistencia ─────────────────────────────────────────
// Storage layout:
//   "rustify-dsp-presets"        => DspPreset[]
//   "rustify-dsp-active-preset"  => string (nome do ultimo preset aplicado)

const PRESETS_KEY = "rustify-dsp-presets";
const ACTIVE_KEY = "rustify-dsp-active-preset";

export function loadPresets(): DspPreset[] {
  try {
    const raw = localStorage.getItem(PRESETS_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function savePresets(presets: DspPreset[]): void {
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(presets)); } catch {}
}

export function getActivePresetName(): string {
  try { return localStorage.getItem(ACTIVE_KEY) ?? ""; } catch { return ""; }
}

export function setActivePresetName(name: string): void {
  try { localStorage.setItem(ACTIVE_KEY, name); } catch {}
}

// Snapshot do estado vivo do store no formato DspPreset.
export function snapshotCurrentDsp(name: string): DspPreset {
  return {
    name,
    eq: {
      mode: ["IIR", "FIR", "FFT", "SPM"][dsp.eq.mode] ?? "IIR",
      input_gain: dsp.eq.input_gain,
      output_gain: dsp.eq.output_gain,
      bands: dsp.eq.bands.map((b) => ({ ...b })),
    },
    limiter: { ...dsp.limiter },
    bass_enhancer: { ...dsp.bass },
  };
}

// Aplica um preset salvo no store + dispara IPC pra backend.
// Downsample pra 16 bands (preset pode ter 32 do EasyEffects).
export function applyPresetToStore(preset: DspPreset): void {
  const modeMap: Record<string, number> = { IIR: 0, FIR: 1, FFT: 2, SPM: 3 };
  const incomingBands = preset.eq?.bands ?? [];

  setDsp(produce((s) => {
    for (let i = 0; i < 16; i++) {
      const b = incomingBands[i];
      if (b) {
        s.eq.bands[i] = {
          freq: b.freq ?? s.eq.bands[i].freq,
          gain_db: b.gain_db ?? 0,
          q: b.q ?? 2.21,
          type: b.type ?? 1,
          filterMode: b.filterMode ?? 6,
          slope: b.slope ?? 0,
          solo: !!b.solo,
          mute: !!b.mute,
        };
      } else {
        s.eq.bands[i].gain_db = 0;
        s.eq.bands[i].solo = false;
        s.eq.bands[i].mute = false;
      }
    }
    s.eq.mode = modeMap[preset.eq?.mode ?? "IIR"] ?? 0;
    s.eq.input_gain = preset.eq?.input_gain ?? 0;
    s.eq.output_gain = preset.eq?.output_gain ?? 0;
    if (preset.limiter) Object.assign(s.limiter, preset.limiter);
    if (preset.bass_enhancer) Object.assign(s.bass, preset.bass_enhancer);
  }));

  applyFullDspState();
}
