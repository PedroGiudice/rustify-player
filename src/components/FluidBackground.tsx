/*
 * FluidBackground.tsx — WebGL2 fluid simulation driven by audio FFT.
 * Based on Pavel Dobryakov's WebGL-Fluid-Simulation (MIT License).
 * https://github.com/PavelDoGreat/WebGL-Fluid-Simulation
 *
 * Shape-guided: splats emit from bright regions of the shape image,
 * following Sobel gradient directions. The fluid flows along the
 * contours of the shape (e.g., flames rise, nebulas swirl).
 *
 * Background pass renders the shape image darkened behind the fluid.
 */

import { onMount, onCleanup, createEffect } from "solid-js";
import { onAudioFft, spectrumSubscribe, spectrumUnsubscribe, getTrackColor, FftPayload } from "../tauri";
import { player } from "../store/player";

// ── Fluid config ──

// Mutable config — updated from YAML via props.config
const fluidCfg = {
  SIM_RESOLUTION: 128,         // Canonical Pavel default — do not raise
  DYE_RESOLUTION: 1024,
  DENSITY_DISSIPATION: 0.5,    // Slow decay — preserves trails through musical lulls
  VELOCITY_DISSIPATION: 0.15,  // Velocity persists — coherent vortices, no flash-and-die
  PRESSURE: 0.8,
  PRESSURE_ITERATIONS: 25,
  CURL: 40,                    // Stronger vortices, more swirl per impulse
  SPLAT_RADIUS: 0.18,          // Slightly larger — ghost cursors paint smoother trails
  SPLAT_FORCE: 600,            // Higher base force — modulated down by audio
  COLOR_INTENSITY: 0.6,        // Per-frame contribution; integrated over many splats
  SENSITIVITY: 1.0,
  // Peak-trigger / colour calibration (mirrored from YAML; live-tunable)
  PEAK_THRESHOLD: 1.25,
  DELTA_THRESHOLD: 0.06,
  JITTER_AMOUNT: 0.10,
  HUE_JITTER: 0.14,
  SAT_BASE: 0.75,
  SAT_JITTER: 0.10,
};

// ── FFT config ──

const RAW_BANDS = 1024;
const LOG_BANDS = 128;
const AGC_DECAY = 0.985;
const AGC_FLOOR = 3.0;

// ── Ghost cursors (Lissajous) ──
// Three virtual pointers traverse the canvas continuously. Audio modulates
// only force and radius — never position or trigger. Each ghost is anchored
// to a frequency band so sub-bass, mids and treble produce spatially
// distinguishable swirls.

interface Ghost {
  band: "bass" | "mid" | "treble";
  freqA: number;     // angular speed on X (rad/s)
  freqB: number;     // angular speed on Y (rad/s)
  phaseA: number;    // phase offset on X (rad)
  ampX: number;      // X amplitude in 0..1 canvas units
  ampY: number;      // Y amplitude in 0..1 canvas units
  baseRadius: number;
  baseForce: number;
  hueOffset: number; // 0..1, added to baseHue
}

const GHOSTS: Ghost[] = [
  { band: "bass",   freqA: 0.27, freqB: 0.41, phaseA: 0,            ampX: 0.32, ampY: 0.30, baseRadius: 0.22, baseForce: 700, hueOffset: 0.00 },
  { band: "mid",    freqA: 0.55, freqB: 0.83, phaseA: Math.PI / 2,  ampX: 0.40, ampY: 0.22, baseRadius: 0.14, baseForce: 450, hueOffset: 0.33 },
  { band: "treble", freqA: 0.97, freqB: 1.31, phaseA: Math.PI,      ampX: 0.25, ampY: 0.36, baseRadius: 0.09, baseForce: 280, hueOffset: 0.66 },
];

// Temporal smoothing factor for band energies. Lower = snappier audio→visual
// sync, but more jitter. 0.55 → ~40ms tau, perceptually in-sync with kicks
// and percussion (humans sense audio↔visual desync above ~50ms).
const BAND_SMOOTH = 0.55;

// ── Shader sources ──

const baseVertexShaderSrc = `
  precision highp float;
  attribute vec2 aPosition;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform vec2 texelSize;
  void main () {
    vUv = aPosition * 0.5 + 0.5;
    vL = vUv - vec2(texelSize.x, 0.0);
    vR = vUv + vec2(texelSize.x, 0.0);
    vT = vUv + vec2(0.0, texelSize.y);
    vB = vUv - vec2(0.0, texelSize.y);
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const splatShaderSrc = `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  uniform sampler2D uTarget;
  uniform float aspectRatio;
  uniform vec3 color;
  uniform vec2 point;
  uniform float radius;
  void main () {
    vec2 p = vUv - point.xy;
    p.x *= aspectRatio;
    vec3 splat = exp(-dot(p, p) / radius) * color;
    vec3 base = texture2D(uTarget, vUv).xyz;
    gl_FragColor = vec4(base + splat, 1.0);
  }
`;

const advectionShaderSrc = `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  uniform sampler2D uVelocity;
  uniform sampler2D uSource;
  uniform sampler2D uShapeMask;  // Shape brightness: fluid lives where bright, dies where dark
  uniform float uMaskEnabled;    // 1.0 = mask active, 0.0 = no mask (no shape loaded)
  uniform vec2 texelSize;
  uniform vec2 dyeTexelSize;
  uniform float dt;
  uniform float dissipation;
  void main () {
    vec2 coord = vUv - dt * texture2D(uVelocity, vUv).xy * texelSize;
    vec4 result = texture2D(uSource, coord);
    float decay = 1.0 + dissipation * dt;
    result = result / decay;
    // Shape mask: fluid outside bright areas decays faster (but gently)
    if (uMaskEnabled > 0.5) {
      float mask = texture2D(uShapeMask, vUv).r;
      // Remap: 0.0 (dark) → 0.7 (gentle fade), 1.0 (bright) → 1.0 (full life)
      // High floor so fluid remains visible as it drifts beyond the shape
      float maskFactor = 0.7 + mask * 0.3;
      result *= maskFactor;
    }
    gl_FragColor = result;
  }
`;

const divergenceShaderSrc = `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  varying highp vec2 vL;
  varying highp vec2 vR;
  varying highp vec2 vT;
  varying highp vec2 vB;
  uniform sampler2D uVelocity;
  void main () {
    float L = texture2D(uVelocity, vL).x;
    float R = texture2D(uVelocity, vR).x;
    float T = texture2D(uVelocity, vT).y;
    float B = texture2D(uVelocity, vB).y;
    vec2 C = texture2D(uVelocity, vUv).xy;
    if (vL.x < 0.0) { L = -C.x; }
    if (vR.x > 1.0) { R = -C.x; }
    if (vT.y > 1.0) { T = -C.y; }
    if (vB.y < 0.0) { B = -C.y; }
    float div = 0.5 * (R - L + T - B);
    gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
  }
`;

const curlShaderSrc = `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  varying highp vec2 vL;
  varying highp vec2 vR;
  varying highp vec2 vT;
  varying highp vec2 vB;
  uniform sampler2D uVelocity;
  void main () {
    float L = texture2D(uVelocity, vL).y;
    float R = texture2D(uVelocity, vR).y;
    float T = texture2D(uVelocity, vT).x;
    float B = texture2D(uVelocity, vB).x;
    float vorticity = R - L - T + B;
    gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
  }
`;

const vorticityShaderSrc = `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  varying vec2 vL;
  varying vec2 vR;
  varying vec2 vT;
  varying vec2 vB;
  uniform sampler2D uVelocity;
  uniform sampler2D uCurl;
  uniform float curl;
  uniform float dt;
  void main () {
    float L = texture2D(uCurl, vL).x;
    float R = texture2D(uCurl, vR).x;
    float T = texture2D(uCurl, vT).x;
    float B = texture2D(uCurl, vB).x;
    float C = texture2D(uCurl, vUv).x;
    vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
    force /= length(force) + 0.0001;
    force *= curl * C;
    force.y *= -1.0;
    vec2 velocity = texture2D(uVelocity, vUv).xy;
    velocity += force * dt;
    velocity = min(max(velocity, -1000.0), 1000.0);
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`;

const pressureShaderSrc = `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  varying highp vec2 vL;
  varying highp vec2 vR;
  varying highp vec2 vT;
  varying highp vec2 vB;
  uniform sampler2D uPressure;
  uniform sampler2D uDivergence;
  void main () {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    float divergence = texture2D(uDivergence, vUv).x;
    float pressure = (L + R + B + T - divergence) * 0.25;
    gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
  }
`;

const gradientSubtractShaderSrc = `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  varying highp vec2 vL;
  varying highp vec2 vR;
  varying highp vec2 vT;
  varying highp vec2 vB;
  uniform sampler2D uPressure;
  uniform sampler2D uVelocity;
  void main () {
    float L = texture2D(uPressure, vL).x;
    float R = texture2D(uPressure, vR).x;
    float T = texture2D(uPressure, vT).x;
    float B = texture2D(uPressure, vB).x;
    vec2 velocity = texture2D(uVelocity, vUv).xy;
    velocity.xy -= vec2(R - L, T - B);
    gl_FragColor = vec4(velocity, 0.0, 1.0);
  }
`;

const clearShaderSrc = `
  precision mediump float;
  precision mediump sampler2D;
  varying highp vec2 vUv;
  uniform sampler2D uTexture;
  uniform float value;
  void main () {
    gl_FragColor = value * texture2D(uTexture, vUv);
  }
`;

const displayShaderSrc = `
  precision highp float;
  precision highp sampler2D;
  varying vec2 vUv;
  uniform sampler2D uTexture;
  void main () {
    vec3 c = texture2D(uTexture, vUv).rgb;
    float a = max(c.r, max(c.g, c.b));
    gl_FragColor = vec4(c, a);
  }
`;

// Background pass: shape image darkened with bass pulse
const bgVertSrc = `
  precision highp float;
  attribute vec2 aPosition;
  varying vec2 vUv;
  void main() {
    vUv = aPosition * 0.5 + 0.5;
    vUv.y = 1.0 - vUv.y;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const bgFragSrc = `
  precision highp float;
  varying vec2 vUv;
  uniform sampler2D uColorMap;
  uniform float uDimming;
  uniform float uPulse;
  void main() {
    vec4 color = texture2D(uColorMap, vUv);
    float dim = uDimming - uPulse;
    gl_FragColor = vec4(color.rgb * dim, 1.0);
  }
`;

// ── Helpers ──

function hexToHue(hex: string): number {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h = 0;
  if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
  else if (max === g) h = ((b - r) / d + 2) / 6;
  else h = ((r - g) / d + 4) / 6;
  return h;
}

function HSVtoRGB(h: number, s: number, v: number): { r: number; g: number; b: number } {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  let r = 0, g = 0, b = 0;
  switch (i % 6) {
    case 0: r = v; g = t; b = p; break;
    case 1: r = q; g = v; b = p; break;
    case 2: r = p; g = v; b = t; break;
    case 3: r = p; g = q; b = v; break;
    case 4: r = t; g = p; b = v; break;
    case 5: r = v; g = p; b = q; break;
  }
  return { r, g, b };
}

// Analogous colors: compressed 15% hue spread to avoid gray soup when mixing
function generateColor(baseHue: number, regionIndex: number, totalRegions: number): { r: number; g: number; b: number } {
  const hueOffset = (regionIndex / totalRegions) * 0.15; // 15% spread
  const c = HSVtoRGB((baseHue + hueOffset) % 1.0, 1.0, 1.0);
  // Base color (0-1). Caller multiplies ×10 for splats per FluidSimPlusPlus reference.
  return { r: c.r, g: c.g, b: c.b };
}

function getResolution(gl: WebGL2RenderingContext, resolution: number): { width: number; height: number } {
  let aspectRatio = gl.drawingBufferWidth / gl.drawingBufferHeight;
  if (aspectRatio < 1) aspectRatio = 1.0 / aspectRatio;
  const min = Math.round(resolution);
  const max = Math.round(resolution * aspectRatio);
  return gl.drawingBufferWidth > gl.drawingBufferHeight
    ? { width: max, height: min }
    : { width: min, height: max };
}

// ── Component ──

interface Props {
  shapeUrl?: string | null;
  config?: import("../tauri").SpectrumVisualConfig | null;
}

export default function FluidBackground(props: Props) {
  let canvasRef: HTMLCanvasElement | undefined;
  let destroyed = false;
  let animId = 0;
  let unlisten: (() => void) | null = null;

  // FFT state
  const rawFft = new Uint8Array(RAW_BANDS);
  const runningAvg = new Float32Array(RAW_BANDS);
  let baseHue = 0.7;

  // Smoothed band energies (0..1, exponentially smoothed each FFT frame).
  // Read by the per-frame ghost loop to modulate force/radius/colour.
  const bandEnergy = { bass: 0, mid: 0, treble: 0 };

  // Long-window running average per band — the comparison baseline used
  // for peak detection. Slower decay than bandEnergy so transient peaks
  // stand out clearly. Cooldown prevents stuttering re-emission within
  // the same musical event (e.g. a single kick should fire one splat,
  // not five). Cooldowns widened to match observed musical density —
  // earlier values were tight enough to let bass keep firing every
  // kick, accumulating dye on the same Lissajous path.
  const peakState = {
    bass:   { runningAvg: 0, prevEnergy: 0, lastDelta: 0, lastPeakT: -10, cooldown: 0.13, avgDecay: 0.97 },
    mid:    { runningAvg: 0, prevEnergy: 0, lastDelta: 0, lastPeakT: -10, cooldown: 0.09, avgDecay: 0.96 },
    treble: { runningAvg: 0, prevEnergy: 0, lastDelta: 0, lastPeakT: -10, cooldown: 0.05, avgDecay: 0.95 },
  };

  // Shape state — only the colour texture and decay mask are kept; the
  // ghost cursors paint over the entire canvas, the shape is just a
  // backdrop and a soft attenuation field on the dye.
  let colorTex: WebGLTexture | null = null;
  let hasShape = false;

  // Ghost-cursor clock (seconds since mount). Drives Lissajous trajectories.
  let ghostT = 0;

  onMount(() => {
    if (!canvasRef) return;
    const engine = initFluidEngine(canvasRef);
    if (!engine) return;

    // Sync YAML config → fluid params
    createEffect(() => {
      const c = props.config;
      if (!c) return;
      fluidCfg.DENSITY_DISSIPATION = c.fluid_density_dissipation;
      fluidCfg.VELOCITY_DISSIPATION = c.fluid_velocity_dissipation;
      fluidCfg.CURL = c.fluid_curl;
      fluidCfg.SPLAT_RADIUS = c.fluid_splat_radius;
      fluidCfg.SPLAT_FORCE = c.fluid_splat_force;
      fluidCfg.COLOR_INTENSITY = c.fluid_color_intensity;
      fluidCfg.SENSITIVITY = c.fluid_sensitivity;
      fluidCfg.PRESSURE_ITERATIONS = c.fluid_pressure_iterations;
      fluidCfg.PEAK_THRESHOLD  = c.fluid_peak_threshold  ?? fluidCfg.PEAK_THRESHOLD;
      fluidCfg.DELTA_THRESHOLD = c.fluid_delta_threshold ?? fluidCfg.DELTA_THRESHOLD;
      fluidCfg.JITTER_AMOUNT   = c.fluid_jitter_amount   ?? fluidCfg.JITTER_AMOUNT;
      fluidCfg.HUE_JITTER      = c.fluid_hue_jitter      ?? fluidCfg.HUE_JITTER;
      fluidCfg.SAT_BASE        = c.fluid_sat_base        ?? fluidCfg.SAT_BASE;
      fluidCfg.SAT_JITTER      = c.fluid_sat_jitter      ?? fluidCfg.SAT_JITTER;
      console.log(`[fluid] config updated: dissipation=${c.fluid_density_dissipation} curl=${c.fluid_curl} force=${c.fluid_splat_force} color=${c.fluid_color_intensity} | peak_th=${fluidCfg.PEAK_THRESHOLD} delta_th=${fluidCfg.DELTA_THRESHOLD} hue_jit=${fluidCfg.HUE_JITTER} sat_base=${fluidCfg.SAT_BASE}`);
    });

    // Track color
    createEffect(async () => {
      const track = player.currentTrack;
      if (!track) return;
      try {
        const hex = await getTrackColor(track.id);
        if (hex?.startsWith("#")) baseHue = hexToHue(hex);
      } catch {}
    });

    // Shape loading — colour texture + soft decay mask only.
    // Ghost cursors no longer sample emitter positions from the shape.
    createEffect(() => {
      const url = props.shapeUrl;
      if (!url) { hasShape = false; return; }
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        colorTex = engine.uploadColorTexture(img);
        engine.uploadShapeMask(img);
        hasShape = true;
        console.log("[fluid] shape loaded (colour + mask)");
      };
      img.src = url;
    });

    // FFT handler — only updates smoothed band energies. Splats are emitted
    // by the per-frame loop using Lissajous-driven ghost cursors. This
    // matches the canonical pattern from the deep-research report:
    // continuous emission, audio modulates only force/radius/colour.
    onAudioFft((payload: FftPayload) => {
      const len = Math.min(payload.magnitudes.length, RAW_BANDS);
      for (let i = 0; i < len; i++) {
        const v = payload.magnitudes[i];
        runningAvg[i] = runningAvg[i] * AGC_DECAY + v * (1 - AGC_DECAY);
        const avg = Math.max(runningAvg[i], AGC_FLOOR);
        rawFft[i] = Math.min(255, (v / avg) * 128);
      }

      // Three perceptual bands. Bin counts assume the same RAW_BANDS=1024
      // layout the existing pipeline produces (linear bins; band spans
      // chosen empirically to map to sub-bass / mids / highs).
      const sum = (lo: number, hi: number): number => {
        let s = 0;
        const n = Math.max(1, hi - lo);
        const top = Math.min(hi, LOG_BANDS);
        for (let i = lo; i < top; i++) s += rawFft[i] / 255;
        return s / n;
      };
      const rawBass   = Math.min(1, sum(0, 16)  * fluidCfg.SENSITIVITY * 4);
      const rawMid    = Math.min(1, sum(16, 64) * fluidCfg.SENSITIVITY * 3);
      const rawTreble = Math.min(1, sum(64, 128) * fluidCfg.SENSITIVITY * 2.5);

      // Exponential smoothing — emulates AnalyserNode.smoothingTimeConstant.
      bandEnergy.bass   = bandEnergy.bass   * BAND_SMOOTH + rawBass   * (1 - BAND_SMOOTH);
      bandEnergy.mid    = bandEnergy.mid    * BAND_SMOOTH + rawMid    * (1 - BAND_SMOOTH);
      bandEnergy.treble = bandEnergy.treble * BAND_SMOOTH + rawTreble * (1 - BAND_SMOOTH);

      // Long-window running average — secondary baseline for peak detection.
      peakState.bass.runningAvg   = peakState.bass.runningAvg   * peakState.bass.avgDecay   + bandEnergy.bass   * (1 - peakState.bass.avgDecay);
      peakState.mid.runningAvg    = peakState.mid.runningAvg    * peakState.mid.avgDecay    + bandEnergy.mid    * (1 - peakState.mid.avgDecay);
      peakState.treble.runningAvg = peakState.treble.runningAvg * peakState.treble.avgDecay + bandEnergy.treble * (1 - peakState.treble.avgDecay);

      // Delta detection — primary onset signal. Captures sudden rises in
      // band energy regardless of absolute level. This is what makes the
      // detector keep firing during constant-density tracks (techno, EDM,
      // ambient with steady kicks) where the running avg saturates and
      // ratio-based detection silently falls through.
      peakState.bass.lastDelta   = bandEnergy.bass   - peakState.bass.prevEnergy;
      peakState.mid.lastDelta    = bandEnergy.mid    - peakState.mid.prevEnergy;
      peakState.treble.lastDelta = bandEnergy.treble - peakState.treble.prevEnergy;
      peakState.bass.prevEnergy   = bandEnergy.bass;
      peakState.mid.prevEnergy    = bandEnergy.mid;
      peakState.treble.prevEnergy = bandEnergy.treble;

      // Background pulse driven by bass.
      engine.setBassEnergy(bandEnergy.bass);
    }).then(unsub => { unlisten = unsub; });

    setTimeout(() => {
      if (!destroyed) spectrumSubscribe();
    }, 200);

    // Render loop
    let lastTime = Date.now();
    function frame() {
      if (destroyed) return;
      animId = requestAnimationFrame(frame);
      const now = Date.now();
      let dt = (now - lastTime) / 1000;
      dt = Math.min(dt, 0.016666);
      lastTime = now;
      ghostT += dt;

      // Peak-triggered emission. A splat fires only when a band's current
      // energy exceeds its long-window running average by PEAK_THRESHOLD,
      // clears an absolute floor, and is past the per-band cooldown. Result:
      // each kick / hi-hat / vocal hit becomes a discrete visual event, the
      // fluid dissipates between events, and there is a clear audio↔visual
      // mapping. No event = no splat = canvas can return to black.
      if (player.isPlaying) {
        const ABS_FLOOR = 0.12;   // ignore peaks during near-silence (kept hardcoded — defines the noise floor, not a stylistic knob)

        for (const g of GHOSTS) {
          const energy = g.band === "bass" ? bandEnergy.bass
                       : g.band === "mid"  ? bandEnergy.mid
                       :                     bandEnergy.treble;
          const ps = peakState[g.band];

          if (energy < ABS_FLOOR) continue;
          if ((ghostT - ps.lastPeakT) <= ps.cooldown) continue;

          // Two-path detection. Either is enough to fire a peak:
          //  • DELTA: sudden rise in energy (onset) — works in steady music
          //  • RATIO: current energy noticeably above running avg
          const ratio = ps.runningAvg > 0.05 ? energy / ps.runningAvg : 0;
          const byDelta = ps.lastDelta > fluidCfg.DELTA_THRESHOLD;
          const byRatio = ratio > fluidCfg.PEAK_THRESHOLD;
          if (!byDelta && !byRatio) continue;
          ps.lastPeakT = ghostT;

          // peakStrength combines both signals. Heavy onsets feel heavier;
          // sustained-loud passages still register at moderate strength.
          const deltaStrength = Math.max(0, ps.lastDelta * 6.0); // scale 0..1+
          const ratioStrength = Math.max(0, ratio - 1.0);
          const peakStrength  = Math.min(1.5, Math.max(0.35, Math.max(deltaStrength, ratioStrength)));

          // Position on Lissajous at this instant + per-event random jitter.
          // Lissajous keeps the geographic anchoring (bass region stable),
          // jitter ensures consecutive peaks don't paint over the same
          // pixel — that was producing the "one blob lives forever" effect.
          const baseX = 0.5 + g.ampX * Math.sin(g.freqA * ghostT + g.phaseA);
          const baseY = 0.5 + g.ampY * Math.sin(g.freqB * ghostT);
          const x = baseX + (Math.random() - 0.5) * fluidCfg.JITTER_AMOUNT;
          const y = baseY + (Math.random() - 0.5) * fluidCfg.JITTER_AMOUNT;

          const tx =  g.freqA * g.ampX * Math.cos(g.freqA * ghostT + g.phaseA);
          const ty =  g.freqB * g.ampY * Math.cos(g.freqB * ghostT);
          const norm = Math.hypot(tx, ty) || 1;

          // Moderate force — enough momentum for the solver to grow real
          // swirls and curl when combined with non-trivial velocity_dissipation.
          // Too low (0.008) produced static defined blobs; too high (0.05)
          // sent paint flying. 0.025 × peakStrength is the sweet spot.
          const force  = g.baseForce * fluidCfg.SPLAT_FORCE / 600 * 0.025 * peakStrength;
          // Radius scales with peakStrength only (no ambient floor) — small
          // peaks paint tight bursts, big peaks paint full blobs.
          const radius = g.baseRadius * fluidCfg.SPLAT_RADIUS / 0.18 * (0.8 + peakStrength * 1.2);

          const dx = (tx / norm) * force;
          const dy = (ty / norm) * force;

          // Hue jitter per splat — each peak picks a random hue within
          // ±half the configured range of the band's anchor (still recognisable
          // as bass/mid/treble colour, but no two splats look identical).
          const hueJitter = (Math.random() - 0.5) * fluidCfg.HUE_JITTER;
          // Saturation: configured base + peakStrength contribution + random jitter.
          const sat = fluidCfg.SAT_BASE + peakStrength * 0.25 + Math.random() * fluidCfg.SAT_JITTER;
          const c = HSVtoRGB((baseHue + g.hueOffset + hueJitter + 1) % 1, Math.min(1, sat), 1);
          const color = { r: c.r, g: c.g, b: c.b };
          // Brightness scales linearly with peakStrength — a hard peak is
          // ~2x as luminous as a faint one, both clearly visible.
          const brightness = fluidCfg.COLOR_INTENSITY * (1.2 + peakStrength * 1.6);
          color.r *= brightness;
          color.g *= brightness;
          color.b *= brightness;

          engine.splat(x, y, dx, dy, color, radius);
        }
      }

      engine.step(dt);
      // Fluid stands alone over a black background — the shape image is
      // ignored as a backdrop in this renderer. Other styles (exoskeleton)
      // still use shape via their own components and are not affected.
      engine.render();
    }
    frame();
  });

  onCleanup(() => {
    destroyed = true;
    cancelAnimationFrame(animId);
    spectrumUnsubscribe();
    unlisten?.();
  });

  return (
    <canvas
      ref={canvasRef!}
      class="np-bg__el"
      style="width: 100%; height: 100%; display: block; position: absolute; top: 0; left: 0;"
    />
  );
}

// ── Fluid Engine ──

interface FBO {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
  texelSizeX: number;
  texelSizeY: number;
  attach: (id: number) => number;
}

interface DoubleFBO {
  width: number;
  height: number;
  texelSizeX: number;
  texelSizeY: number;
  read: FBO;
  write: FBO;
  swap: () => void;
}

interface FluidEngine {
  splat: (x: number, y: number, dx: number, dy: number, color: { r: number; g: number; b: number }, radius: number) => void;
  step: (dt: number) => void;
  render: () => void;
  renderWithBackground: (bgTex: WebGLTexture) => void;
  uploadColorTexture: (img: HTMLImageElement) => WebGLTexture;
  uploadShapeMask: (img: HTMLImageElement) => void;
  setBassEnergy: (e: number) => void;
}

function initFluidEngine(canvas: HTMLCanvasElement): FluidEngine | null {
  const params = { alpha: true, depth: false, stencil: false, antialias: false, preserveDrawingBuffer: false };
  const gl = canvas.getContext("webgl2", params) as WebGL2RenderingContext;
  if (!gl) { console.error("WebGL2 not available for fluid"); return null; }

  gl.getExtension("EXT_color_buffer_float");
  const supportLinearFiltering = gl.getExtension("OES_texture_float_linear");

  gl.clearColor(0.0, 0.0, 0.0, 1.0);

  const halfFloatTexType = gl.HALF_FLOAT;
  const formatRGBA = { internalFormat: gl.RGBA16F, format: gl.RGBA };
  const formatRG = { internalFormat: gl.RG16F, format: gl.RG };
  const formatR = { internalFormat: gl.R16F, format: gl.RED };

  let _bassEnergy = 0;
  let _shapeMaskTex: WebGLTexture | null = null;
  let _hasMask = false;

  function compileShader(type: number, source: string): WebGLShader {
    const shader = gl.createShader(type)!;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      console.error("Shader compile error:", gl.getShaderInfoLog(shader));
    return shader;
  }

  function createProgram(vertSrc: string, fragSrc: string) {
    const vs = compileShader(gl.VERTEX_SHADER, vertSrc);
    const fs = compileShader(gl.FRAGMENT_SHADER, fragSrc);
    const prog = gl.createProgram()!;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS))
      console.error("Program link error:", gl.getProgramInfoLog(prog));

    const uniforms: Record<string, WebGLUniformLocation> = {};
    const count = gl.getProgramParameter(prog, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i++) {
      const info = gl.getActiveUniform(prog, i);
      if (info) uniforms[info.name] = gl.getUniformLocation(prog, info.name)!;
    }

    return {
      program: prog,
      uniforms,
      bind() { gl.useProgram(prog); },
    };
  }

  // Blit quad
  const quadBuffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, 1, 1, -1]), gl.STATIC_DRAW);
  const quadIndexBuffer = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, quadIndexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint16Array([0, 1, 2, 0, 2, 3]), gl.STATIC_DRAW);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.enableVertexAttribArray(0);

  function blit(target: FBO | null, clear = false) {
    if (target == null) {
      gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    } else {
      gl.viewport(0, 0, target.width, target.height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    }
    if (clear) {
      gl.clearColor(0.0, 0.0, 0.0, 1.0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  function createFBO(w: number, h: number, internalFormat: number, format: number, type: number, param: number): FBO {
    gl.activeTexture(gl.TEXTURE0);
    const texture = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, param);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);

    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.viewport(0, 0, w, h);
    gl.clear(gl.COLOR_BUFFER_BIT);

    return {
      texture, fbo, width: w, height: h,
      texelSizeX: 1.0 / w, texelSizeY: 1.0 / h,
      attach(id: number) {
        gl.activeTexture(gl.TEXTURE0 + id);
        gl.bindTexture(gl.TEXTURE_2D, texture);
        return id;
      },
    };
  }

  function createDoubleFBO(w: number, h: number, internalFormat: number, format: number, type: number, param: number): DoubleFBO {
    let fbo1 = createFBO(w, h, internalFormat, format, type, param);
    let fbo2 = createFBO(w, h, internalFormat, format, type, param);
    return {
      width: w, height: h,
      texelSizeX: fbo1.texelSizeX, texelSizeY: fbo1.texelSizeY,
      get read() { return fbo1; },
      set read(v) { fbo1 = v; },
      get write() { return fbo2; },
      set write(v) { fbo2 = v; },
      swap() { const t = fbo1; fbo1 = fbo2; fbo2 = t; },
    };
  }

  // Programs
  const splatProgram = createProgram(baseVertexShaderSrc, splatShaderSrc);
  const advectionProgram = createProgram(baseVertexShaderSrc, advectionShaderSrc);
  const divergenceProgram = createProgram(baseVertexShaderSrc, divergenceShaderSrc);
  const curlProgram = createProgram(baseVertexShaderSrc, curlShaderSrc);
  const vorticityProgram = createProgram(baseVertexShaderSrc, vorticityShaderSrc);
  const pressureProgram = createProgram(baseVertexShaderSrc, pressureShaderSrc);
  const gradientSubtractProgram = createProgram(baseVertexShaderSrc, gradientSubtractShaderSrc);
  const clearProgram = createProgram(baseVertexShaderSrc, clearShaderSrc);
  const displayProgram = createProgram(baseVertexShaderSrc, displayShaderSrc);
  const bgProgram = createProgram(bgVertSrc, bgFragSrc);

  // FBOs
  const simRes = getResolution(gl, fluidCfg.SIM_RESOLUTION);
  const dyeRes = getResolution(gl, fluidCfg.DYE_RESOLUTION);
  const texType = halfFloatTexType;
  const filterParam = supportLinearFiltering ? gl.LINEAR : gl.NEAREST;

  const dye = createDoubleFBO(dyeRes.width, dyeRes.height, formatRGBA.internalFormat, formatRGBA.format, texType, filterParam);
  const velocity = createDoubleFBO(simRes.width, simRes.height, formatRG.internalFormat, formatRG.format, texType, filterParam);
  const divergenceFBO = createFBO(simRes.width, simRes.height, formatR.internalFormat, formatR.format, texType, gl.NEAREST);
  const curlFBO = createFBO(simRes.width, simRes.height, formatR.internalFormat, formatR.format, texType, gl.NEAREST);
  const pressure = createDoubleFBO(simRes.width, simRes.height, formatR.internalFormat, formatR.format, texType, gl.NEAREST);

  // Resize
  function resize() {
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  }
  resize();
  window.addEventListener("resize", resize);

  // ── Step ──

  function step(dt: number) {
    gl.disable(gl.BLEND);

    curlProgram.bind();
    gl.uniform2f(curlProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(curlProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(curlFBO);

    vorticityProgram.bind();
    gl.uniform2f(vorticityProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(vorticityProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(vorticityProgram.uniforms.uCurl, curlFBO.attach(1));
    gl.uniform1f(vorticityProgram.uniforms.curl, fluidCfg.CURL);
    gl.uniform1f(vorticityProgram.uniforms.dt, dt);
    blit(velocity.write);
    velocity.swap();

    divergenceProgram.bind();
    gl.uniform2f(divergenceProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(divergenceProgram.uniforms.uVelocity, velocity.read.attach(0));
    blit(divergenceFBO);

    clearProgram.bind();
    gl.uniform1i(clearProgram.uniforms.uTexture, pressure.read.attach(0));
    gl.uniform1f(clearProgram.uniforms.value, fluidCfg.PRESSURE);
    blit(pressure.write);
    pressure.swap();

    pressureProgram.bind();
    gl.uniform2f(pressureProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(pressureProgram.uniforms.uDivergence, divergenceFBO.attach(0));
    for (let i = 0; i < fluidCfg.PRESSURE_ITERATIONS; i++) {
      gl.uniform1i(pressureProgram.uniforms.uPressure, pressure.read.attach(1));
      blit(pressure.write);
      pressure.swap();
    }

    gradientSubtractProgram.bind();
    gl.uniform2f(gradientSubtractProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(gradientSubtractProgram.uniforms.uPressure, pressure.read.attach(0));
    gl.uniform1i(gradientSubtractProgram.uniforms.uVelocity, velocity.read.attach(1));
    blit(velocity.write);
    velocity.swap();

    advectionProgram.bind();
    // Shape mask disabled for now — get base fluid working first
    gl.uniform1f(advectionProgram.uniforms.uMaskEnabled, 0.0);
    gl.uniform2f(advectionProgram.uniforms.texelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, velocity.texelSizeX, velocity.texelSizeY);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, velocity.read.attach(0));
    gl.uniform1f(advectionProgram.uniforms.dt, dt);
    gl.uniform1f(advectionProgram.uniforms.dissipation, fluidCfg.VELOCITY_DISSIPATION);
    blit(velocity.write);
    velocity.swap();

    gl.uniform2f(advectionProgram.uniforms.dyeTexelSize, dye.texelSizeX, dye.texelSizeY);
    gl.uniform1i(advectionProgram.uniforms.uVelocity, velocity.read.attach(0));
    gl.uniform1i(advectionProgram.uniforms.uSource, dye.read.attach(1));
    gl.uniform1f(advectionProgram.uniforms.dissipation, fluidCfg.DENSITY_DISSIPATION);
    blit(dye.write);
    dye.swap();
  }

  // ── Render ──

  function render() {
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.enable(gl.BLEND);
    displayProgram.bind();
    gl.uniform1i(displayProgram.uniforms.uTexture, dye.read.attach(0));
    blit(null);
  }

  function renderWithBackground(bgTexture: WebGLTexture) {
    // Pass 1: Background image dimmed
    gl.disable(gl.BLEND);
    bgProgram.bind();
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, bgTexture);
    gl.uniform1i(bgProgram.uniforms.uColorMap, 5);
    gl.uniform1f(bgProgram.uniforms.uDimming, 0.25);
    gl.uniform1f(bgProgram.uniforms.uPulse, _bassEnergy * 0.15);
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);

    // Pass 2: Fluid on top with additive blending
    gl.blendFunc(gl.ONE, gl.ONE); // Additive — fluid glows over dark bg
    gl.enable(gl.BLEND);
    displayProgram.bind();
    gl.uniform1i(displayProgram.uniforms.uTexture, dye.read.attach(0));
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.drawElements(gl.TRIANGLES, 6, gl.UNSIGNED_SHORT, 0);
  }

  // ── Splat ──

  function splat(x: number, y: number, dx: number, dy: number, color: { r: number; g: number; b: number }, radius: number) {
    splatProgram.bind();
    gl.uniform1i(splatProgram.uniforms.uTarget, velocity.read.attach(0));
    gl.uniform1f(splatProgram.uniforms.aspectRatio, canvas.width / canvas.height);
    gl.uniform2f(splatProgram.uniforms.point, x, y);
    gl.uniform3f(splatProgram.uniforms.color, dx, dy, 0.0);
    gl.uniform1f(splatProgram.uniforms.radius, radius / 100.0);
    blit(velocity.write);
    velocity.swap();

    gl.uniform1i(splatProgram.uniforms.uTarget, dye.read.attach(0));
    gl.uniform3f(splatProgram.uniforms.color, color.r, color.g, color.b);
    blit(dye.write);
    dye.swap();
  }

  function uploadColorTexture(img: HTMLImageElement): WebGLTexture {
    const tex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  function uploadShapeMask(img: HTMLImageElement) {
    // Create grayscale mask from shape image at simulation resolution
    const maskCanvas = document.createElement("canvas");
    const res = getResolution(gl, fluidCfg.SIM_RESOLUTION);
    maskCanvas.width = res.width;
    maskCanvas.height = res.height;
    const ctx = maskCanvas.getContext("2d")!;
    ctx.filter = "saturate(0) blur(4px)";
    ctx.drawImage(img, 0, 0, res.width, res.height);

    if (!_shapeMaskTex) _shapeMaskTex = gl.createTexture()!;
    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_2D, _shapeMaskTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, maskCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    _hasMask = true;
  }

  function setBassEnergy(e: number) { _bassEnergy = e; }

  return { splat, step, render, renderWithBackground, uploadColorTexture, uploadShapeMask, setBassEnergy };
}
