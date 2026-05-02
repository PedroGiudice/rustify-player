/* ============================================================
   views/Signal.tsx — DSP chain: Parametric EQ, Limiter, Bass Enhancer.
   Port fiel do signal.js vanilla com fix de interacao nos sliders
   (pointer capture + bounding rect direto no track).
   ============================================================ */

import { createSignal, onMount, onCleanup, For, Show } from "solid-js";
import { createStore, produce } from "solid-js/store";
import {
  dspSetBypass, dspSetEqEnabled, dspSetEqMode, dspSetEqGain,
  dspSetEqBand, dspSetEqFilterType, dspSetEqFilterMode, dspSetEqSlope,
  dspSetEqSolo, dspSetEqMute, dspSetLimiterEnabled, dspSetLimiterThreshold,
  dspSetBassBypass, dspSetBassAmount,
} from "../tauri";

const { invoke } = window.__TAURI__.core;

const DB_RANGE = 36;
const FILTER_TYPES = ["Off", "Bell", "Hi-pass", "Hi-shelf", "Lo-pass", "Lo-shelf", "Notch", "Resonance", "Allpass", "Bandpass", "Ladder-pass", "Ladder-rej"];
const FILTER_MODES = ["RLC (BT)", "RLC (MT)", "BWC (BT)", "BWC (MT)", "LRX (BT)", "LRX (MT)", "APO (DR)"];
const SLOPES = ["x1", "x2", "x3", "x4"];
const LIMITER_MODES = ["Herm Thin", "Herm Wide", "Herm Tail", "Herm Duck", "Exp Thin", "Exp Wide", "Exp Tail", "Exp Duck"];
const LIMITER_OVS = ["None", "Half x2/16", "Half x2/24", "Half x3/16", "Half x3/24", "Half x4/16", "Half x4/24", "Half x6/16", "Half x6/24", "Half x8/16", "Half x8/24", "Full x2/16", "Full x2/24", "Full x3/16", "Full x3/24", "Full x4/16", "Full x4/24", "Full x6/16", "Full x6/24", "Full x8/16", "Full x8/24"];
const LIMITER_DITHER = ["None", "7bit", "8bit", "11bit", "12bit"];
const MODE_NAMES = ["IIR", "FIR", "FFT", "SPM"];

interface Band {
  freq: number; gain_db: number; q: number; type: number;
  filterMode: number; slope: number; solo: boolean; mute: boolean;
}

const DEFAULT_BANDS: Band[] = [
  { freq: 20, gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 26, gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 38, gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 55, gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 72, gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 110, gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 160, gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 220, gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 300, gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 400, gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 560, gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 800, gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 1100, gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 1600, gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 2300, gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
  { freq: 3300, gain_db: 0, q: 2.21, type: 1, filterMode: 6, slope: 0, solo: false, mute: false },
];

const STORAGE_KEY = "rustify-dsp-presets";
const ACTIVE_KEY = "rustify-dsp-active";
const STATE_KEY = "rustify-dsp-state";

function fmtHz(hz: number) { return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k` : String(hz); }
function fmtDb(db: number) { return `${db > 0 ? "+" : ""}${db.toFixed(1)}`; }
function fmtVal(val: number, dec = 1) { return Number(val).toFixed(dec); }
function sliderPct(val: number, min: number, max: number) { return ((val - min) / (max - min)) * 100; }

function defaultState() {
  return {
    bypass: false,
    eq: { enabled: true, mode: 0, input_gain: 0, output_gain: 0, bands: DEFAULT_BANDS.map(b => ({ ...b })) },
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

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY) || "null");
    if (saved) {
      const def = defaultState();
      return {
        bypass: saved.bypass ?? def.bypass,
        eq: { ...def.eq, ...saved.eq, bands: (saved.eq?.bands || def.eq.bands).map((b: any, i: number) => ({ ...def.eq.bands[i], ...b })) },
        limiter: { ...def.limiter, ...saved.limiter },
        bass: { ...def.bass, ...saved.bass },
      };
    }
  } catch {}
  return defaultState();
}

function persistState(s: any) { try { localStorage.setItem(STATE_KEY, JSON.stringify(s)); } catch {} }
function loadPresets(): any[] { try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]"); } catch { return []; } }
function savePresets(p: any[]) { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); }
function getActivePresetName() { return localStorage.getItem(ACTIVE_KEY) || ""; }
function setActivePresetName(n: string) { localStorage.setItem(ACTIVE_KEY, n); }

let _ipcTimer: any = null;
function ipcDebounced(cmd: string, args: any, delay = 50) {
  clearTimeout(_ipcTimer);
  _ipcTimer = setTimeout(() => { invoke(cmd, args).catch(console.error); }, delay);
}

export default function Signal() {
  const [state, setState] = createStore(loadState());
  const [activeBand, setActiveBand] = createSignal(0);
  const [presets, setPresets] = createSignal(loadPresets());
  const [activePreset, setActivePreset] = createSignal(getActivePresetName());

  let canvasRef: HTMLCanvasElement | undefined;
  let canvasCtx: CanvasRenderingContext2D | null = null;

  function save() { persistState(state); }

  function drawCurve() {
    if (!canvasRef || !canvasCtx) return;
    const dpr = devicePixelRatio || 1;
    const r = canvasRef.parentElement!.getBoundingClientRect();
    canvasRef.width = r.width * dpr;
    canvasRef.height = r.height * dpr;
    canvasCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const w = r.width, h = r.height, mid = h / 2;
    canvasCtx.clearRect(0, 0, w, h);
    canvasCtx.strokeStyle = "rgba(237,234,227,.03)";
    canvasCtx.lineWidth = 1;
    for (let i = 1; i < 5; i++) { canvasCtx.beginPath(); canvasCtx.moveTo(0, (h / 5) * i); canvasCtx.lineTo(w, (h / 5) * i); canvasCtx.stroke(); }
    canvasCtx.strokeStyle = "rgba(237,234,227,.07)";
    canvasCtx.beginPath(); canvasCtx.moveTo(0, mid); canvasCtx.lineTo(w, mid); canvasCtx.stroke();

    const pts = state.eq.bands.map((b, i) => [
      (i / (state.eq.bands.length - 1)) * w,
      mid - (b.gain_db / DB_RANGE) * (h / 2) * 0.85,
    ]);
    if (pts.length < 2) return;

    const path = new Path2D();
    path.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, pts.length - 1)];
      path.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
    }
    path.lineTo(w, mid); path.lineTo(0, mid); path.closePath();
    canvasCtx.fillStyle = "rgba(198,99,61,.06)";
    canvasCtx.fill(path);

    canvasCtx.beginPath();
    canvasCtx.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, pts.length - 1)];
      canvasCtx.bezierCurveTo(p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6, p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6, p2[0], p2[1]);
    }
    canvasCtx.strokeStyle = "rgba(198,99,61,.6)";
    canvasCtx.lineWidth = 1.5;
    canvasCtx.stroke();

    pts.forEach(([x, y], i) => {
      const active = state.eq.bands[i].gain_db !== 0;
      canvasCtx!.beginPath();
      canvasCtx!.arc(x, y, active ? 3.5 : 2, 0, Math.PI * 2);
      canvasCtx!.fillStyle = i === activeBand() ? "rgba(198,99,61,1)" : active ? "rgba(198,99,61,.7)" : "rgba(142,138,130,.3)";
      canvasCtx!.fill();
    });
  }

  onMount(() => {
    if (canvasRef) { canvasCtx = canvasRef.getContext("2d"); drawCurve(); }
    window.addEventListener("resize", drawCurve);
    applyFullState();
  });
  onCleanup(() => window.removeEventListener("resize", drawCurve));

  async function applyFullState() {
    save();
    try {
      await invoke("dsp_set_bypass", { bypass: state.bypass });
      await invoke("dsp_set_eq_enabled", { enabled: state.eq.enabled });
      await invoke("dsp_set_eq_mode", { mode: state.eq.mode });
      await invoke("dsp_set_eq_gain", { input: state.eq.input_gain, output: state.eq.output_gain });
      for (let i = 0; i < state.eq.bands.length; i++) {
        const b = state.eq.bands[i];
        await invoke("dsp_set_eq_band", { band: i, freq: b.freq, gainDb: b.gain_db, q: b.q });
        await invoke("dsp_set_eq_filter_type", { band: i, filterType: b.type });
        await invoke("dsp_set_eq_filter_mode", { band: i, mode: b.filterMode }).catch(() => {});
        await invoke("dsp_set_eq_slope", { band: i, slope: b.slope }).catch(() => {});
        await invoke("dsp_set_eq_solo", { band: i, solo: b.solo }).catch(() => {});
        await invoke("dsp_set_eq_mute", { band: i, mute: b.mute }).catch(() => {});
      }
      await invoke("dsp_set_limiter_enabled", { enabled: state.limiter.enabled });
      await invoke("dsp_set_limiter_threshold", { thresholdDb: state.limiter.threshold });
      await invoke("dsp_set_bass_bypass", { bypass: !state.bass.enabled });
      await invoke("dsp_set_bass_amount", { amount: state.bass.amount });
    } catch (e) { console.error("[signal] apply state failed:", e); }
  }

  // -- Fader pointerdown (FIXED: click-to-position + 1:1 drag) --
  function handleFaderPointerDown(e: PointerEvent, bandIdx: number) {
    const fader = (e.currentTarget as HTMLElement);
    const track = fader.querySelector(".sig-f-track") as HTMLElement;
    if (!track) return;
    e.preventDefault();
    fader.setPointerCapture(e.pointerId);
    setActiveBand(bandIdx);

    const rect = track.getBoundingClientRect();
    const updateValue = (ev: PointerEvent) => {
      const ratio = 1 - Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
      const db = Math.round((ratio * DB_RANGE * 2 - DB_RANGE) * 10) / 10;
      const clamped = Math.max(-DB_RANGE, Math.min(DB_RANGE, db));
      setState("eq", "bands", bandIdx, "gain_db", clamped);
      drawCurve();
      ipcDebounced("dsp_set_eq_band", { band: bandIdx, freq: state.eq.bands[bandIdx].freq, gainDb: clamped, q: state.eq.bands[bandIdx].q });
    };
    updateValue(e);
    const onMove = (ev: PointerEvent) => updateValue(ev);
    const onUp = () => { fader.releasePointerCapture(e.pointerId); window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); save(); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  // -- Param slider pointerdown (FIXED) --
  function handleParamPointerDown(e: PointerEvent, key: string, min: number, max: number, section: string, decimals: number) {
    const slider = (e.currentTarget as HTMLElement);
    const track = slider.querySelector(".sig-param__track") as HTMLElement;
    if (!track) return;
    e.preventDefault();
    slider.setPointerCapture(e.pointerId);
    const rect = track.getBoundingClientRect();

    const update = (ev: PointerEvent) => {
      const ratio = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      const val = parseFloat((min + ratio * (max - min)).toFixed(decimals));
      if (section === "limiter") {
        setState("limiter", key as any, val);
        const ipcMap: Record<string, [string, any]> = {
          threshold: ["dsp_set_limiter_threshold", { thresholdDb: val }],
          knee: ["dsp_set_limiter_knee", { knee: val }],
          lookahead: ["dsp_set_limiter_lookahead", { lookahead: val }],
          attack: ["dsp_set_limiter_attack", { attack: val }],
          release: ["dsp_set_limiter_release", { release: val }],
          sc_preamp: ["dsp_set_limiter_sc_preamp", { preamp: val }],
          stereo_link: ["dsp_set_limiter_stereo_link", { link: val }],
          input_gain: ["dsp_set_limiter_gain", { input: val, output: state.limiter.output_gain }],
          output_gain: ["dsp_set_limiter_gain", { input: state.limiter.input_gain, output: val }],
          alr_attack: ["dsp_set_limiter_alr_attack", { attack: val }],
          alr_release: ["dsp_set_limiter_alr_release", { release: val }],
        };
        if (ipcMap[key]) ipcDebounced(ipcMap[key][0], ipcMap[key][1]);
      } else if (section === "bass") {
        setState("bass", key as any, val);
        const ipcMap: Record<string, [string, any]> = {
          amount: ["dsp_set_bass_amount", { amount: val }],
          drive: ["dsp_set_bass_drive", { drive: val }],
          blend: ["dsp_set_bass_blend", { blend: val }],
          freq: ["dsp_set_bass_freq", { freq: val }],
          floor: ["dsp_set_bass_floor", { floor: val }],
          input_gain: ["dsp_set_bass_levels", { input: val, output: state.bass.output_gain }],
          output_gain: ["dsp_set_bass_levels", { input: state.bass.input_gain, output: val }],
        };
        if (ipcMap[key]) ipcDebounced(ipcMap[key][0], ipcMap[key][1]);
      } else if (section === "eq-gain") {
        setState("eq", key as any, val);
        ipcDebounced("dsp_set_eq_gain", { input: state.eq.input_gain, output: state.eq.output_gain });
      }
    };
    update(e);
    const onMove = (ev: PointerEvent) => update(ev);
    const onUp = () => { slider.releasePointerCapture(e.pointerId); window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); save(); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function ParamRow(p: { key: string; label: string; val: number; min: number; max: number; unit: string; section: string; decimals?: number }) {
    const dec = p.decimals ?? 1;
    const pct = () => sliderPct(p.val, p.min, p.max);
    return (
      <div class="sig-param">
        <span class="sig-param__label">{p.label}</span>
        <div class="sig-param__slider" onPointerDown={(e) => handleParamPointerDown(e, p.key, p.min, p.max, p.section, dec)}>
          <div class="sig-param__track">
            <div class="sig-param__fill" style={`width:${pct()}%`} />
            <div class="sig-param__thumb" style={`left:${pct()}%`} />
          </div>
        </div>
        <span class="sig-param__val">{fmtVal(p.val, dec)}<span class="sig-param__unit">{p.unit}</span></span>
      </div>
    );
  }

  function selectPreset(name: string) {
    if (name === "Flat") {
      const def = defaultState();
      setState(def);
    } else {
      const p = presets().find(x => x.name === name);
      if (p) {
        const bands = p.eq?.bands || [];
        for (let i = 0; i < 16; i++) setState("eq", "bands", i, { ...DEFAULT_BANDS[i], ...(bands[i] || {}) });
        if (p.limiter) setState("limiter", p.limiter);
        if (p.bass_enhancer) setState("bass", p.bass_enhancer);
      }
    }
    setActivePresetName(name);
    setActivePreset(name);
    applyFullState();
  }

  function savePreset() {
    const name = prompt("Preset name:");
    if (!name) return;
    const list = loadPresets();
    const preset = { name, eq: JSON.parse(JSON.stringify(state.eq)), limiter: { ...state.limiter }, bass_enhancer: { ...state.bass } };
    const idx = list.findIndex((p: any) => p.name === name);
    if (idx >= 0) list[idx] = preset; else list.push(preset);
    savePresets(list);
    setPresets(list);
    setActivePresetName(name);
    setActivePreset(name);
  }

  function deletePreset() {
    const current = activePreset();
    if (!current || current === "Flat") return;
    if (!confirm(`Delete preset "${current}"?`)) return;
    const list = loadPresets().filter((p: any) => p.name !== current);
    savePresets(list);
    setPresets(list);
    selectPreset("Flat");
  }

  async function importPreset() {
    try {
      const { open } = window.__TAURI__.dialog;
      const path = await open({ filters: [{ name: "EasyEffects Preset", extensions: ["json"] }], defaultPath: "~/.config/easyeffects/output" });
      if (!path) return;
      const { readTextFile } = window.__TAURI__.fs;
      const text = await readTextFile(path);
      const json = JSON.parse(text);
      const fileName = (path as string).split("/").pop()?.replace(".json", "") || "imported";
      // Simplified import — full parseEasyEffects in signal.js
      const list = loadPresets();
      list.push({ name: fileName, eq: json.output?.["equalizer#0"] ? { bands: [] } : state.eq });
      savePresets(list);
      setPresets(list);
    } catch (e) { console.error("[signal] import failed:", e); }
  }

  async function exportPreset() {
    try {
      const { save: dlgSave } = window.__TAURI__.dialog;
      const path = await dlgSave({ filters: [{ name: "EasyEffects Preset", extensions: ["json"] }], defaultPath: `${activePreset() || "rustify-preset"}.json` });
      if (!path) return;
      const { writeTextFile } = window.__TAURI__.fs;
      await writeTextFile(path, JSON.stringify({ output: {} }, null, 4));
    } catch (e) { console.error("[signal] export failed:", e); }
  }

  const ab = () => activeBand();
  const band = () => state.eq.bands[ab()];

  return (
    <article class="view">
      <header class="view__header">
        <h1 class="view__title">Signal</h1>
        <div class="view__stats"><span>DSP Chain</span></div>
        <div class="sig-master">
          <span class="sig-master-lbl">Master</span>
          <div class={`sig-tog${state.bypass ? "" : " sig-tog--on"}`} onClick={() => { setState("bypass", !state.bypass); invoke("dsp_set_bypass", { bypass: state.bypass }).catch(console.error); save(); }} />
        </div>
      </header>

      {/* Presets */}
      <div class="sig-presets">
        <div class="sig-presets__chips">
          <span class={`sig-pre${!activePreset() || activePreset() === "Flat" ? " sig-pre--on" : ""}`} onClick={() => selectPreset("Flat")}>Flat</span>
          <For each={presets()}>{(p) => <span class={`sig-pre${p.name === activePreset() ? " sig-pre--on" : ""}`} onClick={() => selectPreset(p.name)}>{p.name}</span>}</For>
        </div>
        <div class="sig-presets__actions">
          <button class="sig-pre-btn" onClick={savePreset}>Save</button>
          <button class="sig-pre-btn" onClick={() => { const c = activePreset(); if (!c || c === "Flat") return; const n = prompt("Rename:", c); if (!n) return; const list = loadPresets(); const idx = list.findIndex((p: any) => p.name === c); if (idx >= 0) { list[idx].name = n; savePresets(list); setPresets(list); setActivePresetName(n); setActivePreset(n); } }}>Rename</button>
          <button class="sig-pre-btn" onClick={deletePreset}>Delete</button>
          <button class="sig-pre-btn" onClick={importPreset}>Import</button>
          <button class="sig-pre-btn" onClick={exportPreset}>Export</button>
        </div>
      </div>

      {/* Signal chain */}
      <div class="sig-chain">
        <span class="sig-ch-n">Source</span><span class="sig-ch-a">{"→"}</span>
        <span class="sig-ch-n">Decode</span><span class="sig-ch-a">{"→"}</span>
        <span class={`sig-ch-n${state.eq.enabled ? " sig-ch-n--on" : ""}`}>Parametric EQ</span><span class="sig-ch-a">{"→"}</span>
        <span class={`sig-ch-n${state.limiter.enabled ? " sig-ch-n--on" : ""}`}>Limiter</span><span class="sig-ch-a">{"→"}</span>
        <span class={`sig-ch-n${state.bass.enabled ? " sig-ch-n--on" : ""}`}>Bass Enhance</span><span class="sig-ch-a">{"→"}</span>
        <span class="sig-ch-n">PipeWire</span>
      </div>

      {/* === EQ Section === */}
      <div class="sig-sec">
        <div class="sig-sec-h">
          <span class="sig-sec-t">Parametric Equalizer</span>
          <span class="sig-sec-badge">LSP x16 Stereo</span>
          <div class={`sig-tog sig-tog--sm${state.eq.enabled ? " sig-tog--on" : ""}`} onClick={() => { setState("eq", "enabled", !state.eq.enabled); invoke("dsp_set_eq_enabled", { enabled: state.eq.enabled }); save(); }} />
        </div>
        <div class="sig-sec-b">
          <div class="sig-eq-wrap">
            <canvas ref={canvasRef} />
            <div class="sig-eq-yaxis"><span>+36</span><span>+18</span><span>0</span><span>{"−18"}</span><span>{"−36"}</span></div>
          </div>
          <div class="sig-eq-xaxis"><span>20</span><span>50</span><span>100</span><span>200</span><span>500</span><span>1k</span><span>2k</span><span>5k</span><span>10k</span><span>20k</span></div>

          {/* Faders */}
          <div class="sig-faders">
            <For each={state.eq.bands}>
              {(b, i) => {
                const thumbPos = () => 50 + (b.gain_db / DB_RANGE) * 50;
                const fillPct = () => Math.abs(b.gain_db) / DB_RANGE * 50;
                return (
                  <div class={`sig-fader${ab() === i() ? " sig-fader--active" : ""}`} onPointerDown={(e) => handleFaderPointerDown(e, i())}>
                    <span class="sig-f-hz">{fmtHz(b.freq)}</span>
                    <div class="sig-f-track">
                      <div class="sig-f-zero" />
                      <Show when={b.gain_db !== 0}>
                        <div class={b.gain_db >= 0 ? "sig-f-fill sig-f-up" : "sig-f-fill sig-f-dn"} style={`height:${fillPct()}%`} />
                      </Show>
                      <div class="sig-f-thumb" style={`bottom:${thumbPos()}%`} />
                    </div>
                    <span class="sig-f-val">{fmtDb(b.gain_db)}</span>
                  </div>
                );
              }}
            </For>
          </div>

          {/* Band detail */}
          <div class="sig-bd">
            <div class="sig-bd__ctx">
              <span class="sig-bd__band">Band {ab() + 1}</span>
              <span class="sig-bd__sep">{"·"}</span>
              <span>{fmtHz(band().freq)} Hz</span>
              <span class="sig-bd__sep">{"·"}</span>
              <span class="sig-bd__type">{FILTER_TYPES[band().type]}</span>
            </div>
            <div class="sig-bd__ctrls">
              <label class="sig-bd__lbl">Type
                <select class="sig-bd-select" value={band().type} onChange={(e) => { const v = parseInt(e.currentTarget.value); setState("eq", "bands", ab(), "type", v); invoke("dsp_set_eq_filter_type", { band: ab(), filterType: v }); save(); }}>
                  <For each={FILTER_TYPES}>{(t, i) => <option value={i()}>{t}</option>}</For>
                </select>
              </label>
              <label class="sig-bd__lbl">Mode
                <select class="sig-bd-select" value={band().filterMode} onChange={(e) => { const v = parseInt(e.currentTarget.value); setState("eq", "bands", ab(), "filterMode", v); invoke("dsp_set_eq_filter_mode", { band: ab(), mode: v }).catch(() => {}); save(); }}>
                  <For each={FILTER_MODES}>{(m, i) => <option value={i()}>{m}</option>}</For>
                </select>
              </label>
              <label class="sig-bd__lbl">Slope
                <select class="sig-bd-select" value={band().slope} onChange={(e) => { const v = parseInt(e.currentTarget.value); setState("eq", "bands", ab(), "slope", v); invoke("dsp_set_eq_slope", { band: ab(), slope: v }).catch(() => {}); save(); }}>
                  <For each={SLOPES}>{(s, i) => <option value={i()}>{s}</option>}</For>
                </select>
              </label>
              <span class="sig-bd__q">Q: <b>{band().q.toFixed(2)}</b></span>
              <div class="sig-bd__toggles">
                <button class={`sig-bd-sm sig-bd-sm--solo${band().solo ? " is-active" : ""}`} onClick={() => { setState("eq", "bands", ab(), "solo", !band().solo); invoke("dsp_set_eq_solo", { band: ab(), solo: band().solo }).catch(() => {}); save(); }}>S</button>
                <button class={`sig-bd-sm sig-bd-sm--mute${band().mute ? " is-active" : ""}`} onClick={() => { setState("eq", "bands", ab(), "mute", !band().mute); invoke("dsp_set_eq_mute", { band: ab(), mute: band().mute }).catch(() => {}); save(); }}>M</button>
              </div>
            </div>
          </div>

          {/* EQ foot */}
          <div class="sig-eq-foot">
            <div>
              <div class="sig-foot-lbl">Mode</div>
              <div class="sig-modes">
                <For each={MODE_NAMES}>{(m, i) => <button class={`sig-md${state.eq.mode === i() ? " sig-md--on" : ""}`} onClick={() => { setState("eq", "mode", i()); invoke("dsp_set_eq_mode", { mode: i() }); save(); }}>{m}</button>}</For>
              </div>
            </div>
            <div class="sig-eq-gains">
              <ParamRow key="input_gain" label="Input" val={state.eq.input_gain} min={-12} max={12} unit="dB" section="eq-gain" />
              <ParamRow key="output_gain" label="Output" val={state.eq.output_gain} min={-12} max={12} unit="dB" section="eq-gain" />
            </div>
          </div>
        </div>
      </div>

      {/* === Limiter Section === */}
      <div class="sig-sec">
        <div class="sig-sec-h">
          <span class="sig-sec-t">Limiter</span>
          <span class="sig-sec-badge">LSP Stereo</span>
          <div class={`sig-tog sig-tog--sm${state.limiter.enabled ? " sig-tog--on" : ""}`} onClick={() => { setState("limiter", "enabled", !state.limiter.enabled); invoke("dsp_set_limiter_enabled", { enabled: state.limiter.enabled }); save(); }} />
        </div>
        <div class="sig-sec-b">
          <div class="sig-lim-selects">
            <label class="sig-bd__lbl">Mode
              <select class="sig-bd-select" value={state.limiter.mode} onChange={(e) => { setState("limiter", "mode", parseInt(e.currentTarget.value)); invoke("dsp_set_limiter_mode", { mode: state.limiter.mode }); save(); }}>
                <For each={LIMITER_MODES}>{(m, i) => <option value={i()}>{m}</option>}</For>
              </select>
            </label>
            <label class="sig-bd__lbl">Oversampling
              <select class="sig-bd-select" value={state.limiter.ovs} onChange={(e) => { setState("limiter", "ovs", parseInt(e.currentTarget.value)); invoke("dsp_set_limiter_oversampling", { ovs: state.limiter.ovs }); save(); }}>
                <For each={LIMITER_OVS}>{(m, i) => <option value={i()}>{m}</option>}</For>
              </select>
            </label>
            <label class="sig-bd__lbl">Dither
              <select class="sig-bd-select" value={state.limiter.dither} onChange={(e) => { setState("limiter", "dither", parseInt(e.currentTarget.value)); invoke("dsp_set_limiter_dither", { dither: state.limiter.dither }); save(); }}>
                <For each={LIMITER_DITHER}>{(m, i) => <option value={i()}>{m}</option>}</For>
              </select>
            </label>
            <div class="sig-lim-toggles">
              <span class="sig-alr__label">Boost</span>
              <div class={`sig-tog sig-tog--sm${state.limiter.boost ? " sig-tog--on" : ""}`} onClick={() => { setState("limiter", "boost", !state.limiter.boost); invoke("dsp_set_limiter_boost", { boost: state.limiter.boost }); save(); }} />
            </div>
          </div>
          <div class="sig-params">
            <ParamRow key="threshold" label="Threshold" val={state.limiter.threshold} min={-60} max={0} unit="dB" section="limiter" />
            <ParamRow key="knee" label="Knee" val={state.limiter.knee} min={0} max={12} unit="dB" section="limiter" />
            <ParamRow key="lookahead" label="Lookahead" val={state.limiter.lookahead} min={0.1} max={20} unit="ms" section="limiter" />
            <ParamRow key="attack" label="Attack" val={state.limiter.attack} min={0.25} max={20} unit="ms" section="limiter" />
            <ParamRow key="release" label="Release" val={state.limiter.release} min={0.25} max={20} unit="ms" section="limiter" />
            <ParamRow key="sc_preamp" label="SC PreAmp" val={state.limiter.sc_preamp} min={-20} max={40} unit="dB" section="limiter" />
            <ParamRow key="stereo_link" label="Stereo Link" val={state.limiter.stereo_link} min={0} max={100} unit="%" section="limiter" decimals={0} />
            <ParamRow key="input_gain" label="Input" val={state.limiter.input_gain} min={-24} max={24} unit="dB" section="limiter" />
            <ParamRow key="output_gain" label="Output" val={state.limiter.output_gain} min={-24} max={24} unit="dB" section="limiter" />
          </div>
          <div class="sig-alr-section">
            <div class="sig-alr">
              <span class="sig-alr__label">Auto Leveling</span>
              <div class={`sig-tog sig-tog--sm${state.limiter.alr ? " sig-tog--on" : ""}`} onClick={() => { setState("limiter", "alr", !state.limiter.alr); invoke("dsp_set_limiter_alr", { alr: state.limiter.alr }); save(); }} />
            </div>
            <div class="sig-params sig-alr-params">
              <ParamRow key="alr_attack" label="ALR Attack" val={state.limiter.alr_attack} min={0.1} max={200} unit="ms" section="limiter" />
              <ParamRow key="alr_release" label="ALR Release" val={state.limiter.alr_release} min={10} max={1000} unit="ms" section="limiter" decimals={0} />
            </div>
          </div>
        </div>
      </div>

      {/* === Bass Enhancer Section === */}
      <div class="sig-sec">
        <div class="sig-sec-h">
          <span class="sig-sec-t">Bass Enhancer</span>
          <span class="sig-sec-badge">Calf</span>
          <div class={`sig-tog sig-tog--sm${state.bass.enabled ? " sig-tog--on" : ""}`} onClick={() => { setState("bass", "enabled", !state.bass.enabled); invoke("dsp_set_bass_bypass", { bypass: !state.bass.enabled }); save(); }} />
        </div>
        <div class="sig-sec-b">
          <div class="sig-bass-toggles">
            <div class="sig-alr">
              <span class="sig-alr__label">Listen</span>
              <div class={`sig-tog sig-tog--sm${state.bass.listen ? " sig-tog--on" : ""}`} onClick={() => { setState("bass", "listen", !state.bass.listen); invoke("dsp_set_bass_listen", { listen: state.bass.listen }); save(); }} />
            </div>
            <div class="sig-alr">
              <span class="sig-alr__label">Floor</span>
              <div class={`sig-tog sig-tog--sm${state.bass.floor_active ? " sig-tog--on" : ""}`} onClick={() => { setState("bass", "floor_active", !state.bass.floor_active); invoke("dsp_set_bass_floor_active", { active: state.bass.floor_active }); save(); }} />
            </div>
          </div>
          <div class="sig-params">
            <ParamRow key="amount" label="Amount" val={state.bass.amount} min={0} max={64} unit="dB" section="bass" />
            <ParamRow key="drive" label="Harmonics" val={state.bass.drive} min={0.1} max={10} unit="" section="bass" />
            <ParamRow key="blend" label="Blend" val={state.bass.blend} min={-10} max={10} unit="" section="bass" />
            <ParamRow key="freq" label="Scope" val={state.bass.freq} min={10} max={250} unit="Hz" section="bass" decimals={0} />
            <ParamRow key="floor" label="Floor" val={state.bass.floor} min={10} max={120} unit="Hz" section="bass" decimals={0} />
            <ParamRow key="input_gain" label="Input" val={state.bass.input_gain} min={-36} max={36} unit="dB" section="bass" />
            <ParamRow key="output_gain" label="Output" val={state.bass.output_gain} min={-36} max={36} unit="dB" section="bass" />
          </div>
        </div>
      </div>
    </article>
  );
}
