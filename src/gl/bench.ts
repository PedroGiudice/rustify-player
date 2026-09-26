/* ============================================================
   gl/bench.ts — "Medir cenas": fps de cada cena no app de verdade.

   O critério de aceite do fundo WebGL é 60 fps medidos NO APP, com o
   resto da tela desenhando junto — o bench offscreen
   (scripts/gl-bench) mede só a GPU. Aqui cada cena registrada roda
   no motor WebGL do próprio app: 2 s de aquecimento e 8 s de
   amostragem dos intervalos de requestAnimationFrame
   (estatística em gl/benchStats.ts).

   Nada disso toca as preferências salvas: a cena medida entra por
   glSceneOverride (gl/meta.ts), que também liga o motor WebGL se o
   usuário estiver no 2D. Terminar, cancelar (Esc) ou esconder a
   janela só limpa o override e o app volta sozinho ao motor e à
   cena de antes.

   Disparo: botão no Tweaks (seção Fundo) ou, remoto pela ponte MCP,
   window.dispatchEvent(new CustomEvent("rustify:gl-bench")).
   Resultado: localStorage "kv-gl-bench" e window.__rustifyGlBench
   ({ status: "running" | "done" | "cancelled", ...resultado }).
   Não importa as cenas nem o motor — só gl/meta.ts.
   ============================================================ */

import { createSignal } from "solid-js";
import { pushEscLayer } from "../lib/escLayers";
import {
  SCENE_KEYS,
  SCENE_LABELS,
  glActiveScene,
  glStatus,
  resetGlStatus,
  setGlSceneOverride,
  type SceneKey,
} from "./meta";
import {
  computeBenchStats,
  loadBenchResult,
  saveBenchResult,
  type BenchResult,
  type BenchSceneResult,
} from "./benchStats";

export const GL_BENCH_EVENT = "rustify:gl-bench";

export interface BenchTiming {
  /** Espera máxima para o motor montar a cena (lazy import + shader). */
  mountTimeoutMs: number;
  warmupMs: number;
  sampleMs: number;
}

export const BENCH_TIMING: BenchTiming = { mountTimeoutMs: 8000, warmupMs: 2000, sampleMs: 8000 };

export interface BenchProgress {
  key: SceneKey;
  label: string;
  index: number;
  total: number;
  phase: "carregando" | "aquecendo" | "medindo";
}

export type GlBenchWindowState =
  | ({ status: "running" | "cancelled"; reason?: string } & Partial<BenchResult> & { scenes: BenchSceneResult[] })
  | ({ status: "done" } & BenchResult);

const [progress, setProgress] = createSignal<BenchProgress | null>(null);
// Leitura única do localStorage no import (try/catch em loadBenchResult).
const [result, setResult] = createSignal<BenchResult | null>(loadBenchResult());

/** Cena em medição agora (null = parado). */
export const glBenchProgress = progress;

/** Último resultado medido (sobrevive ao restart via "kv-gl-bench"). */
export const glBenchResult = result;

interface Token {
  cancelled: boolean;
  reason: string;
  wake: Array<() => void>;
}

let active: Token | null = null;

/** Cancela a medição em andamento (Esc, janela escondida). */
export function cancelGlBench(reason = "cancelada"): void {
  const t = active;
  if (!t || t.cancelled) return;
  t.cancelled = true;
  t.reason = reason;
  for (const w of t.wake.splice(0)) w();
}

function expose(state: GlBenchWindowState): void {
  try {
    (window as unknown as { __rustifyGlBench?: GlBenchWindowState }).__rustifyGlBench = state;
  } catch { /* ok */ }
}

/** Registra `fn` para ser chamado no cancelamento; devolve o desregistro. */
function onWake(t: Token, fn: () => void): () => void {
  t.wake.push(fn);
  return () => {
    const i = t.wake.indexOf(fn);
    if (i >= 0) t.wake.splice(i, 1);
  };
}

function wait(ms: number, t: Token): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(id);
      off();
      resolve();
    };
    const id = setTimeout(done, ms);
    const off = onWake(t, done);
  });
}

async function waitUntil(pred: () => boolean, timeoutMs: number, t: Token): Promise<boolean> {
  const end = performance.now() + timeoutMs;
  while (!t.cancelled) {
    if (pred()) return true;
    if (performance.now() >= end) return false;
    await wait(50, t);
  }
  return false;
}

/** Intervalos (ms) entre callbacks de rAF durante `ms`. */
function sampleRaf(ms: number, t: Token): Promise<number[]> {
  return new Promise((resolve) => {
    const out: number[] = [];
    let start = -1;
    let prev = -1;
    let id = 0;
    const finish = () => {
      cancelAnimationFrame(id);
      off();
      resolve(out);
    };
    const off = onWake(t, finish);
    const cb = (now: number) => {
      if (t.cancelled) return;
      if (start < 0) {
        start = prev = now;
      } else {
        out.push(now - prev);
        prev = now;
        if (now - start >= ms) {
          finish();
          return;
        }
      }
      id = requestAnimationFrame(cb);
    };
    id = requestAnimationFrame(cb);
  });
}

async function appVersion(): Promise<string> {
  try {
    const get = (window as unknown as { __TAURI__?: { app?: { getVersion?: () => Promise<string> } } })
      .__TAURI__?.app?.getVersion;
    if (!get) return "—";
    const v = await Promise.race([get(), new Promise<string>((r) => setTimeout(() => r("—"), 1000))]);
    return v || "—";
  } catch {
    return "—";
  }
}

export interface BenchHooks {
  /** Antes da primeira cena (o Tweaks fecha o painel). */
  onStart?: () => void;
  /** Depois de restaurar (o Tweaks reabre o painel com a tabela).
      `r` é null quando a medição foi cancelada. */
  onFinish?: (r: BenchResult | null) => void;
  timing?: Partial<BenchTiming>;
  keys?: readonly SceneKey[];
}

/**
 * Mede todas as cenas registradas. Devolve o resultado, ou null se foi
 * cancelada ou se já havia uma medição em andamento.
 */
export async function runGlBench(hooks: BenchHooks = {}): Promise<BenchResult | null> {
  if (active) return null;
  const token: Token = { cancelled: false, reason: "", wake: [] };
  active = token;
  const timing = { ...BENCH_TIMING, ...hooks.timing };
  const keys = hooks.keys ?? SCENE_KEYS;
  const scenes: BenchSceneResult[] = [];
  const route = (location.hash || "").replace(/^#/, "") || "/home";
  let renderer = "";

  const popEsc = pushEscLayer(() => cancelGlBench("Esc"));
  const onVisibility = () => {
    if (document.hidden) cancelGlBench("janela escondida");
  };
  document.addEventListener("visibilitychange", onVisibility);
  expose({ status: "running", route, scenes });
  hooks.onStart?.();

  let version = "—";
  try {
    version = await appVersion();
    for (let i = 0; i < keys.length && !token.cancelled; i++) {
      const key = keys[i];
      const label = SCENE_LABELS[key];
      const base = { key, label, index: i + 1, total: keys.length };
      setProgress({ ...base, phase: "carregando" });
      // Falha da cena anterior tirou o motor do ar; religa para esta.
      if (glStatus().ok === false) resetGlStatus();
      setGlSceneOverride(key);

      const mounted = await waitUntil(
        () => glActiveScene() === key || glStatus().ok === false,
        timing.mountTimeoutMs,
        token,
      );
      if (token.cancelled) break;
      if (!mounted || glStatus().ok === false) {
        scenes.push(failed(key, label, glStatus().error || "o motor WebGL não montou a cena a tempo"));
        continue;
      }
      renderer ||= glStatus().renderer;

      setProgress({ ...base, phase: "aquecendo" });
      await wait(timing.warmupMs, token);
      if (token.cancelled) break;

      setProgress({ ...base, phase: "medindo" });
      const intervals = await sampleRaf(timing.sampleMs, token);
      if (token.cancelled) break;
      if (glStatus().ok === false || glActiveScene() !== key) {
        scenes.push(failed(key, label, glStatus().error || "a cena saiu do ar durante a medição"));
        continue;
      }
      scenes.push({ key, label, ...computeBenchStats(intervals) });
      expose({ status: "running", route, version, renderer, scenes });
    }
  } finally {
    setGlSceneOverride(null);
    // A última cena pode ter falhado: sem isto o motor do usuário (se
    // ele usa o WebGL) ficaria no 2D de castigo pela cena medida.
    if (glStatus().ok === false) resetGlStatus();
    popEsc();
    document.removeEventListener("visibilitychange", onVisibility);
    setProgress(null);
    active = null;
  }

  if (token.cancelled) {
    expose({ status: "cancelled", reason: token.reason, route, version, renderer, scenes });
    hooks.onFinish?.(null);
    return null;
  }
  const res: BenchResult = { at: new Date().toISOString(), version, route, renderer, scenes };
  setResult(res);
  saveBenchResult(res);
  expose({ status: "done", ...res });
  hooks.onFinish?.(res);
  return res;
}

function failed(key: SceneKey, label: string, error: string): BenchSceneResult {
  return { key, label, frames: 0, fpsAvg: 0, fpsLow1: 0, slowPct: 0, ok: false, error };
}
