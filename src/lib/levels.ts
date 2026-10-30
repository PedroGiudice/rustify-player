// src/lib/levels.ts — níveis reais de saída para os medidores (barra do
// player, indicador "tocando agora"). Um único ouvinte do `audio-fft` e um
// único rAF para todos os consumidores; a balística mora em lib/meter.ts.
// Só assina enquanto há consumidor e pausa com a janela oculta.
import { onAudioFft, spectrumSubscribe, spectrumUnsubscribe, type FftPayload } from "../tauri";
import { createMeter, stepMeter, type MeterState } from "./meter";

export interface Levels { rms: [number, number]; peak: [number, number] }

export function levelsFromPayload(p: FftPayload): Levels {
  if (p.level_l_rms !== undefined && p.level_r_rms !== undefined) {
    return {
      rms: [p.level_l_rms, p.level_r_rms],
      peak: [p.level_l_peak ?? p.level_l_rms, p.level_r_peak ?? p.level_r_rms],
    };
  }
  const m = p.rms_energy;
  return { rms: [m, m], peak: [m, m] };
}

/** Sem evento há mais que isto = som parado; o medidor desce sozinho. */
const STALE_MS = 150;

type Listener = (m: MeterState) => void;
const listeners = new Set<Listener>();
const meter = createMeter();
const zero: Levels = { rms: [0, 0], peak: [0, 0] };
let latest: Levels = zero;
let latestAt = 0;
let raf = 0;
let lastT = 0;
let unlisten: (() => void) | null = null;

function frame(t: number) {
  const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0;
  lastT = t;
  const src = performance.now() - latestAt > STALE_MS ? zero : latest;
  stepMeter(meter, src.rms, src.peak, dt);
  for (const l of listeners) l(meter);
  raf = requestAnimationFrame(frame);
}

function start() {
  if (raf || document.hidden) return;
  lastT = 0;
  raf = requestAnimationFrame(frame);
}
function stop() {
  cancelAnimationFrame(raf);
  raf = 0;
}
function onVisibility() {
  if (document.hidden) stop();
  else if (listeners.size) start();
}

export function subscribeLevels(l: Listener): () => void {
  listeners.add(l);
  if (listeners.size === 1) {
    spectrumSubscribe().catch(() => {});
    onAudioFft((p) => { latest = levelsFromPayload(p); latestAt = performance.now(); })
      .then((u) => { if (listeners.size) unlisten = u; else u(); })
      .catch(() => {});
    document.addEventListener("visibilitychange", onVisibility);
    start();
  }
  return () => {
    if (!listeners.delete(l) || listeners.size) return;
    stop();
    document.removeEventListener("visibilitychange", onVisibility);
    unlisten?.();
    unlisten = null;
    spectrumUnsubscribe().catch(() => {});
  };
}
