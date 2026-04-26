// Signal — DSP chain view: Parametric EQ, Limiter, Bass Enhancer.
// Presets with import/export compatible with EasyEffects JSON format.

const { invoke } = window.__TAURI__.core;

const STORAGE_KEY = "rustify-dsp-presets";
const ACTIVE_KEY = "rustify-dsp-active";
const DB_RANGE = 36;

const FILTER_TYPES = ["Off", "Bell", "Hi-pass", "Hi-shelf", "Lo-pass", "Lo-shelf", "Notch", "Resonance", "Allpass", "Bandpass", "Ladder-pass", "Ladder-rej"];
const FILTER_MODES = ["RLC (BT)", "RLC (MT)", "BWC (BT)", "BWC (MT)", "LRX (BT)", "LRX (MT)", "APO (DR)"];
const SLOPES = ["x1", "x2", "x3", "x4"];
const LIMITER_MODES = ["Herm Thin", "Herm Wide", "Herm Tail", "Herm Duck", "Exp Thin", "Exp Wide", "Exp Tail", "Exp Duck"];
const LIMITER_OVS = ["None", "Half x2/16", "Half x2/24", "Half x3/16", "Half x3/24", "Half x4/16", "Half x4/24", "Half x6/16", "Half x6/24", "Half x8/16", "Half x8/24", "Full x2/16", "Full x2/24", "Full x3/16", "Full x3/24", "Full x4/16", "Full x4/24", "Full x6/16", "Full x6/24", "Full x8/16", "Full x8/24"];
const LIMITER_DITHER = ["None", "7bit", "8bit", "11bit", "12bit"];

const DEFAULT_BANDS = [
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

function defaultState() {
  return {
    bypass: false,
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

const STATE_KEY = "rustify-dsp-state";

let state = loadState();
let activeBand = 0;
let canvas, ctx;

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STATE_KEY));
    if (saved) {
      // Merge with defaults to fill any missing keys from older saves
      const def = defaultState();
      return {
        bypass: saved.bypass ?? def.bypass,
        eq: { ...def.eq, ...saved.eq, bands: (saved.eq?.bands || def.eq.bands).map((b, i) => ({ ...def.eq.bands[i], ...b })) },
        limiter: { ...def.limiter, ...saved.limiter },
        bass: { ...def.bass, ...saved.bass },
      };
    }
  } catch {}
  return defaultState();
}

function persistState() {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {}
}

function loadPresets() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}

function savePresets(presets) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(presets));
}

function getActivePresetName() {
  return localStorage.getItem(ACTIVE_KEY) || "";
}

function setActivePresetName(name) {
  localStorage.setItem(ACTIVE_KEY, name);
}

function fmtHz(hz) {
  return hz >= 1000 ? `${(hz / 1000).toFixed(hz >= 10000 ? 0 : 1)}k` : String(hz);
}

function fmtDb(db) {
  const sign = db > 0 ? "+" : "";
  return `${sign}${db.toFixed(1)}`;
}

function fmtVal(val, decimals = 1) {
  return Number(val).toFixed(decimals);
}

let _ipcTimer = null;
function ipcDebounced(cmd, args, delay = 50) {
  clearTimeout(_ipcTimer);
  _ipcTimer = setTimeout(() => {
    invoke(cmd, args).catch(console.error);
    persistState();
  }, delay);
}

/** Apply persisted DSP state to the backend. Called on Signal view mount
 * and also exported for app startup (main.js). */
export async function applyFullState() {
  persistState();
  const { eq, limiter, bass, bypass } = state;
  try {
    await invoke("dsp_set_bypass", { bypass });
    await invoke("dsp_set_eq_enabled", { enabled: eq.enabled });
    await invoke("dsp_set_eq_mode", { mode: eq.mode });
    await invoke("dsp_set_eq_gain", { input: eq.input_gain, output: eq.output_gain });
    for (let i = 0; i < eq.bands.length; i++) {
      const b = eq.bands[i];
      await invoke("dsp_set_eq_band", { band: i, freq: b.freq, gainDb: b.gain_db, q: b.q });
      await invoke("dsp_set_eq_filter_type", { band: i, filterType: b.type });
      await invoke("dsp_set_eq_filter_mode", { band: i, mode: b.filterMode }).catch(() => {});
      await invoke("dsp_set_eq_slope", { band: i, slope: b.slope }).catch(() => {});
      await invoke("dsp_set_eq_solo", { band: i, solo: b.solo }).catch(() => {});
      await invoke("dsp_set_eq_mute", { band: i, mute: b.mute }).catch(() => {});
    }
    await invoke("dsp_set_limiter_enabled", { enabled: limiter.enabled });
    await invoke("dsp_set_limiter_mode", { mode: limiter.mode });
    await invoke("dsp_set_limiter_oversampling", { ovs: limiter.ovs });
    await invoke("dsp_set_limiter_dither", { dither: limiter.dither });
    await invoke("dsp_set_limiter_threshold", { thresholdDb: limiter.threshold });
    await invoke("dsp_set_limiter_knee", { knee: limiter.knee });
    await invoke("dsp_set_limiter_lookahead", { lookahead: limiter.lookahead });
    await invoke("dsp_set_limiter_attack", { attack: limiter.attack });
    await invoke("dsp_set_limiter_release", { release: limiter.release });
    await invoke("dsp_set_limiter_sc_preamp", { preamp: limiter.sc_preamp });
    await invoke("dsp_set_limiter_stereo_link", { link: limiter.stereo_link });
    await invoke("dsp_set_limiter_boost", { boost: limiter.boost });
    await invoke("dsp_set_limiter_gain", { input: limiter.input_gain, output: limiter.output_gain });
    await invoke("dsp_set_limiter_alr", { alr: limiter.alr });
    await invoke("dsp_set_limiter_alr_attack", { attack: limiter.alr_attack });
    await invoke("dsp_set_limiter_alr_release", { release: limiter.alr_release });
    await invoke("dsp_set_bass_bypass", { bypass: !bass.enabled });
    await invoke("dsp_set_bass_amount", { amount: bass.amount });
    await invoke("dsp_set_bass_drive", { drive: bass.drive });
    await invoke("dsp_set_bass_blend", { blend: bass.blend });
    await invoke("dsp_set_bass_freq", { freq: bass.freq });
    await invoke("dsp_set_bass_floor", { floor: bass.floor });
    await invoke("dsp_set_bass_floor_active", { active: bass.floor_active });
    await invoke("dsp_set_bass_listen", { listen: bass.listen });
    await invoke("dsp_set_bass_levels", { input: bass.input_gain, output: bass.output_gain });
  } catch (e) {
    console.error("[signal] apply state failed:", e);
  }
}

function parseEasyEffects(json, name) {
  const o = json.output || json;
  const preset = {
    name,
    eq: { mode: "IIR", input_gain: 0, output_gain: 0, bands: [] },
    limiter: {
      mode: 0, ovs: 0, dither: 0, threshold: 0, knee: 0, lookahead: 5,
      attack: 5, release: 20, sc_preamp: 1, stereo_link: 100,
      boost: false, alr: true, alr_attack: 5, alr_release: 50,
      input_gain: 0, output_gain: 0,
    },
    bass_enhancer: {
      amount: 0, drive: 0, blend: 0, freq: 120, floor: 20,
      floor_active: true, listen: false, input_gain: 0, output_gain: 0,
    },
  };

  const eq = o["equalizer#0"];
  if (eq) {
    preset.eq.mode = eq.mode || "IIR";
    preset.eq.input_gain = eq["input-gain"] || 0;
    preset.eq.output_gain = eq["output-gain"] || 0;
    const left = eq.left || {};
    const numBands = eq["num-bands"] || Object.keys(left).length;
    for (let i = 0; i < numBands; i++) {
      const b = left[`band${i}`];
      if (b) {
        const typeIdx = FILTER_TYPES.indexOf(b.type || "Bell");
        const modeStr = b.mode || "APO (DR)";
        const modeIdx = FILTER_MODES.indexOf(modeStr) >= 0 ? FILTER_MODES.indexOf(modeStr) : 6;
        const slopeIdx = SLOPES.indexOf(b.slope || "x1");
        preset.eq.bands.push({
          freq: b.frequency || 100,
          gain_db: b.gain || 0,
          q: b.q || 2.21,
          type: typeIdx >= 0 ? typeIdx : 1,
          filterMode: modeIdx,
          slope: slopeIdx >= 0 ? slopeIdx : 0,
          solo: b.solo || false,
          mute: b.mute || false,
        });
      }
    }
  }

  const be = o["bass_enhancer#0"];
  if (be) {
    preset.bass_enhancer = {
      amount: be.amount || 0,
      drive: be.harmonics || 0,
      blend: be.blend || 0,
      freq: be.scope || 120,
      floor: be.floor || 20,
      floor_active: be["floor-active"] !== false,
      listen: be.listen || false,
      input_gain: be["input-gain"] || 0,
      output_gain: be["output-gain"] || 0,
    };
  }

  const lim = o["limiter#0"];
  if (lim) {
    preset.limiter = {
      mode: LIMITER_MODES.indexOf(lim.mode) >= 0 ? LIMITER_MODES.indexOf(lim.mode) : 0,
      ovs: lim.ovs || 0,
      dither: lim.dither || 0,
      threshold: lim.threshold || 0,
      knee: lim.knee || 0,
      lookahead: lim.lookahead || 5,
      attack: lim.attack || 5,
      release: lim.release || 20,
      sc_preamp: lim["sidechain-preamp"] || 1,
      stereo_link: lim["stereo-link"] ?? 100,
      boost: !!lim.boost,
      alr: lim.alr !== false,
      alr_attack: lim["alr-attack"] || 5,
      alr_release: lim["alr-release"] || 50,
      input_gain: lim["input-gain"] || 0,
      output_gain: lim["output-gain"] || 0,
    };
  }

  return preset;
}

function toEasyEffects(preset) {
  const bands = preset.eq?.bands || state.eq.bands;
  const left = {};
  const right = {};
  bands.forEach((b, i) => {
    const band = {
      frequency: b.freq,
      gain: b.gain_db,
      mode: FILTER_MODES[b.filterMode] || "APO (DR)",
      mute: b.mute || false,
      q: b.q,
      slope: SLOPES[b.slope] || "x1",
      solo: b.solo || false,
      type: FILTER_TYPES[b.type] || "Bell",
      width: 4.0,
    };
    left[`band${i}`] = { ...band };
    right[`band${i}`] = { ...band };
  });

  const be = preset.bass_enhancer || state.bass;
  const lim = preset.limiter || state.limiter;

  return {
    output: {
      "bass_enhancer#0": {
        amount: be.amount || 0,
        blend: be.blend || 0,
        bypass: false,
        floor: be.floor || 20,
        "floor-active": be.floor_active !== false,
        harmonics: be.drive || 0,
        listen: be.listen || false,
        "input-gain": be.input_gain || 0,
        "output-gain": be.output_gain || 0,
        scope: be.freq || 120,
      },
      "limiter#0": {
        mode: LIMITER_MODES[lim.mode] || "Herm Thin",
        ovs: lim.ovs || 0,
        dither: lim.dither || 0,
        threshold: lim.threshold || 0,
        knee: lim.knee || 0,
        lookahead: lim.lookahead || 5,
        attack: lim.attack || 5,
        release: lim.release || 20,
        "sidechain-preamp": lim.sc_preamp || 1,
        "stereo-link": lim.stereo_link ?? 100,
        boost: !!lim.boost,
        alr: lim.alr || false,
        "alr-attack": lim.alr_attack || 5,
        "alr-release": lim.alr_release || 50,
        "input-gain": lim.input_gain || 0,
        "output-gain": lim.output_gain || 0,
        bypass: false,
      },
      blocklist: [],
      "equalizer#0": {
        balance: 0,
        bypass: false,
        "input-gain": preset.eq?.input_gain || 0,
        left,
        mode: preset.eq?.mode || "IIR",
        "num-bands": bands.length,
        "output-gain": preset.eq?.output_gain || 0,
        right,
      },
      plugins_order: ["equalizer#0", "limiter#0", "bass_enhancer#0"],
    },
  };
}

function applyPresetToState(preset) {
  const bands = preset.eq?.bands || [];
  for (let i = 0; i < 16; i++) {
    if (i < bands.length) {
      state.eq.bands[i] = { ...DEFAULT_BANDS[i], ...bands[i] };
    } else {
      state.eq.bands[i] = { ...DEFAULT_BANDS[i] };
    }
  }

  const modeMap = { IIR: 0, FIR: 1, FFT: 2, SPM: 3 };
  state.eq.mode = modeMap[preset.eq?.mode] ?? 0;
  state.eq.input_gain = preset.eq?.input_gain ?? 0;
  state.eq.output_gain = preset.eq?.output_gain ?? 0;

  if (preset.bypass != null) state.bypass = preset.bypass;
  if (preset.limiter) Object.assign(state.limiter, preset.limiter);
  if (preset.bass_enhancer) Object.assign(state.bass, preset.bass_enhancer);
}

function drawCurve() {
  if (!canvas || !ctx) return;
  const dpr = devicePixelRatio || 1;
  const r = canvas.parentElement.getBoundingClientRect();
  canvas.width = r.width * dpr;
  canvas.height = r.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const w = r.width, h = r.height, mid = h / 2;

  ctx.clearRect(0, 0, w, h);

  ctx.strokeStyle = "rgba(237,234,227,.03)";
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) {
    ctx.beginPath(); ctx.moveTo(0, (h / 5) * i); ctx.lineTo(w, (h / 5) * i); ctx.stroke();
  }
  ctx.strokeStyle = "rgba(237,234,227,.07)";
  ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

  const pts = state.eq.bands.map((b, i) => [
    (i / (state.eq.bands.length - 1)) * w,
    mid - (b.gain_db / DB_RANGE) * (h / 2) * 0.85,
  ]);

  if (pts.length < 2) return;
  ctx.beginPath();
  ctx.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(i + 2, pts.length - 1)];
    ctx.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
      p2[0], p2[1]
    );
  }

  const path = new Path2D();
  path.moveTo(pts[0][0], pts[0][1]);
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(i - 1, 0)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(i + 2, pts.length - 1)];
    path.bezierCurveTo(
      p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
      p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
      p2[0], p2[1]
    );
  }
  path.lineTo(w, mid); path.lineTo(0, mid); path.closePath();
  ctx.fillStyle = "rgba(198,99,61,.06)";
  ctx.fill(path);
  ctx.strokeStyle = "rgba(198,99,61,.6)";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  pts.forEach(([x, y], i) => {
    const active = state.eq.bands[i].gain_db !== 0;
    ctx.beginPath();
    ctx.arc(x, y, active ? 3.5 : 2, 0, Math.PI * 2);
    ctx.fillStyle = i === activeBand
      ? "rgba(198,99,61,1)"
      : active ? "rgba(198,99,61,.7)" : "rgba(142,138,130,.3)";
    ctx.fill();
  });
}

function sliderPct(val, min, max) {
  return ((val - min) / (max - min)) * 100;
}

function paramRowHtml(key, label, val, min, max, unit, section, decimals = 1) {
  const pct = sliderPct(val, min, max);
  return `<div class="sig-param" data-key="${key}" data-min="${min}" data-max="${max}" data-section="${section}">
    <span class="sig-param__label">${label}</span>
    <div class="sig-param__slider">
      <div class="sig-param__track">
        <div class="sig-param__fill" style="width:${pct}%"></div>
        <div class="sig-param__thumb" style="left:${pct}%"></div>
      </div>
    </div>
    <span class="sig-param__val">${fmtVal(val, decimals)}<span class="sig-param__unit">${unit}</span></span>
  </div>`;
}

export function render() {
  const view = document.createElement("article");
  view.className = "view";

  const MODE_NAMES = ["IIR", "FIR", "FFT", "SPM"];

  const fadersHtml = state.eq.bands.map((b, i) => {
    const pct = Math.abs(b.gain_db) / DB_RANGE * 50;
    const thumbPos = 50 + (b.gain_db / DB_RANGE) * 50;
    const fillCls = b.gain_db >= 0 ? "sig-f-fill sig-f-up" : "sig-f-fill sig-f-dn";
    const act = i === activeBand ? " sig-fader--active" : "";
    return `<div class="sig-fader${act}" data-band="${i}">
      <span class="sig-f-hz">${fmtHz(b.freq)}</span>
      <div class="sig-f-track">
        <div class="sig-f-zero"></div>
        ${b.gain_db !== 0 ? `<div class="${fillCls}" style="height:${pct}%"></div>` : ""}
        <div class="sig-f-thumb" style="bottom:${thumbPos}%"></div>
      </div>
      <span class="sig-f-val">${fmtDb(b.gain_db)}</span>
    </div>`;
  }).join("");

  const presets = loadPresets();
  const activePreset = getActivePresetName();
  const presetChips = presets.map((p) =>
    `<span class="sig-pre${p.name === activePreset ? " sig-pre--on" : ""}" data-preset="${p.name}">${p.name}</span>`
  ).join("");

  const limiterParams = [
    paramRowHtml("threshold", "Threshold", state.limiter.threshold, -60, 0, "dB", "limiter"),
    paramRowHtml("knee", "Knee", state.limiter.knee, 0, 12, "dB", "limiter"),
    paramRowHtml("lookahead", "Lookahead", state.limiter.lookahead, 0.1, 20, "ms", "limiter"),
    paramRowHtml("attack", "Attack", state.limiter.attack, 0.25, 20, "ms", "limiter"),
    paramRowHtml("release", "Release", state.limiter.release, 0.25, 20, "ms", "limiter"),
    paramRowHtml("sc_preamp", "SC PreAmp", state.limiter.sc_preamp, -20, 40, "dB", "limiter"),
    paramRowHtml("stereo_link", "Stereo Link", state.limiter.stereo_link, 0, 100, "%", "limiter", 0),
    paramRowHtml("input_gain", "Input", state.limiter.input_gain, -24, 24, "dB", "limiter"),
    paramRowHtml("output_gain", "Output", state.limiter.output_gain, -24, 24, "dB", "limiter"),
  ].join("");

  const bassParams = [
    paramRowHtml("amount", "Amount", state.bass.amount, 0, 64, "dB", "bass"),
    paramRowHtml("drive", "Harmonics", state.bass.drive, 0.1, 10, "", "bass"),
    paramRowHtml("blend", "Blend", state.bass.blend, -10, 10, "", "bass"),
    paramRowHtml("freq", "Scope", state.bass.freq, 10, 250, "Hz", "bass", 0),
    paramRowHtml("floor", "Floor", state.bass.floor, 10, 120, "Hz", "bass", 0),
    paramRowHtml("input_gain", "Input", state.bass.input_gain, -36, 36, "dB", "bass"),
    paramRowHtml("output_gain", "Output", state.bass.output_gain, -36, 36, "dB", "bass"),
  ].join("");

  view.innerHTML = `
    <header class="view__header">
      <h1 class="view__title">Signal</h1>
      <div class="view__stats"><span>DSP Chain</span></div>
      <div class="sig-master">
        <span class="sig-master-lbl">Master</span>
        <div class="sig-tog${state.bypass ? "" : " sig-tog--on"}" id="sig-bypass"></div>
      </div>
    </header>

    <div class="sig-presets" id="sig-presets">
      <div class="sig-presets__chips">
        <span class="sig-pre${!activePreset || activePreset === "Flat" ? " sig-pre--on" : ""}" data-preset="Flat">Flat</span>
        ${presetChips}
      </div>
      <div class="sig-presets__actions">
        <button class="sig-pre-btn" id="sig-save">Save</button>
        <button class="sig-pre-btn" id="sig-rename">Rename</button>
        <button class="sig-pre-btn" id="sig-delete">Delete</button>
        <button class="sig-pre-btn" id="sig-import">Import</button>
        <button class="sig-pre-btn" id="sig-export">Export</button>
      </div>
    </div>

    <div class="sig-chain">
      <span class="sig-ch-n">Source</span><span class="sig-ch-a">→</span>
      <span class="sig-ch-n">Decode</span><span class="sig-ch-a">→</span>
      <span class="sig-ch-n sig-ch-n--on">Parametric EQ</span><span class="sig-ch-a">→</span>
      <span class="sig-ch-n sig-ch-n--on">Limiter</span><span class="sig-ch-a">→</span>
      <span class="sig-ch-n sig-ch-n--on">Bass Enhance</span><span class="sig-ch-a">→</span>
      <span class="sig-ch-n">PipeWire</span>
    </div>

    <div class="sig-sec">
      <div class="sig-sec-h">
        <span class="sig-sec-t">Parametric Equalizer</span>
        <span class="sig-sec-badge">LSP x16 Stereo</span>
        <div class="sig-tog${state.eq.enabled ? " sig-tog--on" : ""} sig-tog--sm" id="sig-eq-tog"></div>
      </div>
      <div class="sig-sec-b">
        <div class="sig-eq-wrap"><canvas id="sig-canvas"></canvas>
          <div class="sig-eq-yaxis"><span>+36</span><span>+18</span><span>0</span><span>−18</span><span>−36</span></div>
        </div>
        <div class="sig-eq-xaxis"><span>20</span><span>50</span><span>100</span><span>200</span><span>500</span><span>1k</span><span>2k</span><span>5k</span><span>10k</span><span>20k</span></div>
        <div class="sig-faders" id="sig-faders">${fadersHtml}</div>
        <div class="sig-bd" id="sig-bd">
          <div class="sig-bd__ctx">
            <span class="sig-bd__band">Band ${activeBand + 1}</span>
            <span class="sig-bd__sep">&middot;</span>
            <span class="sig-bd__freq">${fmtHz(state.eq.bands[activeBand].freq)} Hz</span>
            <span class="sig-bd__sep">&middot;</span>
            <span class="sig-bd__type" id="sig-bd-type-label">${FILTER_TYPES[state.eq.bands[activeBand].type]}</span>
          </div>
          <div class="sig-bd__ctrls">
            <label class="sig-bd__lbl">Type
              <select class="sig-bd-select" id="sig-bd-type">
                ${FILTER_TYPES.map((t, i) => `<option value="${i}"${i === state.eq.bands[activeBand].type ? " selected" : ""}>${t}</option>`).join("")}
              </select>
            </label>
            <label class="sig-bd__lbl">Mode
              <select class="sig-bd-select" id="sig-bd-mode">
                ${FILTER_MODES.map((m, i) => `<option value="${i}"${i === state.eq.bands[activeBand].filterMode ? " selected" : ""}>${m}</option>`).join("")}
              </select>
            </label>
            <label class="sig-bd__lbl">Slope
              <select class="sig-bd-select" id="sig-bd-slope">
                ${SLOPES.map((s, i) => `<option value="${i}"${i === state.eq.bands[activeBand].slope ? " selected" : ""}>${s}</option>`).join("")}
              </select>
            </label>
            <span class="sig-bd__q">Q: <b>${state.eq.bands[activeBand].q.toFixed(2)}</b></span>
            <div class="sig-bd__toggles">
              <button class="sig-bd-sm sig-bd-sm--solo${state.eq.bands[activeBand].solo ? " is-active" : ""}" id="sig-bd-solo" title="Solo">S</button>
              <button class="sig-bd-sm sig-bd-sm--mute${state.eq.bands[activeBand].mute ? " is-active" : ""}" id="sig-bd-mute" title="Mute">M</button>
            </div>
          </div>
        </div>
        <div class="sig-eq-foot">
          <div>
            <div class="sig-foot-lbl">Mode</div>
            <div class="sig-modes" id="sig-modes">
              ${MODE_NAMES.map((m, i) => `<button class="sig-md${i === state.eq.mode ? " sig-md--on" : ""}" data-mode="${i}">${m}</button>`).join("")}
            </div>
          </div>
          <div class="sig-eq-gains">
            ${paramRowHtml("input_gain", "Input", state.eq.input_gain, -12, 12, "dB", "eq-gain")}
            ${paramRowHtml("output_gain", "Output", state.eq.output_gain, -12, 12, "dB", "eq-gain")}
          </div>
        </div>
      </div>
    </div>

    <div class="sig-sec">
      <div class="sig-sec-h">
        <span class="sig-sec-t">Limiter</span>
        <span class="sig-sec-badge">LSP Stereo</span>
        <div class="sig-tog${state.limiter.enabled ? " sig-tog--on" : ""} sig-tog--sm" id="sig-lim-tog"></div>
      </div>
      <div class="sig-sec-b">
        <div class="sig-lim-selects">
          <label class="sig-bd__lbl">Mode
            <select class="sig-bd-select" id="sig-lim-mode">
              ${LIMITER_MODES.map((m, i) => `<option value="${i}"${i === state.limiter.mode ? " selected" : ""}>${m}</option>`).join("")}
            </select>
          </label>
          <label class="sig-bd__lbl">Oversampling
            <select class="sig-bd-select" id="sig-lim-ovs">
              ${LIMITER_OVS.map((m, i) => `<option value="${i}"${i === state.limiter.ovs ? " selected" : ""}>${m}</option>`).join("")}
            </select>
          </label>
          <label class="sig-bd__lbl">Dither
            <select class="sig-bd-select" id="sig-lim-dither">
              ${LIMITER_DITHER.map((m, i) => `<option value="${i}"${i === state.limiter.dither ? " selected" : ""}>${m}</option>`).join("")}
            </select>
          </label>
          <div class="sig-lim-toggles">
            <span class="sig-alr__label">Boost</span>
            <div class="sig-tog${state.limiter.boost ? " sig-tog--on" : ""} sig-tog--sm" id="sig-lim-boost"></div>
          </div>
        </div>
        <div class="sig-params">${limiterParams}</div>
        <div class="sig-alr-section">
          <div class="sig-alr">
            <span class="sig-alr__label">Auto Leveling</span>
            <div class="sig-tog${state.limiter.alr ? " sig-tog--on" : ""} sig-tog--sm" id="sig-alr-tog"></div>
          </div>
          <div class="sig-params sig-alr-params">
            ${paramRowHtml("alr_attack", "ALR Attack", state.limiter.alr_attack, 0.1, 200, "ms", "limiter")}
            ${paramRowHtml("alr_release", "ALR Release", state.limiter.alr_release, 10, 1000, "ms", "limiter", 0)}
          </div>
        </div>
      </div>
    </div>

    <div class="sig-sec">
      <div class="sig-sec-h">
        <span class="sig-sec-t">Bass Enhancer</span>
        <span class="sig-sec-badge">Calf</span>
        <div class="sig-tog${state.bass.enabled ? " sig-tog--on" : ""} sig-tog--sm" id="sig-bass-tog"></div>
      </div>
      <div class="sig-sec-b">
        <div class="sig-bass-toggles">
          <div class="sig-alr">
            <span class="sig-alr__label">Listen</span>
            <div class="sig-tog${state.bass.listen ? " sig-tog--on" : ""} sig-tog--sm" id="sig-bass-listen"></div>
          </div>
          <div class="sig-alr">
            <span class="sig-alr__label">Floor</span>
            <div class="sig-tog${state.bass.floor_active ? " sig-tog--on" : ""} sig-tog--sm" id="sig-bass-floor-active"></div>
          </div>
        </div>
        <div class="sig-params">${bassParams}</div>
      </div>
    </div>
  `;

  requestAnimationFrame(() => {
    canvas = view.querySelector("#sig-canvas");
    ctx = canvas?.getContext("2d");
    drawCurve();
    window.addEventListener("resize", drawCurve);
    // Sync backend with persisted state on first mount
    applyFullState();
  });

  // Master bypass
  view.querySelector("#sig-bypass")?.addEventListener("click", (e) => {
    state.bypass = !state.bypass;
    e.currentTarget.classList.toggle("sig-tog--on", !state.bypass);
    invoke("dsp_set_bypass", { bypass: state.bypass }).catch(console.error);
    persistState();
  });

  // EQ fader drag
  const fadersEl = view.querySelector("#sig-faders");
  fadersEl?.addEventListener("mousedown", (e) => {
    const thumb = e.target.closest(".sig-f-thumb");
    const fader = e.target.closest(".sig-fader");
    if (!fader) return;

    const band = parseInt(fader.dataset.band);
    activeBand = band;
    fadersEl.querySelectorAll(".sig-fader").forEach((f) => f.classList.remove("sig-fader--active"));
    fader.classList.add("sig-fader--active");

    if (!thumb) { drawCurve(); updateBandDetail(view); return; }

    const track = fader.querySelector(".sig-f-track");
    const trackRect = track.getBoundingClientRect();

    const onMove = (ev) => {
      const relY = 1 - (ev.clientY - trackRect.top) / trackRect.height;
      const db = Math.round(((relY - 0.5) * 2 * DB_RANGE) * 10) / 10;
      const clamped = Math.max(-DB_RANGE, Math.min(DB_RANGE, db));
      state.eq.bands[band].gain_db = clamped;
      updateFader(fader, band);
      drawCurve();
      ipcDebounced("dsp_set_eq_band", {
        band, freq: state.eq.bands[band].freq, gainDb: clamped, q: state.eq.bands[band].q,
      });
    };

    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };

    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  });

  // Double-click gain value to type a precise number
  fadersEl?.addEventListener("dblclick", (e) => {
    const valEl = e.target.closest(".sig-f-val");
    if (!valEl) return;
    const fader = valEl.closest(".sig-fader");
    if (!fader) return;
    const band = parseInt(fader.dataset.band);

    const current = state.eq.bands[band].gain_db;
    const input = document.createElement("input");
    input.type = "number";
    input.className = "sig-f-input";
    input.value = current.toFixed(1);
    input.step = "0.1";
    input.min = -DB_RANGE;
    input.max = DB_RANGE;
    valEl.textContent = "";
    valEl.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const val = parseFloat(input.value);
      if (!isNaN(val)) {
        const clamped = Math.max(-DB_RANGE, Math.min(DB_RANGE, Math.round(val * 10) / 10));
        state.eq.bands[band].gain_db = clamped;
        updateFader(fader, band);
        drawCurve();
        invoke("dsp_set_eq_band", {
          band, freq: state.eq.bands[band].freq, gainDb: clamped, q: state.eq.bands[band].q,
        }).catch(console.error);
      } else {
        valEl.textContent = fmtDb(current);
      }
      if (input.parentElement) input.remove();
      if (!valEl.textContent) valEl.textContent = fmtDb(state.eq.bands[band].gain_db);
    };

    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") { ev.preventDefault(); input.blur(); }
      if (ev.key === "Escape") { input.value = current.toFixed(1); input.blur(); }
    });
  });

  // Band detail panel controls
  view.querySelector("#sig-bd-type")?.addEventListener("change", (e) => {
    const val = parseInt(e.target.value);
    state.eq.bands[activeBand].type = val;
    const label = view.querySelector("#sig-bd-type-label");
    if (label) label.textContent = FILTER_TYPES[val];
    invoke("dsp_set_eq_filter_type", { band: activeBand, filterType: val }).catch(console.error);
    persistState();
  });

  view.querySelector("#sig-bd-mode")?.addEventListener("change", (e) => {
    const val = parseInt(e.target.value);
    state.eq.bands[activeBand].filterMode = val;
    invoke("dsp_set_eq_filter_mode", { band: activeBand, mode: val }).catch(console.error);
    persistState();
  });

  view.querySelector("#sig-bd-slope")?.addEventListener("change", (e) => {
    const val = parseInt(e.target.value);
    state.eq.bands[activeBand].slope = val;
    invoke("dsp_set_eq_slope", { band: activeBand, slope: val }).catch(console.error);
    persistState();
  });

  view.querySelector("#sig-bd-solo")?.addEventListener("click", (e) => {
    const b = state.eq.bands[activeBand];
    b.solo = !b.solo;
    e.currentTarget.classList.toggle("is-active", b.solo);
    invoke("dsp_set_eq_solo", { band: activeBand, solo: b.solo }).catch(console.error);
    persistState();
  });

  view.querySelector("#sig-bd-mute")?.addEventListener("click", (e) => {
    const b = state.eq.bands[activeBand];
    b.mute = !b.mute;
    e.currentTarget.classList.toggle("is-active", b.mute);
    invoke("dsp_set_eq_mute", { band: activeBand, mute: b.mute }).catch(console.error);
    persistState();
  });

  // Parameter slider drag (Limiter + Bass)
  view.querySelectorAll(".sig-param").forEach((row) => {
    const slider = row.querySelector(".sig-param__slider");
    if (!slider) return;

    const startDrag = (e) => {
      const key = row.dataset.key;
      const min = parseFloat(row.dataset.min);
      const max = parseFloat(row.dataset.max);
      const section = row.dataset.section;
      const track = slider.querySelector(".sig-param__track");

      const update = (ev) => {
        const rect = track.getBoundingClientRect();
        const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
        const val = Math.round((min + pct * (max - min)) * 10) / 10;

        if (section === "limiter") {
          state.limiter[key] = val;
          const ipcMap = {
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
          if (ipcMap[key]) ipcDebounced(...ipcMap[key]);
        } else if (section === "bass") {
          state.bass[key] = val;
          const ipcMap = {
            amount: ["dsp_set_bass_amount", { amount: val }],
            drive: ["dsp_set_bass_drive", { drive: val }],
            blend: ["dsp_set_bass_blend", { blend: val }],
            freq: ["dsp_set_bass_freq", { freq: val }],
            floor: ["dsp_set_bass_floor", { floor: val }],
            input_gain: ["dsp_set_bass_levels", { input: val, output: state.bass.output_gain }],
            output_gain: ["dsp_set_bass_levels", { input: state.bass.input_gain, output: val }],
          };
          if (ipcMap[key]) ipcDebounced(...ipcMap[key]);
        } else if (section === "eq-gain") {
          state.eq[key] = val;
          ipcDebounced("dsp_set_eq_gain", { input: state.eq.input_gain, output: state.eq.output_gain });
        }

        const fill = row.querySelector(".sig-param__fill");
        const thumb = row.querySelector(".sig-param__thumb");
        const valEl = row.querySelector(".sig-param__val");
        const unit = valEl.querySelector(".sig-param__unit")?.textContent || "";
        const decimals = (key === "freq" || key === "floor") ? 0 : 1;
        fill.style.width = `${pct * 100}%`;
        thumb.style.left = `${pct * 100}%`;
        valEl.innerHTML = `${fmtVal(val, decimals)}<span class="sig-param__unit">${unit}</span>`;
      };

      update(e);
      const onMove = (ev) => update(ev);
      const onUp = () => {
        window.removeEventListener("pointermove", onMove);
        window.removeEventListener("pointerup", onUp);
      };
      window.addEventListener("pointermove", onMove);
      window.addEventListener("pointerup", onUp);
    };

    slider.addEventListener("pointerdown", startDrag);
  });

  // Mode selector
  view.querySelector("#sig-modes")?.addEventListener("click", (e) => {
    const btn = e.target.closest(".sig-md");
    if (!btn) return;
    const mode = parseInt(btn.dataset.mode);
    state.eq.mode = mode;
    view.querySelectorAll(".sig-md").forEach((b) => b.classList.remove("sig-md--on"));
    btn.classList.add("sig-md--on");
    invoke("dsp_set_eq_mode", { mode }).catch(console.error);
    persistState();
  });

  // Limiter mode/ovs/dither selects
  view.querySelector("#sig-lim-mode")?.addEventListener("change", (e) => {
    state.limiter.mode = parseInt(e.target.value);
    invoke("dsp_set_limiter_mode", { mode: state.limiter.mode }).catch(console.error);
    persistState();
  });
  view.querySelector("#sig-lim-ovs")?.addEventListener("change", (e) => {
    state.limiter.ovs = parseInt(e.target.value);
    invoke("dsp_set_limiter_oversampling", { ovs: state.limiter.ovs }).catch(console.error);
    persistState();
  });
  view.querySelector("#sig-lim-dither")?.addEventListener("change", (e) => {
    state.limiter.dither = parseInt(e.target.value);
    invoke("dsp_set_limiter_dither", { dither: state.limiter.dither }).catch(console.error);
    persistState();
  });

  // Limiter boost toggle
  view.querySelector("#sig-lim-boost")?.addEventListener("click", (e) => {
    state.limiter.boost = !state.limiter.boost;
    e.currentTarget.classList.toggle("sig-tog--on", state.limiter.boost);
    invoke("dsp_set_limiter_boost", { boost: state.limiter.boost }).catch(console.error);
    persistState();
  });

  // ALR toggle
  view.querySelector("#sig-alr-tog")?.addEventListener("click", (e) => {
    state.limiter.alr = !state.limiter.alr;
    e.currentTarget.classList.toggle("sig-tog--on", state.limiter.alr);
    invoke("dsp_set_limiter_alr", { alr: state.limiter.alr }).catch(console.error);
    persistState();
  });

  // Section toggles (EQ, Limiter, Bass Enhancer enable/disable)
  view.querySelector("#sig-eq-tog")?.addEventListener("click", (e) => {
    state.eq.enabled = !state.eq.enabled;
    e.currentTarget.classList.toggle("sig-tog--on", state.eq.enabled);
    invoke("dsp_set_eq_enabled", { enabled: state.eq.enabled }).catch(console.error);
    persistState();
  });

  view.querySelector("#sig-lim-tog")?.addEventListener("click", (e) => {
    state.limiter.enabled = !state.limiter.enabled;
    e.currentTarget.classList.toggle("sig-tog--on", state.limiter.enabled);
    invoke("dsp_set_limiter_enabled", { enabled: state.limiter.enabled }).catch(console.error);
    persistState();
  });

  view.querySelector("#sig-bass-tog")?.addEventListener("click", (e) => {
    state.bass.enabled = !state.bass.enabled;
    e.currentTarget.classList.toggle("sig-tog--on", state.bass.enabled);
    invoke("dsp_set_bass_bypass", { bypass: !state.bass.enabled }).catch(() => {});
    persistState();
  });

  view.querySelector("#sig-bass-listen")?.addEventListener("click", (e) => {
    state.bass.listen = !state.bass.listen;
    e.currentTarget.classList.toggle("sig-tog--on", state.bass.listen);
    invoke("dsp_set_bass_listen", { listen: state.bass.listen }).catch(console.error);
    persistState();
  });

  view.querySelector("#sig-bass-floor-active")?.addEventListener("click", (e) => {
    state.bass.floor_active = !state.bass.floor_active;
    e.currentTarget.classList.toggle("sig-tog--on", state.bass.floor_active);
    invoke("dsp_set_bass_floor_active", { active: state.bass.floor_active }).catch(console.error);
    persistState();
  });

  // Preset selection
  view.querySelector("#sig-presets")?.addEventListener("click", (e) => {
    const chip = e.target.closest(".sig-pre");
    if (!chip) return;
    const name = chip.dataset.preset;
    view.querySelectorAll(".sig-pre").forEach((c) => c.classList.remove("sig-pre--on"));
    chip.classList.add("sig-pre--on");

    if (name === "Flat") {
      Object.assign(state, defaultState());
      setActivePresetName("Flat");
    } else {
      const presets = loadPresets();
      const p = presets.find((x) => x.name === name);
      if (p) {
        applyPresetToState(p);
        setActivePresetName(name);
      }
    }
    applyFullState();
    rerender(view);
  });

  // Save
  view.querySelector("#sig-save")?.addEventListener("click", async () => {
    const name = prompt("Preset name:");
    if (!name) return;
    const presets = loadPresets();
    const existing = presets.findIndex((p) => p.name === name);
    const preset = {
      name,
      bypass: state.bypass,
      eq: JSON.parse(JSON.stringify(state.eq)),
      limiter: { ...state.limiter },
      bass_enhancer: { ...state.bass },
    };
    if (existing >= 0) presets[existing] = preset;
    else presets.push(preset);
    savePresets(presets);
    setActivePresetName(name);
    rerender(view);
  });

  // Rename active preset
  view.querySelector("#sig-rename")?.addEventListener("click", () => {
    const current = getActivePresetName();
    if (!current || current === "Flat") return;
    const newName = prompt("Rename preset:", current);
    if (!newName || newName === current) return;
    const presets = loadPresets();
    const idx = presets.findIndex((p) => p.name === current);
    if (idx >= 0) {
      presets[idx].name = newName;
      savePresets(presets);
      setActivePresetName(newName);
      rerender(view);
    }
  });

  // Delete active preset
  view.querySelector("#sig-delete")?.addEventListener("click", () => {
    const current = getActivePresetName();
    if (!current || current === "Flat") return;
    if (!confirm(`Delete preset "${current}"?`)) return;
    const presets = loadPresets();
    const filtered = presets.filter((p) => p.name !== current);
    savePresets(filtered);
    setActivePresetName("Flat");
    Object.assign(state, defaultState());
    applyFullState();
    rerender(view);
  });

  // Import
  view.querySelector("#sig-import")?.addEventListener("click", async () => {
    try {
      const { open } = window.__TAURI__.dialog;
      const path = await open({
        filters: [{ name: "EasyEffects Preset", extensions: ["json"] }],
        defaultPath: "~/.config/easyeffects/output",
      });
      if (!path) return;
      const { readTextFile } = window.__TAURI__.fs;
      const text = await readTextFile(path);
      const json = JSON.parse(text);
      const fileName = path.split("/").pop().replace(".json", "");
      const preset = parseEasyEffects(json, fileName);
      const presets = loadPresets();
      const existing = presets.findIndex((p) => p.name === preset.name);
      if (existing >= 0) presets[existing] = preset;
      else presets.push(preset);
      savePresets(presets);
      applyPresetToState(preset);
      setActivePresetName(preset.name);
      applyFullState();
      rerender(view);
    } catch (e) {
      console.error("[signal] import failed:", e);
    }
  });

  // Export
  view.querySelector("#sig-export")?.addEventListener("click", async () => {
    try {
      const { save } = window.__TAURI__.dialog;
      const path = await save({
        filters: [{ name: "EasyEffects Preset", extensions: ["json"] }],
        defaultPath: `${getActivePresetName() || "rustify-preset"}.json`,
      });
      if (!path) return;
      const eePreset = toEasyEffects({
        name: getActivePresetName(),
        eq: state.eq,
        limiter: state.limiter,
        bass_enhancer: state.bass,
      });
      const { writeTextFile } = window.__TAURI__.fs;
      await writeTextFile(path, JSON.stringify(eePreset, null, 4));
    } catch (e) {
      console.error("[signal] export failed:", e);
    }
  });

  return view;
}

function updateBandDetail(view) {
  const b = state.eq.bands[activeBand];
  const ctx = view.querySelector(".sig-bd__ctx");
  if (ctx) {
    ctx.innerHTML = `<span class="sig-bd__band">Band ${activeBand + 1}</span>`
      + `<span class="sig-bd__sep">&middot;</span>`
      + `<span class="sig-bd__freq">${fmtHz(b.freq)} Hz</span>`
      + `<span class="sig-bd__sep">&middot;</span>`
      + `<span class="sig-bd__type" id="sig-bd-type-label">${FILTER_TYPES[b.type]}</span>`;
  }
  const typeEl = view.querySelector("#sig-bd-type");
  if (typeEl) typeEl.value = b.type;
  const modeEl = view.querySelector("#sig-bd-mode");
  if (modeEl) modeEl.value = b.filterMode;
  const slopeEl = view.querySelector("#sig-bd-slope");
  if (slopeEl) slopeEl.value = b.slope;
  const qEl = view.querySelector(".sig-bd__q");
  if (qEl) qEl.innerHTML = `Q: <b>${b.q.toFixed(2)}</b>`;
  const soloEl = view.querySelector("#sig-bd-solo");
  if (soloEl) soloEl.classList.toggle("is-active", b.solo);
  const muteEl = view.querySelector("#sig-bd-mute");
  if (muteEl) muteEl.classList.toggle("is-active", b.mute);
}

function updateFader(el, band) {
  const b = state.eq.bands[band];
  const pct = Math.abs(b.gain_db) / DB_RANGE * 50;
  const thumbPos = 50 + (b.gain_db / DB_RANGE) * 50;

  const track = el.querySelector(".sig-f-track");
  track.querySelectorAll(".sig-f-fill").forEach((f) => f.remove());

  if (b.gain_db !== 0) {
    const fill = document.createElement("div");
    fill.className = b.gain_db > 0 ? "sig-f-fill sig-f-up" : "sig-f-fill sig-f-dn";
    fill.style.height = `${pct}%`;
    track.appendChild(fill);
  }

  const thumb = track.querySelector(".sig-f-thumb");
  thumb.style.bottom = `${thumbPos}%`;

  el.querySelector(".sig-f-val").textContent = fmtDb(b.gain_db);
}

function rerender(view) {
  const parent = view.parentElement;
  if (parent) {
    const newView = render();
    parent.replaceChildren(newView);
  }
}
