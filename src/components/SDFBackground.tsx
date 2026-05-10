/*
 * SDFBackground.tsx — WebGL2 SDF raymarching driven by audio FFT.
 *
 * Three primitives (one per perceptual band) merged via Inigo-Quilez
 * smooth min, with audio-modulated domain warping. Renders to a
 * half-resolution FBO and upscales bilinearly to keep fragment cost
 * sane on integrated GPUs (single biggest perf knob: sdf_resolution_scale).
 *
 * Pause behaviour: clock keeps ticking (warp keeps breathing) but band
 * energies decay to zero — primitives shrink to baseline, no abrupt cut.
 */

import { onMount, onCleanup, createEffect } from "solid-js";
import { onAudioFft, spectrumSubscribe, spectrumUnsubscribe, getTrackColor, FftPayload } from "../tauri";
import { player } from "../store/player";

// ── FFT config (mirrors FluidBackground) ──

const RAW_BANDS = 1024;
const LOG_BANDS = 128;
const AGC_DECAY = 0.985;
const AGC_FLOOR = 3.0;
// Snappier than fluid (0.55→~40ms) — SDF impulse path needs sharp attack
// to feel synchronised with percussion.
const BAND_SMOOTH = 0.55;
// Envelope rates (per frame at 60fps).
// Attack lerp: how fast `impulse` tracks `target` when target > impulse.
// 0.30 → ~5 frames to reach 80% of target = ~80ms ramp (no flash).
const IMPULSE_ATTACK_RATE = 0.30;
// Release lerp: how fast `impulse` tracks `target` when target < impulse.
// 0.08 → ~10 frames to halve = ~170ms organic falloff.
const IMPULSE_RELEASE_RATE = 0.08;
// Target self-decay each frame. 0.94 → ~250ms half-life on the target
// itself, so even without lerp lag the impulse fades back to zero.
const IMPULSE_TARGET_DECAY = 0.94;
// Peak detection thresholds. Same idea as fluid: only count an event when
// the band's instantaneous energy clearly exceeds its running average.
const PEAK_THRESHOLD = 1.30;
const PEAK_FLOOR = 0.15;

// ── Shader sources (WebGL2 / GLSL ES 3.0) ──

const fullscreenVertSrc = `#version 300 es
in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

// Main raymarching pass. Three smooth-min'd spheres with sin-based
// domain warping. Cheap fresnel rim + Lambert lighting. Tonemap at end.
const sdfFragSrc = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;

uniform float u_time;
uniform float u_aspect;
uniform float u_bass;
uniform float u_mid;
uniform float u_treble;
uniform float u_baseHue;
uniform float u_warp_intensity;
uniform float u_warp_frequency;
uniform float u_smooth_k;
uniform float u_emissive_boost;
uniform float u_max_dist;
uniform int   u_step_count;
uniform int   u_render_mode;  // 0 = 2D glow (cheap), 1 = 3D raymarched
// Peak-triggered impulses per band. Drive radius dramatically: each band's
// sphere is barely visible at idle and explodes outward on a peak, then
// decays in ~80ms. This is what makes the visual feel synchronised to
// percussion instead of merely reactive to general loudness.
uniform float u_bass_impulse;
uniform float u_mid_impulse;
uniform float u_treble_impulse;

vec3 hsv2rgb(vec3 c) {
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}

// IQ smooth min — k controls blend radius (organic merging).
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5*(b-a)/k, 0.0, 1.0);
  return mix(b, a, h) - k*h*(1.0-h);
}

float sphere(vec3 p, float r) { return length(p) - r; }

// 2D variant — same three primitives projected to the view plane.
// One eval per pixel, no raymarching loop. ~50x cheaper than the 3D path.
float scene2D(vec2 uv) {
  float t = u_time;
  float warpAmp = u_warp_intensity * (0.25 + u_bass * 0.5 + u_bass_impulse * 0.7) * 0.5;
  vec2 wp = uv;
  wp.x += warpAmp * sin(uv.y * u_warp_frequency + t * 0.7);
  wp.y += warpAmp * sin(uv.x * u_warp_frequency + t * 0.5);

  float rBass = 0.10 + u_bass * 0.30 + u_bass_impulse * 0.65;
  float dBass = length(wp) - rBass;

  vec2 pMid = wp - vec2(sin(t * 0.4) * 1.1, cos(t * 0.5) * 0.7);
  float rMid = 0.05 + u_mid * 0.20 + u_mid_impulse * 0.45;
  float dMid = length(pMid) - rMid;

  vec2 pTreble = wp - vec2(cos(t * 0.9) * 1.3, sin(t * 0.8) * 0.9);
  float rTreble = 0.03 + u_treble * 0.15 + u_treble_impulse * 0.30;
  float dTreble = length(pTreble) - rTreble;

  float d = smin(dBass, dMid, u_smooth_k);
  d = smin(d, dTreble, u_smooth_k);
  return d;
}

// Cheap domain warping. Three orthogonal sin axes — costs ~6 sin per
// scene eval, far cheaper than FBM noise. Audio (bass) scales amplitude.
vec3 warp(vec3 p, float amp, float freq, float t) {
  vec3 q = p;
  q.x += amp * sin(p.y * freq + t * 0.7);
  q.y += amp * sin(p.z * freq + t * 0.5);
  q.z += amp * sin(p.x * freq + t * 0.6);
  return q;
}

float scene(vec3 p) {
  float t = u_time;
  // Warp amplitude tracks bass smoothly + spikes on bass peaks.
  float warpAmp = u_warp_intensity * (0.25 + u_bass * 0.5 + u_bass_impulse * 0.7);
  vec3 wp = warp(p, warpAmp, u_warp_frequency, t);

  // Idle radius is tiny (sphere barely exists in silence). Smoothed band
  // energy contributes a modest ambient swell. Impulse adds a dramatic
  // burst on peaks and decays fast — this is what reads as "in sync".
  float rBass = 0.10 + u_bass * 0.30 + u_bass_impulse * 0.65;
  float dBass = sphere(wp, rBass);

  vec3 pMid = wp - vec3(sin(t * 0.4) * 1.1, cos(t * 0.5) * 0.7, sin(t * 0.3) * 0.4);
  float rMid = 0.05 + u_mid * 0.20 + u_mid_impulse * 0.45;
  float dMid = sphere(pMid, rMid);

  vec3 pTreble = wp - vec3(cos(t * 0.9) * 1.3, sin(t * 0.8) * 0.9, cos(t * 1.1) * 0.6);
  float rTreble = 0.03 + u_treble * 0.15 + u_treble_impulse * 0.30;
  float dTreble = sphere(pTreble, rTreble);

  float d = smin(dBass, dMid, u_smooth_k);
  d = smin(d, dTreble, u_smooth_k);
  return d;
}

vec3 calcNormal(vec3 p) {
  const float h = 0.001;
  const vec2 k = vec2(1.0, -1.0);
  return normalize(
    k.xyy * scene(p + k.xyy*h) +
    k.yyx * scene(p + k.yyx*h) +
    k.yxy * scene(p + k.yxy*h) +
    k.xxx * scene(p + k.xxx*h)
  );
}

// Triadic palette helper — three hues spaced 120deg around baseHue,
// weighted by band energy. Used by both render modes.
vec3 triadicPaint() {
  float h0 = u_baseHue;
  float h1 = mod(u_baseHue + 0.333, 1.0);
  float h2 = mod(u_baseHue + 0.666, 1.0);
  vec3 cBass   = hsv2rgb(vec3(h0, 0.85, 1.0));
  vec3 cMid    = hsv2rgb(vec3(h1, 0.85, 1.0));
  vec3 cTreble = hsv2rgb(vec3(h2, 0.85, 1.0));
  float wB = 0.3 + u_bass;
  float wM = 0.2 + u_mid;
  float wT = 0.2 + u_treble;
  return (cBass * wB + cMid * wM + cTreble * wT) / (wB + wM + wT);
}

void main() {
  vec2 uv = vUv * 2.0 - 1.0;
  uv.x *= u_aspect;

  vec3 col = vec3(0.0);

  if (u_render_mode == 0) {
    // ── 2D glow path ──
    // One distance eval per pixel. Inside the shape: solid paint with
    // soft falloff toward the edge. Outside: exponential glow halo.
    float d = scene2D(uv);
    vec3 paint = triadicPaint();

    if (d < 0.0) {
      // Inside primitives: bright core fading toward boundary.
      float depth = clamp(-d * 1.5, 0.0, 1.0);
      col = paint * (0.6 + depth * 0.7);
    } else {
      // Outside: exponential glow. Tighter falloff = sharper neon look.
      float glow = exp(-d * 4.0);
      col = paint * glow * (0.7 + u_emissive_boost * 0.5);
    }
  } else {
    // ── 3D raymarched path ──
    vec3 ro = vec3(0.0, 0.0, 3.5);
    vec3 rd = normalize(vec3(uv, -1.5));

    float t = 0.0;
    float minDist = 1e9;
    bool hit = false;

    // Sphere-tracing loop. Step count is uniform-bound to allow the YAML
    // to dial perf vs quality. Slight under-step (0.95) softens silhouettes.
    for (int i = 0; i < 128; i++) {
      if (i >= u_step_count) break;
      vec3 p = ro + rd * t;
      float d = scene(p);
      if (d < minDist) minDist = d;
      if (d < 0.0015) { hit = true; break; }
      t += d * 0.95;
      if (t > u_max_dist) break;
    }

    if (hit) {
      vec3 p = ro + rd * t;
      vec3 n = calcNormal(p);
      float fres = pow(1.0 - max(dot(n, -rd), 0.0), 2.5);
      vec3 paint = triadicPaint();
      float light = 0.35 + 0.65 * max(dot(n, normalize(vec3(0.4, 0.7, 0.8))), 0.0);
      col = paint * light + paint * fres * u_emissive_boost;
    } else {
      float glow = exp(-minDist * 3.5) * 0.18;
      vec3 ambient = hsv2rgb(vec3(u_baseHue, 0.5, 1.0));
      col = ambient * glow;
    }
  }

  // Reinhard tonemap — keeps highlights from clipping when fresnel
  // and emissive stack on bass peaks.
  col = col / (1.0 + col);

  fragColor = vec4(col, 1.0);
}`;

// Upscale: bilinear sample of the half-res FBO into the canvas.
const upscaleFragSrc = `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTexture;
void main() {
  fragColor = texture(uTexture, vUv);
}`;

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

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const sh = gl.createShader(type);
  if (!sh) return null;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    console.error("[sdf] shader compile error:", gl.getShaderInfoLog(sh));
    gl.deleteShader(sh);
    return null;
  }
  return sh;
}

function linkProgram(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram | null {
  const prog = gl.createProgram();
  if (!prog) return null;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error("[sdf] program link error:", gl.getProgramInfoLog(prog));
    gl.deleteProgram(prog);
    return null;
  }
  return prog;
}

// ── Component ──

interface Props {
  config?: import("../tauri").SpectrumVisualConfig | null;
}

export default function SDFBackground(props: Props) {
  let canvasRef: HTMLCanvasElement | undefined;
  let destroyed = false;
  let animId = 0;
  let unlisten: (() => void) | null = null;

  // FFT state
  const rawFft = new Uint8Array(RAW_BANDS);
  const runningAvg = new Float32Array(RAW_BANDS);
  const bandEnergy = { bass: 0, mid: 0, treble: 0 };
  // Long-window running averages — baseline for peak detection (mirrors
  // the fluid component). Per-band cooldowns prevent multiple impulses
  // firing within the same musical event.
  const peakState = {
    bass:   { runningAvg: 0, lastPeakT: -10, cooldown: 0.10, avgDecay: 0.97 },
    mid:    { runningAvg: 0, lastPeakT: -10, cooldown: 0.07, avgDecay: 0.96 },
    treble: { runningAvg: 0, lastPeakT: -10, cooldown: 0.04, avgDecay: 0.95 },
  };
  // ASR envelope per band: target is set on peak, then decays slowly on
  // its own. The shader-bound `impulse` value lerps toward target with
  // asymmetric rates — fast on attack (smooth ramp instead of jarring
  // flash), slow on release (organic falloff). This is what turns the
  // raw "instant zoom" into a perceived pulse.
  const impulse = { bass: 0, mid: 0, treble: 0 };
  const impulseTarget = { bass: 0, mid: 0, treble: 0 };
  let baseHue = 0.7;

  // Mutable shader uniforms (config-driven; updated by createEffect on props.config).
  const cfg = {
    stepCount: 32,
    maxDist: 12.0,
    warpIntensity: 0.6,
    warpFrequency: 1.8,
    smoothK: 0.85,
    emissiveBoost: 1.3,
    resolutionScale: 0.4,
    renderMode: 1, // 0 = 2D glow, 1 = 3D raymarched
  };

  onMount(() => {
    if (!canvasRef) return;
    const gl = canvasRef.getContext("webgl2", { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) {
      console.error("[sdf] WebGL2 not available");
      return;
    }

    // EXT for half-float colour FBO. If unavailable we fall back to RGBA8 —
    // marginal banding in dark gradients but functional.
    const ext = gl.getExtension("EXT_color_buffer_float");
    const internalFormat = ext ? gl.RGBA16F : gl.RGBA8;
    const dataType = ext ? gl.HALF_FLOAT : gl.UNSIGNED_BYTE;

    // ── Compile programs ──
    const vs = compileShader(gl, gl.VERTEX_SHADER, fullscreenVertSrc);
    const fsSdf = compileShader(gl, gl.FRAGMENT_SHADER, sdfFragSrc);
    const fsUp = compileShader(gl, gl.FRAGMENT_SHADER, upscaleFragSrc);
    if (!vs || !fsSdf || !fsUp) return;

    const sdfProg = linkProgram(gl, vs, fsSdf);
    const upProg = linkProgram(gl, vs, fsUp);
    if (!sdfProg || !upProg) return;

    // ── Fullscreen quad (two triangles via TRIANGLE_STRIP) ──
    const quadBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const setupAttrib = (prog: WebGLProgram) => {
      gl.useProgram(prog);
      const loc = gl.getAttribLocation(prog, "aPosition");
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    };

    // ── Half-res FBO ──
    let fbo: WebGLFramebuffer | null = null;
    let fboTex: WebGLTexture | null = null;
    let fboW = 0, fboH = 0;

    function ensureFbo(targetW: number, targetH: number) {
      if (fboW === targetW && fboH === targetH && fbo) return;
      if (fboTex) gl!.deleteTexture(fboTex);
      if (fbo) gl!.deleteFramebuffer(fbo);
      fboW = targetW;
      fboH = targetH;
      fboTex = gl!.createTexture();
      gl!.bindTexture(gl!.TEXTURE_2D, fboTex);
      gl!.texImage2D(gl!.TEXTURE_2D, 0, internalFormat, fboW, fboH, 0, gl!.RGBA, dataType, null);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MIN_FILTER, gl!.LINEAR);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_MAG_FILTER, gl!.LINEAR);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_S, gl!.CLAMP_TO_EDGE);
      gl!.texParameteri(gl!.TEXTURE_2D, gl!.TEXTURE_WRAP_T, gl!.CLAMP_TO_EDGE);
      fbo = gl!.createFramebuffer();
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
      gl!.framebufferTexture2D(gl!.FRAMEBUFFER, gl!.COLOR_ATTACHMENT0, gl!.TEXTURE_2D, fboTex, 0);
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
    }

    // ── Uniform locations (cached) ──
    const uLoc = {
      time: gl.getUniformLocation(sdfProg, "u_time"),
      aspect: gl.getUniformLocation(sdfProg, "u_aspect"),
      bass: gl.getUniformLocation(sdfProg, "u_bass"),
      mid: gl.getUniformLocation(sdfProg, "u_mid"),
      treble: gl.getUniformLocation(sdfProg, "u_treble"),
      baseHue: gl.getUniformLocation(sdfProg, "u_baseHue"),
      warpInt: gl.getUniformLocation(sdfProg, "u_warp_intensity"),
      warpFreq: gl.getUniformLocation(sdfProg, "u_warp_frequency"),
      smoothK: gl.getUniformLocation(sdfProg, "u_smooth_k"),
      emissive: gl.getUniformLocation(sdfProg, "u_emissive_boost"),
      maxDist: gl.getUniformLocation(sdfProg, "u_max_dist"),
      stepCount: gl.getUniformLocation(sdfProg, "u_step_count"),
      renderMode: gl.getUniformLocation(sdfProg, "u_render_mode"),
      bassImpulse: gl.getUniformLocation(sdfProg, "u_bass_impulse"),
      midImpulse: gl.getUniformLocation(sdfProg, "u_mid_impulse"),
      trebleImpulse: gl.getUniformLocation(sdfProg, "u_treble_impulse"),
    };
    const uTextureLoc = gl.getUniformLocation(upProg, "uTexture");

    // ── Sync YAML config → cfg ──
    createEffect(() => {
      const c = props.config;
      if (!c) return;
      cfg.stepCount = c.sdf_step_count ?? cfg.stepCount;
      cfg.maxDist = c.sdf_max_dist ?? cfg.maxDist;
      cfg.warpIntensity = c.sdf_warp_intensity ?? cfg.warpIntensity;
      cfg.warpFrequency = c.sdf_warp_frequency ?? cfg.warpFrequency;
      cfg.smoothK = c.sdf_smooth_k ?? cfg.smoothK;
      cfg.emissiveBoost = c.sdf_emissive_boost ?? cfg.emissiveBoost;
      cfg.resolutionScale = c.sdf_resolution_scale ?? cfg.resolutionScale;
      cfg.renderMode = c.sdf_render_mode ?? cfg.renderMode;
      console.log(`[sdf] config updated: mode=${cfg.renderMode === 0 ? "2D" : "3D"} steps=${cfg.stepCount} scale=${cfg.resolutionScale} warp=${cfg.warpIntensity}@${cfg.warpFrequency} k=${cfg.smoothK}`);
    });

    // ── Track palette ──
    createEffect(async () => {
      const track = player.currentTrack;
      if (!track) return;
      try {
        const hex = await getTrackColor(track.id);
        if (hex?.startsWith("#")) baseHue = hexToHue(hex);
      } catch {}
    });

    // ── FFT subscription ──
    onAudioFft((payload: FftPayload) => {
      const len = Math.min(payload.magnitudes.length, RAW_BANDS);
      for (let i = 0; i < len; i++) {
        const v = payload.magnitudes[i];
        runningAvg[i] = runningAvg[i] * AGC_DECAY + v * (1 - AGC_DECAY);
        const avg = Math.max(runningAvg[i], AGC_FLOOR);
        rawFft[i] = Math.min(255, (v / avg) * 128);
      }
      const sum = (lo: number, hi: number): number => {
        let s = 0;
        const n = Math.max(1, hi - lo);
        const top = Math.min(hi, LOG_BANDS);
        for (let i = lo; i < top; i++) s += rawFft[i] / 255;
        return s / n;
      };
      const sens = props.config?.fluid_sensitivity ?? 1.0;
      const rawBass   = Math.min(1, sum(0, 16)  * sens * 4);
      const rawMid    = Math.min(1, sum(16, 64) * sens * 3);
      const rawTreble = Math.min(1, sum(64, 128) * sens * 2.5);
      bandEnergy.bass   = bandEnergy.bass   * BAND_SMOOTH + rawBass   * (1 - BAND_SMOOTH);
      bandEnergy.mid    = bandEnergy.mid    * BAND_SMOOTH + rawMid    * (1 - BAND_SMOOTH);
      bandEnergy.treble = bandEnergy.treble * BAND_SMOOTH + rawTreble * (1 - BAND_SMOOTH);

      // Long-window running averages — baseline for peak detection.
      peakState.bass.runningAvg   = peakState.bass.runningAvg   * peakState.bass.avgDecay   + bandEnergy.bass   * (1 - peakState.bass.avgDecay);
      peakState.mid.runningAvg    = peakState.mid.runningAvg    * peakState.mid.avgDecay    + bandEnergy.mid    * (1 - peakState.mid.avgDecay);
      peakState.treble.runningAvg = peakState.treble.runningAvg * peakState.treble.avgDecay + bandEnergy.treble * (1 - peakState.treble.avgDecay);
    }).then(unsub => { unlisten = unsub; });

    setTimeout(() => {
      if (!destroyed) spectrumSubscribe();
    }, 200);

    // ── Render loop ──
    const startTime = performance.now();
    function frame() {
      if (destroyed) return;
      animId = requestAnimationFrame(frame);

      // Resize canvas to viewport (DPR-aware)
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const cssW = canvasRef!.clientWidth;
      const cssH = canvasRef!.clientHeight;
      const targetW = Math.max(1, Math.floor(cssW * dpr));
      const targetH = Math.max(1, Math.floor(cssH * dpr));
      if (canvasRef!.width !== targetW || canvasRef!.height !== targetH) {
        canvasRef!.width = targetW;
        canvasRef!.height = targetH;
      }

      // Half-res FBO sized to canvas × resolutionScale
      const fboTargetW = Math.max(1, Math.floor(targetW * cfg.resolutionScale));
      const fboTargetH = Math.max(1, Math.floor(targetH * cfg.resolutionScale));
      ensureFbo(fboTargetW, fboTargetH);

      // Pause: decay band energies smoothly to zero. Time keeps advancing
      // so domain warping stays alive (subtle background motion).
      if (!player.isPlaying) {
        bandEnergy.bass *= 0.92;
        bandEnergy.mid *= 0.92;
        bandEnergy.treble *= 0.92;
      }

      const tSec = (performance.now() - startTime) / 1000;

      // ASR envelope step. Targets decay slowly on their own; the shader-
      // bound `impulse` lerps toward target with attack-fast / release-
      // slow asymmetric rates. Net effect: each peak is a smooth pulse
      // (rises in ~80ms, falls in ~170ms) instead of a 1-frame flash.
      impulseTarget.bass   *= IMPULSE_TARGET_DECAY;
      impulseTarget.mid    *= IMPULSE_TARGET_DECAY;
      impulseTarget.treble *= IMPULSE_TARGET_DECAY;

      if (player.isPlaying) {
        const checkBand = (band: "bass" | "mid" | "treble", energy: number) => {
          const ps = peakState[band];
          if (energy < PEAK_FLOOR) return;
          const ratio = ps.runningAvg > 0.05 ? energy / ps.runningAvg : 0;
          if (ratio > PEAK_THRESHOLD && (tSec - ps.lastPeakT) > ps.cooldown) {
            ps.lastPeakT = tSec;
            const strength = Math.min(1.5, Math.max(0.4, ratio - 1.0));
            // Set TARGET (not impulse directly). The envelope ramps to it.
            // Take max so a still-active target from a previous peak is
            // upgraded if the new one is stronger, but never downgraded.
            impulseTarget[band] = Math.max(impulseTarget[band], strength);
          }
        };
        checkBand("bass",   bandEnergy.bass);
        checkBand("mid",    bandEnergy.mid);
        checkBand("treble", bandEnergy.treble);
      }

      // Lerp current impulse toward target with asymmetric attack/release.
      const lerpEnvelope = (current: number, target: number): number => {
        const rate = target > current ? IMPULSE_ATTACK_RATE : IMPULSE_RELEASE_RATE;
        return current + (target - current) * rate;
      };
      impulse.bass   = lerpEnvelope(impulse.bass,   impulseTarget.bass);
      impulse.mid    = lerpEnvelope(impulse.mid,    impulseTarget.mid);
      impulse.treble = lerpEnvelope(impulse.treble, impulseTarget.treble);

      // Pass 1: SDF → half-res FBO
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, fbo);
      gl!.viewport(0, 0, fboW, fboH);
      setupAttrib(sdfProg);
      gl!.uniform1f(uLoc.time, tSec);
      gl!.uniform1f(uLoc.aspect, fboW / fboH);
      gl!.uniform1f(uLoc.bass, bandEnergy.bass);
      gl!.uniform1f(uLoc.mid, bandEnergy.mid);
      gl!.uniform1f(uLoc.treble, bandEnergy.treble);
      gl!.uniform1f(uLoc.baseHue, baseHue);
      gl!.uniform1f(uLoc.warpInt, cfg.warpIntensity);
      gl!.uniform1f(uLoc.warpFreq, cfg.warpFrequency);
      gl!.uniform1f(uLoc.smoothK, cfg.smoothK);
      gl!.uniform1f(uLoc.emissive, cfg.emissiveBoost);
      gl!.uniform1f(uLoc.maxDist, cfg.maxDist);
      gl!.uniform1i(uLoc.stepCount, cfg.stepCount);
      gl!.uniform1i(uLoc.renderMode, cfg.renderMode);
      gl!.uniform1f(uLoc.bassImpulse,   impulse.bass);
      gl!.uniform1f(uLoc.midImpulse,    impulse.mid);
      gl!.uniform1f(uLoc.trebleImpulse, impulse.treble);
      gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);

      // Pass 2: upscale FBO → canvas (linear filter)
      gl!.bindFramebuffer(gl!.FRAMEBUFFER, null);
      gl!.viewport(0, 0, targetW, targetH);
      setupAttrib(upProg);
      gl!.activeTexture(gl!.TEXTURE0);
      gl!.bindTexture(gl!.TEXTURE_2D, fboTex);
      gl!.uniform1i(uTextureLoc, 0);
      gl!.drawArrays(gl!.TRIANGLE_STRIP, 0, 4);
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
