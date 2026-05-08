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
  SIM_RESOLUTION: 256,
  DYE_RESOLUTION: 1024,
  DENSITY_DISSIPATION: 1.5,    // Moderate decay — visible but not permanent
  VELOCITY_DISSIPATION: 0.3,   // Velocity fades to prevent runaway motion
  PRESSURE: 0.8,
  PRESSURE_ITERATIONS: 20,
  CURL: 30,                    // Gentle vortices, not chaotic spin
  SPLAT_RADIUS: 0.15,          // Small splats that blend as they move
  SPLAT_FORCE: 150,            // Gentle push — visible movement, not wind
  COLOR_INTENSITY: 5.0,        // Moderate — builds up through multiple splats
  SENSITIVITY: 0.25,
};

// ── FFT config ──

const RAW_BANDS = 1024;
const LOG_BANDS = 128;
const AGC_DECAY = 0.985;
const AGC_FLOOR = 3.0;
const NUM_EMITTERS = 4;

// ── Shape emitter: a point on the image that emits fluid ──

interface Emitter {
  x: number;      // 0-1 normalized position
  y: number;
  dirX: number;   // Sobel gradient direction (normalized)
  dirY: number;
  brightness: number; // 0-1, how bright = how strong
}

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

// Extract emitter positions from shape image: brightest points with Y flipped for WebGL UV
function extractEmitters(img: HTMLImageElement, count: number): Emitter[] {
  const sampleW = 64, sampleH = 64;
  const offscreen = document.createElement("canvas");
  offscreen.width = sampleW;
  offscreen.height = sampleH;
  const ctx = offscreen.getContext("2d")!;

  ctx.filter = "saturate(0) blur(2px)";
  ctx.drawImage(img, 0, 0, sampleW, sampleH);
  const imgData = ctx.getImageData(0, 0, sampleW, sampleH);

  const brightness = new Float32Array(sampleW * sampleH);
  for (let i = 0; i < sampleW * sampleH; i++) {
    const idx = i * 4;
    brightness[i] = (0.2126 * imgData.data[idx] + 0.7152 * imgData.data[idx + 1] + 0.0722 * imgData.data[idx + 2]) / 255;
  }

  const candidates: Emitter[] = [];
  for (let y = 2; y < sampleH - 2; y++) {
    for (let x = 2; x < sampleW - 2; x++) {
      const i = y * sampleW + x;
      if (brightness[i] < 0.15) continue;
      candidates.push({
        x: x / sampleW,
        y: 1.0 - (y / sampleH),  // Flip Y: canvas top-down → WebGL UV bottom-up
        dirX: 0,
        dirY: 0,
        brightness: brightness[i],
      });
    }
  }

  if (candidates.length === 0) return [];
  candidates.sort((a, b) => b.brightness - a.brightness);

  const selected: Emitter[] = [];
  const minDist = 0.15;
  for (const c of candidates) {
    if (selected.length >= count) break;
    const tooClose = selected.some(s =>
      Math.abs(s.x - c.x) < minDist && Math.abs(s.y - c.y) < minDist
    );
    if (!tooClose) selected.push(c);
  }

  return selected;
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
  const smoothed = new Float32Array(7); // 7 frequency regions
  let baseHue = 0.7;

  // Shape state
  let emitters: Emitter[] = [];
  let shapeImage: HTMLImageElement | null = null;
  let colorTex: WebGLTexture | null = null;
  let hasShape = false;

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
      console.log(`[fluid] config updated: dissipation=${c.fluid_density_dissipation} curl=${c.fluid_curl} force=${c.fluid_splat_force} color=${c.fluid_color_intensity}`);
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

    // Shape loading
    createEffect(() => {
      const url = props.shapeUrl;
      if (!url) { hasShape = false; return; }
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => {
        shapeImage = img;
        emitters = extractEmitters(img, NUM_EMITTERS);
        // Upload color texture for background pass
        colorTex = engine.uploadColorTexture(img);
        engine.uploadShapeMask(img);
        hasShape = true;
        console.log(`[fluid] loaded shape: ${emitters.length} emitters extracted`);
      };
      img.src = url;
    });

    // FFT → splats: exact FluidSimPlusPlus approach
    // Bass energy differential → splat count. Random positions. dx/dy = 1000 * random.
    let lastBassLevel = 0;
    let splatIdx = 0; // Cycles through emitters sequentially
    onAudioFft((payload: FftPayload) => {
      const len = Math.min(payload.magnitudes.length, RAW_BANDS);
      for (let i = 0; i < len; i++) {
        const v = payload.magnitudes[i];
        runningAvg[i] = runningAvg[i] * AGC_DECAY + v * (1 - AGC_DECAY);
        const avg = Math.max(runningAvg[i], AGC_FLOOR);
        rawFft[i] = Math.min(255, (v / avg) * 128);
      }

      // Sum bass energy (first FREQ_RANGE bins), normalize
      let bass = 0;
      const freqRange = 40;
      const freqMulti = 0.1;
      for (let i = 0; i < freqRange && i < LOG_BANDS; i++) {
        bass += (rawFft[i] / 255) * 2;
      }
      bass /= freqRange * 2 * freqMulti;

      // Differential: only splat on energy RISE
      const currentLevel = Math.floor(bass * fluidCfg.SENSITIVITY * 10);
      const splatCount = Math.max(0, currentLevel - lastBassLevel);
      lastBassLevel = currentLevel;

      // Background pulse
      engine.setBassEnergy(Math.min(1.0, bass * 0.3));

      if (splatCount === 0 || emitters.length === 0) return;

      // Shape-guided: splat at emitter positions (flame tips), max 2 per beat
      // Emitters cycle sequentially for spatial coherence
      for (let s = 0; s < Math.min(splatCount, 2); s++) {
        const em = emitters[splatIdx % emitters.length];
        splatIdx++;

        const color = generateColor(baseHue, s, 2);
        color.r *= fluidCfg.COLOR_INTENSITY;
        color.g *= fluidCfg.COLOR_INTENSITY;
        color.b *= fluidCfg.COLOR_INTENSITY;

        // Upward bias: -π/2 = screen-up (Y inverted in splat shader)
        // ±60° spread for organic turbulence, gentle force
        const angle = -(Math.PI / 2) + (Math.random() - 0.5) * (Math.PI / 1.5);
        const dx = Math.cos(angle) * fluidCfg.SPLAT_FORCE;
        const dy = Math.sin(angle) * fluidCfg.SPLAT_FORCE;

        engine.splat(em.x, em.y, dx, dy, color, fluidCfg.SPLAT_RADIUS);
      }
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

      engine.step(dt);
      if (hasShape && colorTex) {
        engine.renderWithBackground(colorTex);
      } else {
        engine.render();
      }
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
