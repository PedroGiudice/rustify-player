/* ============================================================
   spectrum.ts — porte de docs/design-refs/design_handoff_mobile/
   spectrum-bg.js. Canvas global: monta UMA vez no shell, as telas
   passam por cima. shape = "o quê"; renderer = "como".

   O que mudou em relação ao handoff:
   - os stores window.useShape/useRenderer viraram signals Solid
     (mesma semântica: índice persistido em localStorage, next/prev).
   - o resto (envelope followers, beat-sync, correção de aspecto,
     gerador de FFT) é o código do handoff, sem reinterpretação.

   FFT: no Android v0 não há audio-engine nem evento `audio-fft` —
   o feed é o gerador sintético do protótipo (4/4 a 92 BPM, na mesma
   faixa dinâmica do payload real). Tocando anima, pausado congela.
   ============================================================ */

import { createSignal } from "solid-js";
import { SHAPES, type ShapeFn } from "./shapes";
import { RENDERERS } from "./renderers";
import * as BP from "./beatPll";

const SHAPE_KEY = "rustify-shape-mobile";
const RENDER_KEY = "rustify-renderer-mobile";
const FFT_STALE_MS = 250;
const ENV_GAIN = 0.5;
const ENV_TAU_MIN = 0.1;
const ENV_TAU_MAX = 0.8;
const DEFAULT_SHAPE = SHAPES.findIndex((s) => s.name === "pond");
const DEFAULT_RENDER = RENDERERS.findIndex((r) => r.name === "dots");

function loadIdx(key: string, len: number, def: number): number {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return def;
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) return ((n % len) + len) % len;
  } catch {
    /* localStorage indisponível — cai no default */
  }
  return def;
}

function persist(key: string, idx: number) {
  try {
    localStorage.setItem(key, String(idx));
  } catch {
    /* sem persistência é degradação aceitável */
  }
}

const [shapeIdx, setShapeIdx] = createSignal(loadIdx(SHAPE_KEY, SHAPES.length, DEFAULT_SHAPE));
const [renderIdx, setRenderIdx] = createSignal(loadIdx(RENDER_KEY, RENDERERS.length, DEFAULT_RENDER));

export const useShape = {
  idx: shapeIdx,
  name: () => SHAPES[shapeIdx()].name,
  count: SHAPES.length,
  set(n: number) {
    const i = ((n % SHAPES.length) + SHAPES.length) % SHAPES.length;
    setShapeIdx(i);
    persist(SHAPE_KEY, i);
  },
  next() { this.set(shapeIdx() + 1); },
  prev() { this.set(shapeIdx() - 1); },
};

export const useRenderer = {
  idx: renderIdx,
  name: () => RENDERERS[renderIdx()].name,
  count: RENDERERS.length,
  set(n: number) {
    const i = ((n % RENDERERS.length) + RENDERERS.length) % RENDERERS.length;
    setRenderIdx(i);
    persist(RENDER_KEY, i);
  },
  next() { this.set(renderIdx() + 1); },
  prev() { this.set(renderIdx() - 1); },
};

/* Feed de FFT. No desktop vem do evento `audio-fft` (pw_capture.rs).
   Aqui: 4/4 a 92 BPM, kick nos tempos, caixa em 2 e 4, hats nas
   colcheias — mesma faixa dinâmica do payload real. */
let lastLow = 0, lastMid = 0, lastHigh = 0, lastFftAt = 0;
let fftTick: (() => void) | null = null;

export function pushFft(low: number, mid: number, high: number) {
  lastLow = low;
  lastMid = mid;
  lastHigh = high;
  lastFftAt = performance.now();
}

export function mockFft(isPlaying: () => boolean): () => void {
  const BPM = 92, beat = 60 / BPM;
  let t = 0, last = performance.now();
  const tick = () => {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) * 0.001);
    last = now;
    if (!isPlaying()) return;
    t += dt;
    const b = (t / beat) % 4;
    const kickAge = (b % 1) * beat;
    const kick = 0.08 + 0.57 * Math.exp(-kickAge * 11);
    const snareOn = (b >= 1 && b < 2) || (b >= 3 && b < 4);
    const snareAge = (b % 1) * beat;
    const snare = snareOn ? 0.30 * Math.exp(-snareAge * 8) : 0.05;
    const hatAge = ((t / (beat / 2)) % 1) * (beat / 2);
    const hat = 0.10 + 0.34 * Math.exp(-hatAge * 22);
    const swell = 0.06 * Math.sin(t * 0.25);
    pushFft(Math.max(0, kick + swell), Math.max(0, 0.22 + snare + swell), Math.max(0, hat * 0.8));
  };
  fftTick = tick;
  const id = setInterval(tick, 120);
  return () => {
    clearInterval(id);
    fftTick = null;
  };
}

export function mountSpectrum(canvas: HTMLCanvasElement): () => void {
  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};
  let w = 0, h = 0, dpr = 1, raf = 0;
  let bgClock = 0, smoothedEnv = 0, lastFrameMs = performance.now();
  const pll = BP.createBeatPll();
  let beatEnv = 0, beatSync = 1, beatMode = 1, beatDepth = BP.BEAT_DEPTH_DEFAULT;
  const inkTgt = { r: 240, g: 240, b: 240 };
  const inkCur = { r: 240, g: 240, b: 240 };
  let inkSampled = false, inkRgb = "240, 240, 240";
  let bassGain = 1.0, midGain = 1.0, trebleGain = 0.8, smoothing = 0.3, speed = 1.0, inkMorphTau = 0.35;
  let cfgCheckTick = 0;

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const r = canvas.getBoundingClientRect();
    w = Math.max(1, r.width);
    h = Math.max(1, r.height);
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  const ro = new ResizeObserver(resize);
  ro.observe(canvas);
  resize();

  /* correção de aspecto: as shapes são radiais em uv normalizado; num
     canvas de celular (360×780) isso viraria elipse. Comprimimos a faixa
     do eixo curto para que 1 unidade de shape = mesma distância em px
     nos dois eixos. (Adição do handoff mobile sobre o desktop.) */
  const aspectFn = (fn: ShapeFn, cw: number, ch: number): ShapeFn => {
    if (Math.abs(cw - ch) < 1) return fn;
    return cw < ch
      ? (u, v, t) => fn(0.5 + (u - 0.5) * (cw / ch), v, t)
      : (u, v, t) => fn(u, 0.5 + (v - 0.5) * (ch / cw), t);
  };

  function frame() {
    raf = requestAnimationFrame(frame);
    if (document.hidden || !canvas.isConnected) return;
    if (fftTick) fftTick();
    cfgCheckTick++;
    if (cfgCheckTick % 20 === 0) {
      const cs = getComputedStyle(document.documentElement);
      const ink = cs.getPropertyValue("--bg-ink-rgb").trim();
      if (ink) {
        const p = ink.split(",").map((v) => parseFloat(v));
        if (p.length === 3 && p.every(Number.isFinite)) {
          inkTgt.r = p[0]; inkTgt.g = p[1]; inkTgt.b = p[2];
          if (!inkSampled) {
            inkCur.r = inkTgt.r; inkCur.g = inkTgt.g; inkCur.b = inkTgt.b;
            inkSampled = true;
          }
        }
      }
      const num = (k: string) => parseFloat(cs.getPropertyValue(k));
      const b = num("--bg-bass-gain"), m = num("--bg-mid-gain"), tr = num("--bg-treble-gain"),
        sm = num("--bg-smoothing"), sp = num("--bg-speed"), bs = num("--bg-beat-sync"),
        bm = num("--bg-beat-mode"), bd = num("--bg-beat-depth"), im = num("--bg-ink-morph");
      if (Number.isFinite(b)) bassGain = b;
      if (Number.isFinite(m)) midGain = m;
      if (Number.isFinite(tr)) trebleGain = tr;
      if (Number.isFinite(sm)) smoothing = sm;
      if (Number.isFinite(sp)) speed = sp;
      if (Number.isFinite(bs)) beatSync = bs;
      if (Number.isFinite(bm)) beatMode = bm;
      if (Number.isFinite(bd)) beatDepth = bd;
      inkMorphTau = Number.isFinite(im) && im > 0 ? im : 0.35;
    }

    const tMs = performance.now();
    const dt = Math.max(0, Math.min(0.1, (tMs - lastFrameMs) * 0.001));
    lastFrameMs = tMs;

    const kInk = 1 - Math.exp(-dt / inkMorphTau);
    inkCur.r += (inkTgt.r - inkCur.r) * kInk;
    inkCur.g += (inkTgt.g - inkCur.g) * kInk;
    inkCur.b += (inkTgt.b - inkCur.b) * kInk;
    inkRgb = `${Math.round(inkCur.r)}, ${Math.round(inkCur.g)}, ${Math.round(inkCur.b)}`;

    const fresh = lastFftAt !== 0 && tMs - lastFftAt < FFT_STALE_MS;
    BP.pllStep(pll, lastLow, tMs * 0.001, dt, fresh);

    const speedTarget = fresh && beatSync > 0.5 && beatMode === 1 ? BP.expandKick(lastLow) : 0;
    beatEnv += (speedTarget - beatEnv) * (1 - Math.exp(-dt / BP.BEAT_TAU));
    bgClock += dt * speed * (1 + BP.speedBoostGain(beatDepth) * beatEnv);
    const t = bgClock;
    ctx.clearRect(0, 0, w, h);

    let target = 0;
    if (fresh) {
      const num2 = bassGain * lastLow + midGain * lastMid + trebleGain * lastHigh;
      const den = bassGain + midGain + trebleGain;
      target = den > 1e-3 ? num2 / den : 0;
    }
    const tau = ENV_TAU_MIN + smoothing * (ENV_TAU_MAX - ENV_TAU_MIN);
    smoothedEnv += (target - smoothedEnv) * (1 - Math.exp(-dt / tau));

    const breath = 0.85 + 0.15 * Math.sin(t * 0.4);
    const pulse = beatSync > 0.5 && beatMode === 2 ? BP.beatPulse(pll, beatDepth) : 0;
    const reactive = 1 + ENV_GAIN * smoothedEnv + pulse;
    const amp = h * 0.17 * breath * reactive;
    const inkBoost = 1 + BP.INK_PULSE * (beatDepth > 0 ? pulse / beatDepth : 0);

    RENDERERS[renderIdx()].fn(
      ctx, w, h, t,
      aspectFn(SHAPES[shapeIdx()].fn, w, h),
      amp, breath, inkRgb, smoothedEnv, inkBoost,
    );
  }
  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    ro.disconnect();
  };
}
