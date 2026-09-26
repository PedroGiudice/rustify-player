/* ============================================================
   gl/benchStats.ts — a estatística da medição de cenas (puro).

   A medição (gl/bench.ts) coleta os intervalos entre callbacks de
   requestAnimationFrame com a cena rodando no app de verdade: é o
   que o usuário vê, com o resto do app desenhando junto. Daqui sai:
     - fps médio      = quadros / tempo total;
     - fps do 1% pior = 1000 / p99 do intervalo (rank mais próximo);
     - % acima de 20 ms = quadros que o olho percebe como tranco.
   Aprovada ("60 fps ok"): média >= 58 E no máximo 2% dos quadros
   acima de 20 ms. Os 58 absorvem o jitter do rAF num monitor de
   60 Hz (59,94 Hz inclusive); os 2% barram a cena que faz média
   alta com engasgo regular.
   ============================================================ */

import { isSceneKey, type SceneKey } from "./meta";

export const BENCH_OK_FPS = 58;
export const BENCH_SLOW_MS = 20;
export const BENCH_MAX_SLOW_PCT = 2;
export const BENCH_STORAGE_KEY = "kv-gl-bench";

export interface BenchStats {
  frames: number;
  fpsAvg: number;
  fpsLow1: number;
  /** Porcentagem (0..100) de intervalos acima de BENCH_SLOW_MS. */
  slowPct: number;
  ok: boolean;
}

/** Percentil por rank mais próximo (p em 0..1) de uma lista já ordenada. */
export function percentileSorted(sorted: readonly number[], p: number): number {
  if (!sorted.length) return 0;
  const rank = Math.ceil(p * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))];
}

export function computeBenchStats(intervalsMs: readonly number[]): BenchStats {
  const iv = intervalsMs.filter((v) => Number.isFinite(v) && v > 0);
  if (!iv.length) return { frames: 0, fpsAvg: 0, fpsLow1: 0, slowPct: 0, ok: false };
  let sum = 0;
  let slow = 0;
  for (const v of iv) {
    sum += v;
    if (v > BENCH_SLOW_MS) slow++;
  }
  const sorted = [...iv].sort((a, b) => a - b);
  const p99 = percentileSorted(sorted, 0.99);
  const fpsAvg = (iv.length * 1000) / sum;
  const slowPct = (slow / iv.length) * 100;
  return {
    frames: iv.length,
    fpsAvg,
    fpsLow1: 1000 / p99,
    slowPct,
    ok: fpsAvg >= BENCH_OK_FPS && slowPct <= BENCH_MAX_SLOW_PCT,
  };
}

export interface BenchSceneResult extends BenchStats {
  key: SceneKey;
  label: string;
  /** Motivo quando a cena não pôde ser medida (shader, contexto). */
  error?: string;
}

export interface BenchResult {
  /** ISO 8601 do fim da medição. */
  at: string;
  /** Versão do app (tauri.conf.json), "—" fora do Tauri. */
  version: string;
  /** Rota (hash) em que o app estava: o custo do resto da tela entra junto. */
  route: string;
  /** Renderer informado pelo driver (mascarado no WebKitGTK). */
  renderer: string;
  scenes: BenchSceneResult[];
}

/** Valida o JSON salvo; qualquer coisa fora do formato vira null. */
export function parseBenchResult(raw: unknown): BenchResult | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.at !== "string" || !Array.isArray(r.scenes)) return null;
  const scenes: BenchSceneResult[] = [];
  for (const s of r.scenes as unknown[]) {
    if (!s || typeof s !== "object") return null;
    const o = s as Record<string, unknown>;
    if (!isSceneKey(o.key)) continue; // cena aposentada depois da medição
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    scenes.push({
      key: o.key,
      label: typeof o.label === "string" ? o.label : o.key,
      frames: num(o.frames),
      fpsAvg: num(o.fpsAvg),
      fpsLow1: num(o.fpsLow1),
      slowPct: num(o.slowPct),
      ok: o.ok === true,
      ...(typeof o.error === "string" && o.error ? { error: o.error } : {}),
    });
  }
  return {
    at: r.at,
    version: typeof r.version === "string" ? r.version : "—",
    route: typeof r.route === "string" ? r.route : "",
    renderer: typeof r.renderer === "string" ? r.renderer : "",
    scenes,
  };
}

export function loadBenchResult(): BenchResult | null {
  try {
    const raw = localStorage.getItem(BENCH_STORAGE_KEY);
    return raw ? parseBenchResult(JSON.parse(raw)) : null;
  } catch {
    return null;
  }
}

export function saveBenchResult(r: BenchResult): void {
  try {
    localStorage.setItem(BENCH_STORAGE_KEY, JSON.stringify(r));
  } catch {
    /* storage cheio ou bloqueado: a tabela fica só nesta sessão */
  }
}
