import { describe, it, expect, afterEach } from "vitest";
import {
  BENCH_STORAGE_KEY,
  computeBenchStats,
  loadBenchResult,
  parseBenchResult,
  percentileSorted,
  saveBenchResult,
  type BenchResult,
} from "./benchStats";

const frames = (n: number, ms: number) => Array.from({ length: n }, () => ms);

describe("percentileSorted (rank mais próximo)", () => {
  it("p99 de 100 valores é o 99º", () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentileSorted(v, 0.99)).toBe(99);
    expect(percentileSorted(v, 1)).toBe(100);
    expect(percentileSorted([], 0.99)).toBe(0);
  });
});

describe("computeBenchStats", () => {
  it("60 Hz limpo: 60 fps, 1% pior 60, nada acima de 20 ms, aprovada", () => {
    const s = computeBenchStats(frames(480, 1000 / 60));
    expect(s.frames).toBe(480);
    expect(s.fpsAvg).toBeCloseTo(60, 6);
    expect(s.fpsLow1).toBeCloseTo(60, 6);
    expect(s.slowPct).toBe(0);
    expect(s.ok).toBe(true);
  });

  it("59,94 Hz passa (o piso é 58)", () => {
    expect(computeBenchStats(frames(480, 1000 / 59.94)).ok).toBe(true);
  });

  it("média alta com engasgo regular reprova pelos 2%", () => {
    // 3% dos quadros em 33 ms: a média ainda passa de 58, os trancos não.
    const iv = [...frames(970, 16.0), ...frames(30, 33.4)];
    const s = computeBenchStats(iv);
    expect(s.fpsAvg).toBeGreaterThan(58);
    expect(s.slowPct).toBeCloseTo(3, 6);
    expect(s.ok).toBe(false);
  });

  it("até 2% acima de 20 ms ainda aprova", () => {
    const iv = [...frames(980, 16.2), ...frames(20, 21)];
    const s = computeBenchStats(iv);
    expect(s.slowPct).toBeCloseTo(2, 6);
    expect(s.ok).toBe(true);
  });

  it("30 fps reprova pela média; o 1% pior vem do p99", () => {
    const iv = [...frames(99, 33.3), 100];
    const s = computeBenchStats(iv);
    expect(s.fpsAvg).toBeLessThan(58);
    expect(s.fpsLow1).toBeCloseTo(1000 / 33.3, 6);
    expect(s.ok).toBe(false);
  });

  it("sem amostra (ou lixo) não aprova nem divide por zero", () => {
    expect(computeBenchStats([])).toEqual({ frames: 0, fpsAvg: 0, fpsLow1: 0, slowPct: 0, ok: false });
    expect(computeBenchStats([NaN, -1, 0]).frames).toBe(0);
  });
});

describe("persistência (kv-gl-bench)", () => {
  afterEach(() => localStorage.removeItem(BENCH_STORAGE_KEY));

  const sample: BenchResult = {
    at: "2026-09-26T12:00:00.000Z",
    version: "0.2.81",
    route: "/now-playing",
    renderer: "Apple GPU",
    scenes: [
      { key: "dust", label: "Poeira", frames: 480, fpsAvg: 60, fpsLow1: 58, slowPct: 0, ok: true },
      { key: "nebula", label: "Nébula", frames: 0, fpsAvg: 0, fpsLow1: 0, slowPct: 0, ok: false, error: "shader" },
    ],
  };

  it("salva e relê igual", () => {
    saveBenchResult(sample);
    expect(loadBenchResult()).toEqual(sample);
  });

  it("JSON quebrado ou fora do formato vira null", () => {
    localStorage.setItem(BENCH_STORAGE_KEY, "{");
    expect(loadBenchResult()).toBeNull();
    expect(parseBenchResult({ at: 1, scenes: [] })).toBeNull();
    expect(parseBenchResult(null)).toBeNull();
  });

  it("cena que saiu do registro some da tabela antiga", () => {
    const r = parseBenchResult({ ...sample, scenes: [...sample.scenes, { key: "aposentada", ok: true }] });
    expect(r?.scenes.map((s) => s.key)).toEqual(["dust", "nebula"]);
  });
});
