import { onMount, onCleanup, createEffect } from "solid-js";
import { onAudioFft, spectrumSubscribe, spectrumUnsubscribe, getTrackColor, FftPayload } from "../tauri";
import { player } from "../store/player";

const LINE_COUNT = 100;
const POINTS_PER_LINE = 80;
const ATTACK = 0.35;
const RELEASE = 0.06;
const RAW_BANDS = 512;
const LOG_BANDS = 128;

// Ring buffer capacity — holds ~1-2s of frames at 60Hz
const RING_CAPACITY = 90;

const logBinMap: [number, number][] = (() => {
  const map: [number, number][] = [];
  for (let i = 0; i < LOG_BANDS; i++) {
    const t = i / LOG_BANDS;
    const startFrac = Math.pow(t, 2.5);
    const endFrac = Math.pow((i + 1) / LOG_BANDS, 2.5);
    const start = Math.floor(startFrac * RAW_BANDS);
    const end = Math.max(start + 1, Math.floor(endFrac * RAW_BANDS));
    map.push([start, end]);
  }
  return map;
})();

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
out float v_depth;

void main() {
    vec4 nm = texture(u_normalMap, a_grid);
    float bright = nm.r;
    float dirX = nm.g * 2.0 - 1.0;
    float dirY = nm.b * 2.0 - 1.0;

    float depth = a_grid.y;
    float regionF = depth * 7.0;
    int region = min(int(regionF), 6);

    float starts[7] = float[7](0.0, 4.0, 12.0, 24.0, 40.0, 56.0, 80.0);
    float ends[7] = float[7](4.0, 12.0, 24.0, 40.0, 56.0, 80.0, 128.0);
    float mid = (starts[region] + ends[region]) * 0.5 / 128.0;
    float energy = texture(u_fft, vec2(mid, 0.5)).r;

    int prevR = max(region - 1, 0);
    int nextR = min(region + 1, 6);
    float prevE = texture(u_fft, vec2((starts[prevR] + ends[prevR]) * 0.5 / 128.0, 0.5)).r;
    float nextE = texture(u_fft, vec2((starts[nextR] + ends[nextR]) * 0.5 / 128.0, 0.5)).r;
    float blended = prevE * 0.2 + energy * 0.6 + nextE * 0.2;

    float strength = (0.15 + bright * 0.85) * (10.0 + blended * 180.0);
    vec2 base = a_grid * u_resolution;
    vec2 displaced = base + vec2(dirX, dirY) * strength;

    vec2 ndc = (displaced / u_resolution) * 2.0 - 1.0;
    ndc.y = -ndc.y;
    gl_Position = vec4(ndc, 0.0, 1.0);
    v_depth = depth;
}
`;

const FRAG_SRC = `#version 300 es
precision highp float;
in float v_depth;
uniform float u_baseHue;
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
    float hue = mod(u_baseHue + v_depth * 15.0, 360.0);
    float alpha = 0.15 + v_depth * 0.25;
    float lightness = (40.0 + v_depth * 20.0) / 100.0;
    vec3 color = hsl2rgb(hue, 0.8, lightness);
    fragColor = vec4(color, alpha);
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

function createProgram(gl: WebGL2RenderingContext): WebGLProgram | null {
  const vs = compileShader(gl, gl.VERTEX_SHADER, VERT_SRC);
  const fs = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
  if (!vs || !fs) return null;
  const prog = gl.createProgram()!;
  gl.attachShader(prog, vs);
  gl.attachShader(prog, fs);
  gl.bindAttribLocation(prog, 0, "a_grid");
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    console.error("Program link:", gl.getProgramInfoLog(prog));
    return null;
  }
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  return prog;
}

export default function SpectrumBackground(props: { shapeUrl?: string | null }) {
  let canvas: HTMLCanvasElement | undefined;
  let gl: WebGL2RenderingContext | null = null;
  let program: WebGLProgram | null = null;
  let vao: WebGLVertexArrayObject | null = null;
  let normalTex: WebGLTexture | null = null;
  let fftTex: WebGLTexture | null = null;
  let animId = 0;
  let destroyed = false;
  let unlisten: (() => void) | null = null;

  let uResolution: WebGLUniformLocation | null = null;
  let uBaseHue: WebGLUniformLocation | null = null;
  let uNormalMap: WebGLUniformLocation | null = null;
  let uFft: WebGLUniformLocation | null = null;

  const rawFft = new Uint8Array(RAW_BANDS);
  const smoothed = new Float32Array(LOG_BANDS);
  const fftUpload = new Uint8Array(LOG_BANDS);
  let baseHue = 260;
  let hasNormalMap = false;

  // ── Ring buffer for time-based presentation ──────────────────────
  // Pre-allocated slots to avoid GC pressure
  const ring: { streamTimeMs: number; magnitudes: Uint8Array; used: boolean }[] = Array.from({ length: RING_CAPACITY }, () => ({
    streamTimeMs: 0,
    magnitudes: new Uint8Array(RAW_BANDS),
    used: false,
  }));
  let ringHead = 0; // next write position

  // ── Playback clock ───────────────────────────────────────────────
  // Reconstructs track position without polling the backend every frame.
  // Synced from player store on play/pause/seek.
  let clockAnchorPerf = 0; // performance.now() at last sync
  let clockAnchorPos = 0; // track position (ms) at last sync
  let clockPlaying = false;

  function getPlaybackMs(): number {
    if (!clockPlaying) return clockAnchorPos;
    return clockAnchorPos + (performance.now() - clockAnchorPerf);
  }

  createEffect(async () => {
    const track = player.currentTrack;
    if (!track) return;
    try {
      const hex = await getTrackColor(track.id);
      if (hex?.startsWith("#")) baseHue = hexToHue(hex);
    } catch {}
  });

  // Sync local playback clock from player store reactive state
  createEffect(() => {
    const playing = player.isPlaying;
    const posSecs = player.positionSecs;
    clockAnchorPerf = performance.now();
    clockAnchorPos = posSecs * 1000; // secs → ms
    clockPlaying = playing;
  });

  function initWebGL() {
    if (!canvas) return;
    gl = canvas.getContext("webgl2", { alpha: false, antialias: false });
    if (!gl) { console.error("WebGL2 not available"); return; }

    program = createProgram(gl);
    if (!program) return;

    // Grid mesh
    const verts = new Float32Array(LINE_COUNT * POINTS_PER_LINE * 2);
    let idx = 0;
    for (let j = 0; j < LINE_COUNT; j++) {
      for (let i = 0; i < POINTS_PER_LINE; i++) {
        verts[idx++] = i / (POINTS_PER_LINE - 1);
        verts[idx++] = j / (LINE_COUNT - 1);
      }
    }
    vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const vbo = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Textures
    normalTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, normalTex);
    // Default 1x1 neutral normal map
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB8, 1, 1, 0, gl.RGB, gl.UNSIGNED_BYTE,
      new Uint8Array([128, 128, 128]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    fftTex = gl.createTexture();
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, fftTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, LOG_BANDS, 1, 0, gl.RED, gl.UNSIGNED_BYTE,
      new Uint8Array(LOG_BANDS));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    // Uniforms
    uResolution = gl.getUniformLocation(program, "u_resolution");
    uBaseHue = gl.getUniformLocation(program, "u_baseHue");
    uNormalMap = gl.getUniformLocation(program, "u_normalMap");
    uFft = gl.getUniformLocation(program, "u_fft");
  }

  function loadShape(url: string) {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      if (!gl || !normalTex) return;
      const offscreen = document.createElement("canvas");
      offscreen.width = POINTS_PER_LINE;
      offscreen.height = LINE_COUNT;
      const octx = offscreen.getContext("2d")!;
      octx.filter = "blur(3px) contrast(4) saturate(0)";
      octx.drawImage(img, 0, 0, POINTS_PER_LINE, LINE_COUNT);
      const imgData = octx.getImageData(0, 0, POINTS_PER_LINE, LINE_COUNT);

      const w = imgData.width, h = imgData.height;
      const brightness = new Float32Array(w * h);
      const packed = new Uint8Array(w * h * 3);

      for (let i = 0; i < w * h; i++) {
        const idx = i * 4;
        brightness[i] = (0.2126 * imgData.data[idx] + 0.7152 * imgData.data[idx+1] + 0.0722 * imgData.data[idx+2]) / 255;
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
          if (mag > 0.01) {
            nx = (gx / mag) * 0.5 + 0.5;
            ny = (gy / mag) * 0.5 + 0.5;
          }
          packed[i*3] = Math.floor(brightness[i] * 255);
          packed[i*3+1] = Math.floor(nx * 255);
          packed[i*3+2] = Math.floor(ny * 255);
        }
      }

      gl!.activeTexture(gl!.TEXTURE0);
      gl!.bindTexture(gl!.TEXTURE_2D, normalTex);
      gl!.texImage2D(gl!.TEXTURE_2D, 0, gl!.RGB8, w, h, 0, gl!.RGB, gl!.UNSIGNED_BYTE, packed);
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

    // ── Pick frame from ring buffer matching current playback clock ──
    const nowMs = getPlaybackMs();
    let bestIdx = -1;
    let bestTime = -1;
    // Scan from newest to oldest; first frame with streamTimeMs <= nowMs is the best match
    for (let k = 0; k < RING_CAPACITY; k++) {
      const idx = (ringHead - 1 - k + RING_CAPACITY) % RING_CAPACITY;
      const frame = ring[idx];
      if (!frame.used) continue;
      if (frame.streamTimeMs <= nowMs) {
        bestTime = frame.streamTimeMs;
        bestIdx = idx;
        break; // Newest-first traversal, first hit is closest to nowMs
      }
    }

    // If we found a matching frame, copy its data and free consumed/older frames
    if (bestIdx >= 0) {
      rawFft.set(ring[bestIdx].magnitudes);
      // Free all frames at or before the consumed timestamp
      for (let k = 0; k < RING_CAPACITY; k++) {
        if (ring[k].used && ring[k].streamTimeMs <= bestTime) {
          ring[k].used = false;
        }
      }
    }
    // If no matching frame, rawFft retains last used data (smooth decay handles fade-out)

    // Smooth FFT
    for (let i = 0; i < LOG_BANDS; i++) {
      const [start, end] = logBinMap[i];
      let max = 0;
      for (let j = start; j < end && j < RAW_BANDS; j++) {
        if (rawFft[j] > max) max = rawFft[j];
      }
      const rate = max > smoothed[i] ? ATTACK : RELEASE;
      smoothed[i] += (max - smoothed[i]) * rate;
      fftUpload[i] = Math.min(255, Math.floor(smoothed[i]));
    }

    // Upload FFT texture
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, fftTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, LOG_BANDS, 1, gl.RED, gl.UNSIGNED_BYTE, fftUpload);

    // Clear
    gl.clearColor(0.031, 0.031, 0.031, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    // Draw lines
    gl.useProgram(program);
    gl.uniform2f(uResolution, canvas!.clientWidth, canvas!.clientHeight);
    gl.uniform1f(uBaseHue, baseHue);
    gl.uniform1i(uNormalMap, 0);
    gl.uniform1i(uFft, 1);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.bindVertexArray(vao);
    for (let j = 0; j < LINE_COUNT; j++) {
      gl.drawArrays(gl.LINE_STRIP, j * POINTS_PER_LINE, POINTS_PER_LINE);
    }
    gl.bindVertexArray(null);
  }

  createEffect(() => {
    const url = props.shapeUrl;
    if (url) loadShape(url);
    else hasNormalMap = false;
  });

  onMount(() => {
    initWebGL();
    resize();
    window.addEventListener("resize", resize);

    onAudioFft((payload: FftPayload) => {
      // Enqueue into ring buffer — do NOT render immediately
      const slot = ring[ringHead];
      slot.streamTimeMs = payload.stream_time_ms;
      const len = Math.min(payload.magnitudes.length, RAW_BANDS);
      for (let i = 0; i < len; i++) slot.magnitudes[i] = payload.magnitudes[i];
      for (let i = len; i < RAW_BANDS; i++) slot.magnitudes[i] = 0;
      slot.used = true;
      ringHead = (ringHead + 1) % RING_CAPACITY;
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
    if (gl) {
      gl.deleteProgram(program);
      gl.deleteTexture(normalTex);
      gl.deleteTexture(fftTex);
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
