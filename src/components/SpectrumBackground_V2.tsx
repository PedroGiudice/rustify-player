import { onMount, onCleanup, createEffect, createSignal } from "solid-js";
import { onAudioFft, spectrumSubscribe, spectrumUnsubscribe, getTrackColor, FftPayload } from "../tauri";
import type { SpectrumVisualConfig } from "../tauri";
import { player } from "../store/player";

const RAW_BANDS = 1024; // matches FFT_SIZE/2 from backend (2048-pt FFT)
const LOG_BANDS = 256;

function buildLogBinMap(exponent: number): [number, number][] {
  const map: [number, number][] = [];
  for (let i = 0; i < LOG_BANDS; i++) {
    const t = i / LOG_BANDS;
    const startFrac = Math.pow(t, exponent);
    const endFrac = Math.pow((i + 1) / LOG_BANDS, exponent);
    const start = Math.floor(startFrac * RAW_BANDS);
    const end = Math.max(start + 1, Math.floor(endFrac * RAW_BANDS));
    map.push([start, end]);
  }
  return map;
}

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
  return h * 360;
}

const VERT_SRC = `#version 300 es
precision highp float;
in vec2 a_grid;
uniform sampler2D u_normalMap;
uniform sampler2D u_fft;
uniform vec2 u_resolution;
// Tunable uniforms from config
uniform float u_baseStrength;
uniform float u_energyMult;
uniform float u_bassMult;
uniform float u_lowMidMult;
uniform float u_compBass;
uniform float u_compDefault;
uniform sampler2D u_regions; // 9×1 R32F texture with region boundaries
uniform float u_logBands;   // number of log bands (texture width)
uniform float u_brightnessRigidity; // how much bright areas resist audio (0=none, 1=full)
uniform float u_bassReactivityBoost; // extra mult for bass regions
uniform float u_invertDepth; // 1.0=inverted (bass at bottom), 0.0=normal

out float v_depth;
out float v_energy;

void main() {
    vec4 nm = texture(u_normalMap, a_grid);
    float bright = nm.r;
    float dirX = nm.g * 2.0 - 1.0;
    float dirY = nm.b * 2.0 - 1.0;

    float depth = mix(a_grid.y, 1.0 - a_grid.y, u_invertDepth);
    float regionF = depth * 9.0;
    int region = min(int(regionF), 8);

    // Read region boundaries from texture (start in R, end in G)
    float regStart = texelFetch(u_regions, ivec2(region, 0), 0).r;
    float regEnd = texelFetch(u_regions, ivec2(region, 0), 0).g;
    float mid = (regStart + regEnd) * 0.5 / u_logBands;
    float energy = texture(u_fft, vec2(mid, 0.5)).r;

    int prevR = max(region - 1, 0);
    int nextR = min(region + 1, 8);
    float prevMid = (texelFetch(u_regions, ivec2(prevR, 0), 0).r + texelFetch(u_regions, ivec2(prevR, 0), 0).g) * 0.5 / u_logBands;
    float nextMid = (texelFetch(u_regions, ivec2(nextR, 0), 0).r + texelFetch(u_regions, ivec2(nextR, 0), 0).g) * 0.5 / u_logBands;
    float prevE = texture(u_fft, vec2(prevMid, 0.5)).r;
    float nextE = texture(u_fft, vec2(nextMid, 0.5)).r;
    float blended = prevE * 0.2 + energy * 0.6 + nextE * 0.2;

    float regionT = float(region) / 8.0; 
    float compression = mix(u_compBass, u_compDefault * 0.7, regionT); 
    float compHigh = min(u_compBass, u_compDefault) * 0.8; 
    compression = mix(u_compBass, compHigh, smoothstep(0.2, 0.8, regionT));
    float compressed = pow(max(blended, 0.001), compression);

    // Bright areas = rigid anchor (shape holds form), dark areas = free to dance with audio
    float reactivity = 1.0 - bright * u_brightnessRigidity;
    // Bass regions get extra reactivity boost — they drive the visual pulse
    float bassBoost = mix(u_bassReactivityBoost, 1.0, smoothstep(0.0, 0.3, regionT));
    float mult = mix(u_bassMult, 1.0, smoothstep(0.0, 0.5, regionT));
    float strength = (0.15 + bright * 0.85) * (u_baseStrength + compressed * u_energyMult * reactivity * bassBoost) * mult;

    // Fade displacement at grid edges to avoid hard cutoff at canvas borders
    float edgeFade = smoothstep(0.0, 0.08, a_grid.y) * smoothstep(1.0, 0.92, a_grid.y)
                   * smoothstep(0.0, 0.05, a_grid.x) * smoothstep(1.0, 0.95, a_grid.x);
    strength *= edgeFade;

    vec2 base = a_grid * u_resolution;
    vec2 displaced = base + vec2(dirX, dirY) * strength;

    vec2 ndc = (displaced / u_resolution) * 2.0 - 1.0;
    ndc.y = -ndc.y;
    gl_Position = vec4(ndc, 0.0, 1.0);
    // Point size for dust mode — grows with energy, base 1.5px
    gl_PointSize = 1.5 + compressed * 3.5;
    v_depth = depth;
    v_energy = compressed;
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;
in float v_depth;
in float v_energy;
uniform float u_baseHue;
uniform float u_hueSpread;
uniform float u_saturation;
uniform float u_baseAlpha;
uniform float u_depthAlpha;
uniform float u_energyAlpha;
uniform float u_baseLightness;
uniform float u_depthLightness;
uniform float u_energyLightness;
uniform float u_dustMode; // 1.0 = point particles with soft circle, 0.0 = lines
uniform float u_overlayAlpha; // global multiplier for foreground (1.0 default; per-shape override via manifest)
out vec4 fragColor;

vec3 hsl2rgb(float h, float s, float l) {
    float c = (1.0 - abs(2.0 * l - 1.0)) * s;
    float x = c * (1.0 - abs(mod(h / 60.0, 2.0) - 1.0));
    float m = l - c * 0.5;
    vec3 rgb;
    if (h < 60.0) rgb = vec3(c, x, 0.0);
    else if (h < 120.0) rgb = vec3(x, c, 0.0);
    else if (h < 180.0) rgb = vec3(0.0, c, x);
    else if (h < 240.0) rgb = vec3(0.0, x, c);
    else if (h < 300.0) rgb = vec3(x, 0.0, c);
    else rgb = vec3(c, 0.0, x);
    return rgb + m;
}

void main() {
    float hue = mod(u_baseHue + v_depth * u_hueSpread, 360.0);
    float alpha = u_baseAlpha + v_depth * u_depthAlpha + v_energy * u_energyAlpha;
    float lightness = (u_baseLightness + v_depth * u_depthLightness + v_energy * u_energyLightness) / 100.0;
    vec3 color = hsl2rgb(hue, u_saturation, lightness);

    // Dust mode: soft circle from gl_PointCoord, discard corners
    if (u_dustMode > 0.5) {
        float dist = distance(gl_PointCoord, vec2(0.5));
        if (dist > 0.5) discard;
        alpha *= smoothstep(0.5, 0.1, dist); // soft glow falloff
    }

    fragColor = vec4(color, alpha * u_overlayAlpha);
}
`;

// Shaders para o Background Quad (A Imagem Original)
const BG_VERT_SRC = `#version 300 es
precision highp float;
in vec2 a_pos;
out vec2 v_uv;
void main() {
    v_uv = a_pos * 0.5 + 0.5;
    v_uv.y = 1.0 - v_uv.y; // Flip Y para a imagem
    gl_Position = vec4(a_pos, 0.0, 1.0);
}
`;

const BG_FRAG_SRC = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_colorMap;
uniform float u_globalEnergy;
uniform float u_bgDimming;
uniform float u_bgPulseStrength;
out vec4 fragColor;
void main() {
    vec4 color = texture(u_colorMap, v_uv);
    float dimming = u_bgDimming - (u_globalEnergy * u_bgPulseStrength);
    fragColor = vec4(color.rgb * dimming, 1.0);
}
`;

function compileShader(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader | null {
  const s = gl.createShader(type);
  if (!s) return null;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error("Shader compile:", gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function linkProgram(gl: WebGL2RenderingContext, vSrc: string, fSrc: string, attribName: string = "a_grid"): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, vSrc);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, fSrc);
  if (!vs || !fs) return null;
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, attribName);
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error("Program link:", gl.getProgramInfoLog(prog));
    return null;
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

// Default config — used until a preset is loaded
const DEFAULT_CONFIG: SpectrumVisualConfig = {
  name: "Default",
  lines: 150,
  points_per_line: 120,
  attack: 0.35,
  release: 0.06,
  release_bass: 0.043,
  log_exponent: 1.5,
  bass_bin_threshold: 40,
  base_strength: 12.0,
  energy_multiplier: 220.0,
  bass_multiplier: 1.6,
  low_mid_multiplier: 1.3,
  compression_bass: 0.55,
  compression_default: 0.75,
  hue_spread: 20.0,
  saturation: 0.85,
  base_alpha: 0.12,
  depth_alpha: 0.2,
  energy_alpha: 0.15,
  base_lightness: 38.0,
  depth_lightness: 18.0,
  energy_lightness: 12.0,
  regions: [[0,6],[6,16],[16,32],[32,56],[56,84],[84,120],[120,168],[168,216],[216,256]],
  // V2 params
  style: "exoskeleton",
  brightness_rigidity: 0.7,
  bass_reactivity_boost: 1.4,
  bass_attack_scale: 0.43,
  invert_depth: true,
  bg_dimming: 0.45,
  bg_pulse_strength: 0.25,
  gravity_decay: 1.5,
  agc_decay: 0.985,
  agc_floor: 3.0,
};

interface Props {
  shapeUrl?: string | null;
  config?: SpectrumVisualConfig | null;
}

export default function SpectrumBackground(props: Props) {
  let canvas: HTMLCanvasElement | undefined;
  let gl: WebGL2RenderingContext | null = null;
  let program: WebGLProgram | null = null;
  let bgProgram: WebGLProgram | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let vbo: WebGLBuffer | null = null;
  let quadVao: WebGLVertexArrayObject | null = null;
  let quadVbo: WebGLBuffer | null = null;
  let normalTex: WebGLTexture | null = null;
  let fftTex: WebGLTexture | null = null;
  let regionsTex: WebGLTexture | null = null;
  let colorTex: WebGLTexture | null = null; // A textura da imagem real
  let animId = 0;
  let destroyed = false;
  let unlisten: (() => void) | null = null;

  const u: Record<string, WebGLUniformLocation | null> = {};

  const rawFft = new Uint8Array(RAW_BANDS);
  const normalizedFft = new Float32Array(RAW_BANDS);
  const runningAvg = new Float32Array(RAW_BANDS);    
  const smoothed = new Float32Array(LOG_BANDS);
  const fftUpload = new Uint8Array(LOG_BANDS);
  // AGC params now come from cfg.agc_decay / cfg.agc_floor
  let baseHue = 260;
  let hasNormalMap = false;

  let cfg: typeof DEFAULT_CONFIG = { ...DEFAULT_CONFIG };
  let logBinMap = buildLogBinMap(cfg.log_exponent);
  let curLines = cfg.lines;
  let curPoints = cfg.points_per_line;

  // Animated shape state — populated when shapeUrl points to a directory
  // containing manifest.json + normal_*.png. Each frame is a pre-packed
  // RGB normal map (R=brightness, G=normal_x, B=normal_y) loaded once into
  // GPU as a separate texture; runtime swaps the binding by frame index.
  type AnimShape = {
    frames: WebGLTexture[];
    colorFrames: WebGLTexture[]; // optional; empty array if not provided by manifest
    dim: number;
    duration: number;            // seconds
    intensityRanking: number[];  // frame indices sorted dim → bright; empty if not classified
    bandGroups: { bass: number[]; mid: number[]; treble: number[] };
    overlayAlpha: number;        // multiplier (0..1) for wireframe/dust foreground pass; 1.0 = unchanged
    hideOverlay: boolean;        // when true, skip the foreground pass entirely (sprite-only mode)
  };
  let animShape: AnimShape | null = null;
  let animFrameIndex = 0;
  // Pendulum/spring state — peaks inject velocity in alternating direction;
  // damped harmonic oscillator returns the face to the neutral (front-facing)
  // frame between peaks. Repeated transients produce natural vai-e-volta.
  let animDisplacement = 0;   // -1 to +1, normalized offset from neutral frame
  let animVelocity = 0;       // displacement velocity per render frame
  let animPeakDirection = 1;  // sign flips each peak: -1 = right, +1 = left
  let animLastEnergy = 0;     // raw bass energy from previous frame (for delta detection)
  let animTargetFloat = 0;    // smoothed target frame index for intensity / band_split modes
  let animPhase = 0;          // 0..1 phase accumulator for band_split continuous cycling

  createEffect(async () => {
    const track = player.currentTrack;
    if (!track) return;
    try {
      const hex = await getTrackColor(track.id);
      if (hex?.startsWith("#")) baseHue = hexToHue(hex);
    } catch {}
  });

  createEffect(() => {
    const newCfg = props.config;
    if (!newCfg) return;
    const needsGridRebuild = newCfg.lines !== curLines || newCfg.points_per_line !== curPoints;
    const needsBinRebuild = newCfg.log_exponent !== cfg.log_exponent;

    cfg = { ...DEFAULT_CONFIG, ...newCfg };
    console.log(`[spectrum] style="${cfg.style}" brightness_rigidity=${cfg.brightness_rigidity} invert_depth=${cfg.invert_depth}`);

    if (needsBinRebuild) {
      logBinMap = buildLogBinMap(cfg.log_exponent);
    }
    if (needsGridRebuild && gl) {
      curLines = cfg.lines;
      curPoints = cfg.points_per_line;
      rebuildGrid();
    }
    if (gl && regionsTex) {
      uploadRegions();
    }
  });

  function resolveUniforms() {
    if (!gl || !program) return;
    const names = [
      "u_resolution", "u_baseHue", "u_normalMap", "u_fft", "u_regions",
      "u_logBands",
      "u_baseStrength", "u_energyMult", "u_bassMult", "u_lowMidMult",
      "u_compBass", "u_compDefault",
      "u_hueSpread", "u_saturation",
      "u_baseAlpha", "u_depthAlpha", "u_energyAlpha",
      "u_baseLightness", "u_depthLightness", "u_energyLightness",
      "u_brightnessRigidity", "u_bassReactivityBoost", "u_invertDepth",
      "u_dustMode", "u_overlayAlpha",
    ];
    for (const name of names) {
      u[name] = gl.getUniformLocation(program, name);
    }
  }

  function rebuildGrid() {
    if (!gl) return;
    const verts = new Float32Array(curLines * curPoints * 2);
    let idx = 0;
    for (let j = 0; j < curLines; j++) {
      for (let i = 0; i < curPoints; i++) {
        verts[idx++] = i / (curPoints - 1);
        verts[idx++] = j / (curLines - 1);
      }
    }
    if (!vao) vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    if (!vbo) vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  function uploadRegions() {
    if (!gl || !regionsTex) return;
    const data = new Float32Array(cfg.regions.length * 2);
    for (let i = 0; i < cfg.regions.length; i++) {
      data[i * 2] = cfg.regions[i][0];
      data[i * 2 + 1] = cfg.regions[i][1];
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, regionsTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, cfg.regions.length, 1, 0, gl.RG, gl.FLOAT, data);
  }

  function initWebGL() {
    if (!canvas) return;
    gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
    if (!gl) return;

    gl.getExtension("EXT_color_buffer_float");

    program = linkProgram(gl, VERT_SRC, FRAG_SRC, "a_grid");
    bgProgram = linkProgram(gl, BG_VERT_SRC, BG_FRAG_SRC, "a_pos");
    if (!program || !bgProgram) return;

    resolveUniforms();

    // Cache bgProgram uniform locations (resolved once, not per frame)
    u["bg_u_colorMap"] = gl.getUniformLocation(bgProgram, "u_colorMap");
    u["bg_u_globalEnergy"] = gl.getUniformLocation(bgProgram, "u_globalEnergy");
    u["bg_u_bgDimming"] = gl.getUniformLocation(bgProgram, "u_bgDimming");
    u["bg_u_bgPulseStrength"] = gl.getUniformLocation(bgProgram, "u_bgPulseStrength");

    // Setup Quad para o Background Pass
    const quadVerts = new Float32Array([-1, -1,  1, -1,  -1, 1,  1, 1]);
    quadVao = gl.createVertexArray();
    gl.bindVertexArray(quadVao);
    quadVbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
    gl.bufferData(gl.ARRAY_BUFFER, quadVerts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    curLines = cfg.lines;
    curPoints = cfg.points_per_line;
    rebuildGrid();

    // Normal map texture
    normalTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, normalTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE, new Uint8Array([128, 128, 128]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // FFT texture
    fftTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, fftTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, LOG_BANDS, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(LOG_BANDS));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Regions texture (RG32F, 9×1)
    regionsTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, regionsTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    uploadRegions();
  }

  function disposeAnimShape() {
    if (!animShape || !gl) {
      animShape = null;
      return;
    }
    for (const tex of animShape.frames) gl.deleteTexture(tex);
    for (const tex of animShape.colorFrames) gl.deleteTexture(tex);
    animShape = null;
    animFrameIndex = 0;
    animDisplacement = 0;
    animVelocity = 0;
    animPeakDirection = 1;
    animLastEnergy = 0;
  }

  async function loadAnimatedShape(baseUrl: string) {
    disposeAnimShape();
    if (!gl) return;

    const manifestUrl = `${baseUrl}/manifest.json`;
    const manifest = await fetch(manifestUrl).then(r => r.json()).catch(() => null);
    if (!manifest || !manifest.frames || !manifest.dim) return;

    const dim: number = manifest.dim;
    const frameCount: number = manifest.frames;
    const duration: number = manifest.duration_seconds ?? frameCount / 24;

    // Color texture: representative frame for the bg pass
    const colorImg = new Image();
    colorImg.crossOrigin = "anonymous";
    colorImg.src = `${baseUrl}/color.png`;
    await new Promise<void>((resolve) => {
      colorImg.onload = () => resolve();
      colorImg.onerror = () => resolve();
    });
    if (gl && colorImg.naturalWidth > 0) {
      if (!colorTex) colorTex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, colorTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, colorImg);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    const frames: WebGLTexture[] = [];
    const colorFrames: WebGLTexture[] = [];
    const hasColorFrames: boolean = manifest.color_frames === true;

    for (let i = 0; i < frameCount; i++) {
      const idx = String(i).padStart(4, "0");

      const normalImg = new Image();
      normalImg.crossOrigin = "anonymous";
      normalImg.src = `${baseUrl}/normal_${idx}.png`;
      await new Promise<void>((resolve) => {
        normalImg.onload = () => resolve();
        normalImg.onerror = () => resolve();
      });
      if (!gl) return;
      const tex = gl.createTexture();
      if (!tex) continue;
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, gl.RGB, gl.UNSIGNED_BYTE, normalImg);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      frames.push(tex);

      if (hasColorFrames) {
        const colorFrameImg = new Image();
        colorFrameImg.crossOrigin = "anonymous";
        colorFrameImg.src = `${baseUrl}/color_${idx}.jpg`;
        await new Promise<void>((resolve) => {
          colorFrameImg.onload = () => resolve();
          colorFrameImg.onerror = () => resolve();
        });
        if (!gl) return;
        if (colorFrameImg.naturalWidth > 0) {
          const ctex = gl.createTexture();
          if (ctex) {
            gl.bindTexture(gl.TEXTURE_2D, ctex);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, colorFrameImg);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
            colorFrames.push(ctex);
          }
        }
      }
    }

    if (frames.length === 0) return;
    const intensityRanking: number[] = Array.isArray(manifest.intensity_ranking) ? manifest.intensity_ranking : [];
    const bandGroupsRaw = manifest.band_groups ?? {};
    const bandGroups = {
      bass: Array.isArray(bandGroupsRaw.bass) ? bandGroupsRaw.bass : [],
      mid: Array.isArray(bandGroupsRaw.mid) ? bandGroupsRaw.mid : [],
      treble: Array.isArray(bandGroupsRaw.treble) ? bandGroupsRaw.treble : [],
    };
    const overlayAlphaRaw = typeof manifest.overlay_alpha === "number" ? manifest.overlay_alpha : 1.0;
    const overlayAlpha = Math.max(0.0, Math.min(1.0, overlayAlphaRaw));
    const hideOverlay: boolean = manifest.hide_overlay === true;
    animShape = { frames, colorFrames, dim, duration, intensityRanking, bandGroups, overlayAlpha, hideOverlay };
    hasNormalMap = true;
  }

  function isAnimatedShapeUrl(url: string): boolean {
    // Directory shapes have no file extension and end with the shape name only.
    // The HTTP server resolves them to media/shapes/<name>/ where manifest.json lives.
    return !/\.[a-zA-Z0-9]{1,5}(\?|$)/.test(url);
  }

  function loadShape(url: string) {
    if (isAnimatedShapeUrl(url)) {
      loadAnimatedShape(url);
      return;
    }

    disposeAnimShape();
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (!gl || !normalTex) return;

      // -- Passo 1: Upload da textura de Cor Original para o Background (Color Map) --
      // Usa resolucao nativa da imagem — renderizado uma unica vez, sem custo recorrente.
      // Esticar 120x150 pra fullscreen causa blur visivel; a nativa preserva detalhes.
      const colorCanvas = document.createElement("canvas");
      colorCanvas.width = img.naturalWidth;
      colorCanvas.height = img.naturalHeight;
      const colorCtx = colorCanvas.getContext("2d")!;
      colorCtx.drawImage(img, 0, 0);

      if (!colorTex) colorTex = gl.createTexture();
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, colorTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, colorCanvas);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      // -- Passo 2: Blur Aditivo para formar o Height Map --
      // Normal map usa curPoints x curLines para alinhar com a grid de vertices.
      const offscreen = document.createElement("canvas");
      offscreen.width = curPoints;
      offscreen.height = curLines;
      const octx = offscreen.getContext("2d")!;
      octx.filter = "saturate(0)";
      octx.drawImage(img, 0, 0, curPoints, curLines);
      
      octx.globalCompositeOperation = 'lighter';
      octx.globalAlpha = 0.5;
      octx.filter = "blur(16px)";
      octx.drawImage(img, 0, 0, curPoints, curLines);
      
      octx.globalAlpha = 0.7;
      octx.filter = "blur(6px)";
      octx.drawImage(img, 0, 0, curPoints, curLines);
      
      const imgData = octx.getImageData(0, 0, curPoints, curLines);
      const w = imgData.width, h = imgData.height;
      const brightness = new Float32Array(w * h);
      const packed = new Uint8Array(w * h * 3);

      for (let i = 0; i < w * h; i++) {
        const idx = i * 4;
        let b = (0.2126 * imgData.data[idx] + 0.7152 * imgData.data[idx+1] + 0.0722 * imgData.data[idx+2]) / 255;
        // Deterministic dithering — avoids non-reproducible output from Math.random()
        const noise = ((Math.sin(i * 43758.5453) * 43758.5453) % 1) * 0.06 - 0.03;
        b += noise;
        brightness[i] = Math.max(0, Math.min(1, b));
      }

      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          const gx = -brightness[(y-1)*w+(x-1)] + brightness[(y-1)*w+(x+1)]
                    -2*brightness[y*w+(x-1)] + 2*brightness[y*w+(x+1)]
                    -brightness[(y+1)*w+(x-1)] + brightness[(y+1)*w+(x+1)];
          const gy = -brightness[(y-1)*w+(x-1)] - 2*brightness[(y-1)*w+x] - brightness[(y-1)*w+(x+1)]
                    + brightness[(y+1)*w+(x-1)] + 2*brightness[(y+1)*w+x] + brightness[(y+1)*w+(x+1)];
          const mag = Math.sqrt(gx*gx + gy*gy);
          
          let nx = 0.5, ny = 0.5;
          if (mag > 0.005) {
            nx = (-gy / mag) * 0.5 + 0.5;
            ny = (gx / mag) * 0.5 + 0.5;
          }
          packed[i*3] = Math.floor(brightness[i] * 255);
          packed[i*3+1] = Math.floor(nx * 255);
          packed[i*3+2] = Math.floor(ny * 255);
        }
      }

      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, normalTex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, w, h, 0, gl.RGB, gl.UNSIGNED_BYTE, packed);
      hasNormalMap = true;
    };
    img.src = url;
  }

  function resize() {
    if (!canvas || !gl) return;
    const w = canvas.clientWidth * devicePixelRatio;
    const h = canvas.clientHeight * devicePixelRatio;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
      gl.viewport(0, 0, w, h);
    }
  }

  function draw() {
    if (destroyed) return;
    animId = requestAnimationFrame(draw);
    if (!gl || !program || !vao) return;

    let bassEnergy = 0;
    for (let i = 0; i < LOG_BANDS; i++) {
      const [start, end] = logBinMap[i];
      let max = 0;
      for (let j = start; j < end && j < RAW_BANDS; j++) {
        if (rawFft[j] > max) max = rawFft[j];
      }
      const isBass = i < cfg.bass_bin_threshold;
      const release = isBass ? cfg.release_bass : cfg.release;
      // Bass attack slower (0.15 vs 0.35) — rises as a wave, not a spike
      const attack = isBass ? cfg.attack * cfg.bass_attack_scale : cfg.attack;
      const rate = max > smoothed[i] ? attack : release;
      smoothed[i] += (max - smoothed[i]) * rate;
      smoothed[i] = Math.max(0, smoothed[i] - cfg.gravity_decay);
      fftUpload[i] = Math.min(255, Math.floor(smoothed[i]));
      
      // Accumulate sub-bass energy to pulse the background
      if (i < 40) bassEnergy += smoothed[i];
    }
    const globalEnergy = Math.min(1.0, bassEnergy / (40.0 * 255.0));

    // Animated shape rotation: continuous baseline so motion is always visible,
    // plus an energy-modulated speed boost and ASR peak kicks for transient bursts.
    // Compose: position += baseline + energy_gain*E + peak_kick (frames per render frame).
    if (animShape && animShape.frames.length > 0) {
      const N = animShape.frames.length;
      const mode = (cfg as SpectrumVisualConfig).shape_anim_mode ?? "intensity";

      // Common signals available to all modes.
      let rawBass = 0;
      const rawBassBins = 40;
      for (let i = 0; i < rawBassBins; i++) rawBass += rawFft[i];
      const rawE = Math.min(1.0, rawBass / (rawBassBins * 255.0));

      let totalE = 0;
      for (let i = 0; i < LOG_BANDS; i++) totalE += smoothed[i];
      const E = Math.min(1.0, totalE / (LOG_BANDS * 255.0));

      const peakThreshold = (cfg as SpectrumVisualConfig).shape_anim_peak_threshold ?? 0.01;
      const kickGain = (cfg as SpectrumVisualConfig).shape_anim_peak_kick_gain ?? 0.8;
      const energyGain = (cfg as SpectrumVisualConfig).shape_anim_energy_gain ?? 0.4;

      // Ease rate for intensity / band_split modes — repurposed YAML knob.
      // Lower = slower transitions; 0.04 default feels like a deliberate fade
      // instead of a snap. Hot-reloadable via shape_anim_baseline_speed.
      const easeRate = Math.max(0.01, Math.min(0.5, (cfg as SpectrumVisualConfig).shape_anim_baseline_speed ?? 0.04));

      if (mode === "intensity" && animShape.intensityRanking.length === N) {
        // Map smoothed loudness to a rank position in the dim→bright ordering;
        // ease the rank so transitions don't snap. Each kick pulls toward higher
        // rank (more intense visual frame), silence settles to the dimmest.
        const drive = Math.min(1.0, E + rawE * 0.3);
        const targetRank = drive * (N - 1);
        animTargetFloat += (targetRank - animTargetFloat) * easeRate;
        const rankIdx = Math.max(0, Math.min(N - 1, Math.round(animTargetFloat)));
        animFrameIndex = animShape.intensityRanking[rankIdx];
      } else if (mode === "band_split") {
        // Aggregate energy in three FFT regions, pick frame from the dominant
        // band's group; if the shape has no frames classified for that band,
        // fall back to a slice of the intensity ranking (bass=dim, treble=bright)
        // so every frequency drives a visible change.
        let bassE = 0, midE = 0, trebE = 0;
        const bassEnd = Math.floor(LOG_BANDS / 3);
        const midEnd = Math.floor((LOG_BANDS * 2) / 3);
        for (let i = 0; i < bassEnd; i++) bassE += smoothed[i];
        for (let i = bassEnd; i < midEnd; i++) midE += smoothed[i];
        for (let i = midEnd; i < LOG_BANDS; i++) trebE += smoothed[i];
        bassE /= (bassEnd * 255.0);
        midE /= ((midEnd - bassEnd) * 255.0);
        trebE /= ((LOG_BANDS - midEnd) * 255.0);

        // Band selection by dominance.
        let activeBand: "bass" | "mid" | "treble" = "mid";
        let bandAmp = midE;
        if (bassE >= midE && bassE >= trebE) { activeBand = "bass"; bandAmp = bassE; }
        else if (trebE >= midE && trebE >= bassE) { activeBand = "treble"; bandAmp = trebE; }

        // Resolve the frame group for the active band, with intensity-ranking fallback.
        let group: number[] = animShape.bandGroups[activeBand];
        if (group.length === 0 && animShape.intensityRanking.length === N) {
          const r = animShape.intensityRanking;
          if (activeBand === "bass") group = r.slice(0, Math.max(1, Math.floor(N / 3)));
          else if (activeBand === "treble") group = r.slice(Math.max(0, N - Math.floor(N / 3)));
          else group = r.slice(Math.floor(N / 3), Math.max(Math.floor(N / 3) + 1, Math.floor((N * 2) / 3)));
        }
        if (group.length === 0) group = animShape.intensityRanking.length === N ? animShape.intensityRanking : Array.from({length: N}, (_, k) => k);

        // Phase-based cycling within the active band group.
        // Smoothed bandAmp plateaus during steady music — using it as direct
        // position locks the frame. Instead, advance a continuous phase every
        // render frame (baseline) and accelerate ONLY on real transients
        // (delta of rawE above peakThreshold). Both contributions are tightly
        // capped so calibration via shape_anim_baseline_speed stays predictable.
        //
        // baseline: easeRate=0.01 → ~0.0005/frame (1 cycle per ~33s @ 60fps)
        //           easeRate=0.04 → ~0.002/frame  (1 cycle per ~8s)
        //           easeRate=0.10 → ~0.005/frame  (1 cycle per ~3s)
        // kick:     gated by peakThreshold, capped at ~0.02 (=~0.6 frames in
        //           a 32-frame group) so individual kicks stay distinct, not blurry.
        const dRaw = rawE - animLastEnergy;
        const baseline = Math.max(0.0001, easeRate * 0.05);
        const kickBoost = (dRaw > peakThreshold) ? Math.min(0.02, dRaw * kickGain * 0.5) : 0;
        animPhase = (animPhase + baseline + kickBoost) % 1.0;
        // Sensitivity still modulates how much amplitude shifts the cycle position.
        const sensitivity = Math.max(0.0, energyGain * 0.3);
        const ampOffset = bandAmp * sensitivity;
        const pos = (animPhase + ampOffset) % 1.0;
        const idx = Math.max(0, Math.min(group.length - 1, Math.floor(pos * group.length)));
        animFrameIndex = group[idx];
      } else {
        // Pendulum (legacy) — kept for non-classified shapes or explicit mode.
        const damping = (cfg as SpectrumVisualConfig).shape_anim_peak_decay ?? 0.90;
        const spring = Math.max(0.005, (cfg as SpectrumVisualConfig).shape_anim_baseline_speed ?? 0.02) * 2.5;
        const dRaw = rawE - animLastEnergy;
        if (dRaw > peakThreshold) {
          animVelocity += dRaw * kickGain * 2.0 * animPeakDirection;
          animPeakDirection = -animPeakDirection;
        }
        animLastEnergy = rawE;
        animVelocity += -animDisplacement * spring;
        animVelocity *= damping;
        animVelocity += (E - 0.1) * energyGain * 0.02 * animPeakDirection;
        animDisplacement += animVelocity;
        if (animDisplacement > 1) { animDisplacement = 1; animVelocity *= -0.4; }
        if (animDisplacement < -1) { animDisplacement = -1; animVelocity *= -0.4; }
        const halfFrame = Math.floor(N / 4);
        animFrameIndex = Math.max(0, Math.min(N - 1, Math.floor(halfFrame + animDisplacement * halfFrame)));
      }

      // Pendulum & intensity modes use rawE for delta tracking; ensure animLastEnergy is sane.
      animLastEnergy = rawE;
    }

    // Bind the active normal map (animated current frame, or static texture)
    gl.activeTexture(gl.TEXTURE0);
    if (animShape && animShape.frames[animFrameIndex]) {
      gl.bindTexture(gl.TEXTURE_2D, animShape.frames[animFrameIndex]);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, normalTex);
    }

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, fftTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LOG_BANDS, 1, gl.RED, gl.UNSIGNED_BYTE, fftUpload);

    gl.clearColor(0.0, 0.0, 0.0, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // --- Pass 1: Background Image Pass ---
    if (cfg.style !== "wireframe" && hasNormalMap && bgProgram && quadVao && colorTex) {
      gl.useProgram(bgProgram);
      gl.activeTexture(gl.TEXTURE3);
      // Animated shapes bind the color texture matching the current frame so
      // the bg image rotates in lockstep with the wireframe.
      if (animShape && animShape.colorFrames && animShape.colorFrames[animFrameIndex]) {
        gl.bindTexture(gl.TEXTURE_2D, animShape.colorFrames[animFrameIndex]);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, colorTex);
      }
      gl.uniform1i(u["bg_u_colorMap"], 3);
      gl.uniform1f(u["bg_u_globalEnergy"], globalEnergy);
      gl.uniform1f(u["bg_u_bgDimming"], cfg.bg_dimming);
      gl.uniform1f(u["bg_u_bgPulseStrength"], cfg.bg_pulse_strength);
      gl.disable(gl.BLEND);
      gl.bindVertexArray(quadVao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    // --- Pass 2: Foreground Grid Pass ---
    // Per-shape opt-out: shapes with hide_overlay=true are sprite-only (no wireframe).
    if (animShape?.hideOverlay) {
      gl.bindVertexArray(null);
      return;
    }
    gl.useProgram(program);
    gl.uniform2f(u.u_resolution, canvas!.clientWidth, canvas!.clientHeight);
    gl.uniform1f(u.u_baseHue, baseHue);
    gl.uniform1i(u.u_normalMap, 0);
    gl.uniform1i(u.u_fft, 1);
    gl.uniform1i(u.u_regions, 2);
    gl.uniform1f(u.u_logBands, LOG_BANDS);

    gl.uniform1f(u.u_baseStrength, cfg.base_strength);
    gl.uniform1f(u.u_energyMult, cfg.energy_multiplier);
    gl.uniform1f(u.u_bassMult, cfg.bass_multiplier);
    gl.uniform1f(u.u_lowMidMult, cfg.low_mid_multiplier);
    gl.uniform1f(u.u_compBass, cfg.compression_bass);
    gl.uniform1f(u.u_compDefault, cfg.compression_default);
    gl.uniform1f(u.u_hueSpread, cfg.hue_spread);
    gl.uniform1f(u.u_saturation, cfg.saturation);
    gl.uniform1f(u.u_baseAlpha, cfg.base_alpha);
    gl.uniform1f(u.u_depthAlpha, cfg.depth_alpha);
    gl.uniform1f(u.u_energyAlpha, cfg.energy_alpha);
    gl.uniform1f(u.u_baseLightness, cfg.base_lightness);
    gl.uniform1f(u.u_depthLightness, cfg.depth_lightness);
    gl.uniform1f(u.u_energyLightness, cfg.energy_lightness);
    gl.uniform1f(u.u_brightnessRigidity, cfg.brightness_rigidity);
    gl.uniform1f(u.u_bassReactivityBoost, cfg.bass_reactivity_boost);
    gl.uniform1f(u.u_invertDepth, cfg.invert_depth ? 1.0 : 0.0);

    gl.enable(gl.BLEND);

    const isDust = cfg.style === "dust";
    gl.uniform1f(u.u_dustMode, isDust ? 1.0 : 0.0);
    // Per-shape overlay alpha multiplier (manifest overlay_alpha; 1.0 default).
    gl.uniform1f(u.u_overlayAlpha, animShape ? animShape.overlayAlpha : 1.0);

    if (isDust) {
      // Additive Blending: Neon glow for dust mode only
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
    } else {
      // Standard Alpha Blending for exoskeleton and wireframe
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    }

    gl.bindVertexArray(vao);
    if (isDust) {
      // Single draw call for all points — no need to draw line by line
      gl.drawArrays(gl.POINTS, 0, curLines * curPoints);
    } else {
      for (let j = 0; j < curLines; j++) {
        gl.drawArrays(gl.LINE_STRIP, j * curPoints, curPoints);
      }
    }
    gl.bindVertexArray(null);
  }

  createEffect(() => {
    const url = props.shapeUrl;
    if (url) loadShape(url);
    else {
      disposeAnimShape();
      hasNormalMap = false;
    }
  });

  onMount(() => {
    initWebGL();
    resize();
    window.addEventListener("resize", resize);

    let _fftCount = 0;
    onAudioFft((payload: FftPayload) => {
      const len = Math.min(payload.magnitudes.length, RAW_BANDS);
      for (let i = 0; i < len; i++) {
        const v = payload.magnitudes[i];
        runningAvg[i] = runningAvg[i] * cfg.agc_decay + v * (1 - cfg.agc_decay);
        const avg = Math.max(runningAvg[i], cfg.agc_floor);
        normalizedFft[i] = Math.min(255, (v / avg) * 128);
        rawFft[i] = normalizedFft[i];
      }
      for (let i = len; i < RAW_BANDS; i++) rawFft[i] = 0;
    }).then(unsub => { unlisten = unsub; });

    setTimeout(() => {
      if (!destroyed) spectrumSubscribe();
    }, 200);

    draw();
  });

  onCleanup(() => {
    destroyed = true;
    cancelAnimationFrame(animId);
    window.removeEventListener("resize", resize);
    spectrumUnsubscribe();
    unlisten?.();
    disposeAnimShape();
    if (gl) {
      gl.deleteProgram(program);
      if (bgProgram) gl.deleteProgram(bgProgram);
      gl.deleteTexture(normalTex);
      gl.deleteTexture(fftTex);
      gl.deleteTexture(regionsTex);
      if (colorTex) gl.deleteTexture(colorTex);
      gl.deleteBuffer(vbo);
      if (quadVbo) gl.deleteBuffer(quadVbo);
      gl.deleteVertexArray(vao);
      if (quadVao) gl.deleteVertexArray(quadVao);
    }
  });

  return (
    <canvas
      ref={canvas!}
      class="np-bg__el"
      style="width: 100%; height: 100%; display: block; position: absolute; top: 0; left: 0;"
    />
  );
}
