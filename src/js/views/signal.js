// Signal — DSP chain view: Parametric EQ, Limiter, Bass Enhancer.
// Presets with import/export compatible with EasyEffects JSON format.

const { invoke } = window.__TAURI__.core;

const STORAGE_KEY = "rustify-dsp-presets";
const ACTIVE_KEY = "rustify-dsp-active";
const DB_RANGE = 36;

const FILTER_TYPES = ["Off", "Bell", "Hi-pass", "Hi-shelf", "Lo-pass", "Lo-shelf", "Notch", "Resonance", "Allpass", "Bandpass", "Ladder-pass", "Ladder-rej"];
const FILTER_MODES = ["RLC (BT)", "RLC (MT)", "BWC (BT)", "BWC (MT)", "LRX (BT)", "LRX (MT)", "APO (DR)"];
const SLOPES = ["x1", "x2", "x3", "x4"];

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
    limiter: { enabled: true, threshold: 0, knee: 1, lookahead: 5, boost: false, alr: true },
    bass: { enabled: true, amount: 0, drive: 1, blend: 0, freq: 120, floor: 20 },
  };
}

let state = defaultState();
let activeBand = 0;
let canvas, ctx;

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
  _ipcTimer = setTimeout(() => invoke(cmd, args).catch(console.error), delay);
}

async function applyFullState() {
  const { eq, limiter, bass, bypass } = state;
  try {
    await invoke("dsp_set_bypass", { bypass });
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
    await invoke("dsp_set_limiter_threshold", { thresholdDb: limiter.threshold });
    await invoke("dsp_set_limiter_knee", { knee: limiter.knee });
    await invoke("dsp_set_limiter_lookahead", { lookahead: limiter.lookahead });
    await invoke("dsp_set_limiter_boost", { boost: limiter.boost });
    await invoke("dsp_set_bass_amount", { amount: bass.amount });
    await invoke("dsp_set_bass_drive", { drive: bass.drive });
    await invoke("dsp_set_bass_blend", { blend: bass.blend });
    await invoke("dsp_set_bass_freq", { freq: bass.freq });
    await invoke("dsp_set_bass_floor", { floor: bass.floor });
  } catch (e) {
    console.error("[signal] apply state failed:", e);
  }
}

function parseEasyEffects(json, name) {
  const o = json.output || json;
  const preset = {
    name,
    eq: { mode: "IIR", input_gain: 0, output_gain: 0, bands: [] },
    limiter: { threshold: 0, knee: 0, lookahead: 5, boost: 0, alr: true },
    bass_enhancer: { amount: 0, drive: 0, blend: 0, freq: 120, floor: 20 },
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
    };
  }

  const lim = o["limiter#0"];
  if (lim) {
    preset.limiter = {
      threshold: lim.threshold || 0,
      knee: lim.knee || 0,
      lookahead: lim.lookahead || 5,
      boost: lim.boost || 0,
      alr: lim.alr !== false,
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
        "floor-active": true,
        harmonics: be.drive || 0,
        "input-gain": 0,
        "output-gain": 0,
        scope: be.freq || 120,
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
      plugins_order: ["equalizer#0", "bass_enhancer#0"],
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
    paramRowHtml("threshold", "Threshold", state.limiter.threshold, -60, 0, "dBFS", "limiter"),
    paramRowHtml("knee", "Knee", state.limiter.knee, 0, 12, "dB", "limiter"),
    paramRowHtml("lookahead", "Lookahead", state.limiter.lookahead, 0, 20, "ms", "limiter"),
    paramRowHtml("boost", "Boost", state.limiter.boost, 0, 12, "dB", "limiter"),
  ].join("");

  const bassParams = [
    paramRowHtml("amount", "Amount", state.bass.amount, 0, 10, "", "bass"),
    paramRowHtml("drive", "Drive", state.bass.drive, 0, 10, "", "bass"),
    paramRowHtml("blend", "Blend", state.bass.blend, -10, 10, "", "bass"),
    paramRowHtml("freq", "Freq", state.bass.freq, 10, 250, "Hz", "bass", 0),
    paramRowHtml("floor", "Floor", state.bass.floor, 10, 120, "Hz", "bass", 0),
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
        <div class="sig-params">${limiterParams}</div>
        <div class="sig-alr">
          <span class="sig-alr__label">ALR</span>
          <div class="sig-tog sig-tog--on sig-tog--sm${state.limiter.alr ? " sig-tog--on" : ""}" id="sig-alr-tog"></div>
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
        <div class="sig-params">${bassParams}</div>
      </div>
    </div>
  `;

  requestAnimationFrame(() => {
    canvas = view.querySelector("#sig-canvas");
    ctx = canvas?.getContext("2d");
    drawCurve();
    window.addEventListener("resize", drawCurve);
  });

  // Master bypass
  view.querySelector("#sig-bypass")?.addEventListener("click", (e) => {
    state.bypass = !state.bypass;
    e.currentTarget.classList.toggle("sig-tog--on", !state.bypass);
    invoke("dsp_set_bypass", { bypass: state.bypass }).catch(console.error);
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
  });

  view.querySelector("#sig-bd-mode")?.addEventListener("change", (e) => {
    const val = parseInt(e.target.value);
    state.eq.bands[activeBand].filterMode = val;
    invoke("dsp_set_eq_filter_mode", { band: activeBand, mode: val }).catch(console.error);
  });

  view.querySelector("#sig-bd-slope")?.addEventListener("change", (e) => {
    const val = parseInt(e.target.value);
    state.eq.bands[activeBand].slope = val;
    invoke("dsp_set_eq_slope", { band: activeBand, slope: val }).catch(console.error);
  });

  view.querySelector("#sig-bd-solo")?.addEventListener("click", (e) => {
    const b = state.eq.bands[activeBand];
    b.solo = !b.solo;
    e.currentTarget.classList.toggle("is-active", b.solo);
    invoke("dsp_set_eq_solo", { band: activeBand, solo: b.solo }).catch(console.error);
  });

  view.querySelector("#sig-bd-mute")?.addEventListener("click", (e) => {
    const b = state.eq.bands[activeBand];
    b.mute = !b.mute;
    e.currentTarget.classList.toggle("is-active", b.mute);
    invoke("dsp_set_eq_mute", { band: activeBand, mute: b.mute }).catch(console.error);
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
            boost: ["dsp_set_limiter_boost", { boost: val }],
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
          };
          if (ipcMap[key]) ipcDebounced(...ipcMap[key]);
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
  });

  // ALR toggle
  view.querySelector("#sig-alr-tog")?.addEventListener("click", (e) => {
    state.limiter.alr = !state.limiter.alr;
    e.currentTarget.classList.toggle("sig-tog--on", state.limiter.alr);
  });

  // Section toggles (EQ, Limiter, Bass Enhancer enable/disable)
  view.querySelector("#sig-eq-tog")?.addEventListener("click", (e) => {
    state.eq.enabled = !state.eq.enabled;
    e.currentTarget.classList.toggle("sig-tog--on", state.eq.enabled);
    invoke("dsp_set_eq_enabled", { enabled: state.eq.enabled }).catch(console.error);
  });

  view.querySelector("#sig-lim-tog")?.addEventListener("click", (e) => {
    state.limiter.enabled = !state.limiter.enabled;
    e.currentTarget.classList.toggle("sig-tog--on", state.limiter.enabled);
    invoke("dsp_set_limiter_enabled", { enabled: state.limiter.enabled }).catch(console.error);
  });

  view.querySelector("#sig-bass-tog")?.addEventListener("click", (e) => {
    state.bass.enabled = !state.bass.enabled;
    e.currentTarget.classList.toggle("sig-tog--on", state.bass.enabled);
    invoke("dsp_set_bass_bypass", { bypass: !state.bass.enabled }).catch(() => {});
  });

  // Preset selection
  view.querySelector("#sig-presets")?.addEventListener("click", (e) => {
    const chip = e.target.closest(".sig-pre");
    if (!chip) return;
    const name = chip.dataset.preset;
    view.querySelectorAll(".sig-pre").forEach((c) => c.classList.remove("sig-pre--on"));
    chip.classList.add("sig-pre--on");

    if (name === "Flat") {
      state = defaultState();
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
