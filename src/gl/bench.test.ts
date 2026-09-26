/* ============================================================
   bench.test.ts — o fluxo de "Medir cenas" com relógio falso.

   Um host falso faz o papel do GlBackground: quando o override da
   medição aponta uma cena, ele a "monta" (glActiveScene) — ou falha,
   como um shader que não compila. O rAF falso anda a 16 ms.
   ============================================================ */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createEffect, createRoot } from "solid-js";
import { cancelGlBench, glBenchProgress, glBenchResult, runGlBench } from "./bench";
import { BENCH_STORAGE_KEY } from "./benchStats";
import {
  glSceneOverride,
  glStatus,
  resetGlStatus,
  setGlActiveScene,
  setGlStatus,
  type SceneKey,
} from "./meta";

const TIMING = { mountTimeoutMs: 500, warmupMs: 100, sampleMs: 1000 };

let disposeHost: (() => void) | undefined;

/** Host falso: monta a cena pedida, ou derruba o motor para as de `broken`. */
function fakeHost(broken: SceneKey[] = []) {
  createRoot((dispose) => {
    disposeHost = dispose;
    createEffect(() => {
      const k = glSceneOverride();
      if (k && broken.includes(k)) {
        setGlActiveScene(null);
        setGlStatus({ ok: false, renderer: "", error: `cena ${k}: shader não compilou`, fps: 0 });
      } else {
        setGlActiveScene(k);
        if (k) setGlStatus({ ok: true, renderer: "Fake GPU", error: "", fps: 60 });
      }
    });
  });
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame", "performance", "Date"],
  });
  localStorage.removeItem(BENCH_STORAGE_KEY);
  resetGlStatus();
});

afterEach(() => {
  cancelGlBench();
  disposeHost?.();
  disposeHost = undefined;
  setGlActiveScene(null);
  vi.useRealTimers();
});

describe("runGlBench", () => {
  it("mede cada cena, restaura o motor e persiste o resultado", async () => {
    fakeHost();
    const onStart = vi.fn();
    const onFinish = vi.fn();
    const p = runGlBench({ keys: ["dust", "relief"], timing: TIMING, onStart, onFinish });
    expect(onStart).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(50);
    expect(glBenchProgress()?.key).toBe("dust");
    expect(glSceneOverride()).toBe("dust");
    await vi.advanceTimersByTimeAsync(5000);
    const r = await p;

    expect(r).not.toBeNull();
    expect(r!.scenes.map((s) => s.key)).toEqual(["dust", "relief"]);
    for (const s of r!.scenes) {
      expect(s.fpsAvg).toBeCloseTo(62.5, 1); // rAF falso a 16 ms
      expect(s.ok).toBe(true);
      expect(s.frames).toBeGreaterThan(50);
    }
    expect(r!.renderer).toBe("Fake GPU");
    expect(glSceneOverride()).toBeNull();
    expect(glBenchProgress()).toBeNull();
    expect(onFinish).toHaveBeenCalledWith(r);
    expect(JSON.parse(localStorage.getItem(BENCH_STORAGE_KEY)!).scenes).toHaveLength(2);
    expect(glBenchResult()).toEqual(r);
    expect((window as any).__rustifyGlBench.status).toBe("done");
  });

  it("cena que derruba o motor vira erro na tabela, a seguinte ainda mede", async () => {
    fakeHost(["dust"]);
    const p = runGlBench({ keys: ["dust", "orbits"], timing: TIMING });
    await vi.advanceTimersByTimeAsync(5000);
    const r = await p;
    expect(r!.scenes[0]).toMatchObject({ key: "dust", ok: false, error: "cena dust: shader não compilou" });
    expect(r!.scenes[1]).toMatchObject({ key: "orbits", ok: true });
    // Nada de castigo depois: o motor do usuário volta a poder montar.
    expect(glStatus().ok).not.toBe(false);
  });

  it("motor que não monta a tempo também vira erro", async () => {
    // Sem host: ninguém responde ao override.
    const p = runGlBench({ keys: ["nebula"], timing: TIMING });
    await vi.advanceTimersByTimeAsync(2000);
    const r = await p;
    expect(r!.scenes[0].error).toMatch(/não montou/);
  });

  it("Esc cancela, restaura e não salva", async () => {
    fakeHost();
    const onFinish = vi.fn();
    const p = runGlBench({ keys: ["dust", "relief"], timing: TIMING, onFinish });
    await vi.advanceTimersByTimeAsync(400);
    const e = new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    window.dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(await p).toBeNull();
    expect(glSceneOverride()).toBeNull();
    expect(onFinish).toHaveBeenCalledWith(null);
    expect(localStorage.getItem(BENCH_STORAGE_KEY)).toBeNull();
    expect((window as any).__rustifyGlBench).toMatchObject({ status: "cancelled", reason: "Esc" });
  });

  it("uma medição por vez", async () => {
    fakeHost();
    const a = runGlBench({ keys: ["dust"], timing: TIMING });
    expect(await runGlBench({ keys: ["dust"], timing: TIMING })).toBeNull();
    await vi.advanceTimersByTimeAsync(3000);
    expect(await a).not.toBeNull();
  });
});
