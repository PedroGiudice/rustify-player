/* ============================================================
   gl-bench/bench.ts — custo por cena do motor WebGL2, offscreen.

   Mesmo método do lab v2 (docs/design-refs/fundo-lab-v2): cada cena
   sozinha num canvas 1366x768 fora do DOM, 20 quadros de
   aquecimento e 5 lotes de 24 quadros, com um readPixels de 1 pixel
   no fim de cada lote para esperar a GPU terminar. O número soma CPU
   (física, uploads) e GPU. A composição do canvas na tela não entra.

   Diferença do lab: aqui roda o MOTOR DO APP (gl/engine.ts) com o
   REGISTRO DO APP (gl/registry.ts) — buffer reduzido, composite e
   troca de cena inclusos — e o sinal simulado passa pela cadeia real
   de gl/signal.ts.

   Parâmetros (query string):
     scenes=a,b   só essas chaves
     full         mede também, em resolução cheia, cada cena que usa
                  buffer reduzido (referência da alavanca maxRows)
     shots        envia um PNG do último quadro de cada cena ao runner
                  (POST /shot?name=<chave>.png)

   Ao terminar: document.title = "BENCH " + JSON (o runner lê daí).
   ============================================================ */

import { GlEngine } from "../../src/gl/engine";
import { SCENES } from "../../src/gl/registry";
import { SCENE_KEYS, SCENE_LABELS, type SceneKey } from "../../src/gl/meta";
import { DEFAULT_GL_CFG, createGlSignal, stepGlSignal } from "../../src/gl/signal";
import type { GlPalette } from "../../src/gl/palette";
import type { SceneDef } from "../../src/gl/scene";
import { createSim, stepSim } from "./sim";

const W = 1366;
const H = 768;
const WARM = 20;
const BATCHES = 5;
const PER_BATCH = 24;
const DT = 1 / 60;

/** Tema Copper (o padrão), canvas preto fixo como no app. */
const COPPER: GlPalette = {
  canvas: { r: 0, g: 0, b: 0 },
  ink: { r: 0xc6, g: 0x63, b: 0x3d },
  ink2: { r: 0xd8, g: 0x7a, b: 0x52 },
  soft: { r: 0x85, g: 0x82, b: 0x7b },
};

interface SceneResult {
  key: string;
  label: string;
  /** Mediana dos 5 lotes, ms por quadro. */
  ms: number | null;
  min: number | null;
  max: number | null;
  /** Tamanho da saída da cena (o buffer reduzido, se houver). */
  out: string;
  /** Fração de pixels acesos no último quadro (sanidade: 0 = nada desenhado). */
  lit: number | null;
  glError: number;
  error: string | null;
}

const logEl = document.getElementById("log");
const log = (s: string) => {
  if (logEl) logEl.textContent += s + "\n";
  console.log("[gl-bench] " + s);
};
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function litFraction(gl: WebGL2RenderingContext, px: Uint8Array): number {
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
  let on = 0;
  for (let i = 0; i < px.length; i += 4) if (Math.max(px[i], px[i + 1], px[i + 2]) > 12) on++;
  return on / (W * H);
}

async function postShot(name: string, px: Uint8Array): Promise<void> {
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const ctx = c.getContext("2d")!;
  const img = ctx.createImageData(W, H);
  const row = W * 4;
  for (let y = 0; y < H; y++) img.data.set(px.subarray((H - 1 - y) * row, (H - y) * row), y * row);
  ctx.putImageData(img, 0, 0);
  const blob: Blob | null = await new Promise((r) => c.toBlob(r, "image/png"));
  if (blob) await fetch(`/shot?name=${encodeURIComponent(name)}`, { method: "POST", body: blob }).catch(() => {});
}

async function run(): Promise<void> {
  const q = new URLSearchParams(location.search);
  const only = q.get("scenes")?.split(",").filter(Boolean);
  const wantFull = q.has("full");
  const shots = q.has("shots");

  // Registro do bench: o do app + variantes em resolução cheia (?full).
  const registry: Record<string, SceneDef> = { ...SCENES };
  const plan: Array<{ key: string; label: string }> = [];
  for (const k of SCENE_KEYS) {
    if (only && !only.includes(k)) continue;
    plan.push({ key: k, label: SCENE_LABELS[k] });
    if (wantFull && SCENES[k].maxRows) {
      const fk = `${k}@full`;
      registry[fk] = { ...SCENES[k], maxRows: undefined, key: k };
      plan.push({ key: fk, label: `${SCENE_LABELS[k]} (resolução cheia)` });
    }
  }

  const out: {
    ua: string;
    renderer: string;
    size: string;
    method: string;
    results: SceneResult[];
    error?: string;
  } = {
    ua: navigator.userAgent,
    renderer: "",
    size: `${W}x${H}`,
    method: `${WARM} de aquecimento + ${BATCHES}x${PER_BATCH} quadros, readPixels por lote; ms = mediana dos lotes`,
    results: [],
  };

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  let engine: GlEngine;
  try {
    engine = new GlEngine(canvas, { scenes: registry });
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    document.title = "BENCH " + JSON.stringify(out);
    return;
  }
  const gl = engine.gl;
  out.renderer = engine.rendererName();
  engine.resize(W, H);
  engine.setPalette(COPPER);
  const one = new Uint8Array(4);
  const full = new Uint8Array(W * H * 4);

  for (const { key, label } of plan) {
    const r: SceneResult = { key, label, ms: null, min: null, max: null, out: "", lit: null, glError: 0, error: null };
    out.results.push(r);
    log(`medindo ${label}…`);
    await tick();
    try {
      engine.setScene(key as SceneKey);
    } catch (e) {
      r.error = e instanceof Error ? e.message : String(e);
      log(`  ERRO: ${r.error}`);
      continue;
    }
    const o = engine.outputSize;
    r.out = `${o.w}x${o.h}`;
    const sim = createSim();
    const sig = createGlSignal();
    const step = () => {
      stepGlSignal(sig, DT, true, stepSim(sim, DT), DEFAULT_GL_CFG);
      engine.frame(sig, DT);
    };
    try {
      for (let i = 0; i < WARM; i++) step();
      gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one);
      const times: number[] = [];
      for (let b = 0; b < BATCHES; b++) {
        const t0 = performance.now();
        for (let i = 0; i < PER_BATCH; i++) step();
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, one);
        times.push((performance.now() - t0) / PER_BATCH);
        await tick();
      }
      times.sort((a, b) => a - b);
      r.ms = +times[Math.floor(BATCHES / 2)].toFixed(3);
      r.min = +times[0].toFixed(3);
      r.max = +times[BATCHES - 1].toFixed(3);
      step();
      r.glError = gl.getError();
      r.lit = +litFraction(gl, full).toFixed(4);
      if (shots) await postShot(`${key.replace("@", "-")}.png`, full);
      log(`  ${r.ms} ms (min ${r.min}, max ${r.max}) · saída ${r.out} · acesos ${(r.lit * 100).toFixed(1)}%`);
    } catch (e) {
      r.error = e instanceof Error ? e.message : String(e);
      log(`  ERRO: ${r.error}`);
    }
  }
  engine.dispose();
  document.title = "BENCH " + JSON.stringify(out);
}

run().catch((e) => {
  document.title = "BENCH " + JSON.stringify({ error: e instanceof Error ? e.message : String(e), results: [] });
});
