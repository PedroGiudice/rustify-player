/* ============================================================
   gl-bench/bench.ts — custo por cena do motor WebGL2, offscreen.

   Mesmo método do lab v2 (docs/design-refs/fundo-lab-v2): cada cena
   sozinha num canvas fora do DOM (1366x768 por padrão), 20 quadros de
   aquecimento e 5 lotes de 24 quadros, com um readPixels de 1 pixel
   no fim de cada lote para esperar a GPU terminar. O número soma CPU
   (física, uploads) e GPU. A composição do canvas na tela não entra.

   Diferença do lab: aqui roda o MOTOR DO APP (gl/engine.ts) com o
   REGISTRO DO APP (gl/registry.ts) — buffer reduzido, composite e
   troca de cena inclusos — e o sinal simulado passa pela cadeia real
   de gl/signal.ts.

   Parâmetros (query string):
     scenes=a,b   só essas chaves
     w=1857&h=1048
                  tamanho do canvas (padrão 1366x768; 1857x1048 é o
                  canvas real do CEO: monitor 1920x1080 com zoom 1,15)
     full         mede também, em resolução cheia, cada cena que usa
                  buffer reduzido (referência da alavanca maxRows)
     relief=L,F,S força o estilo do Relevo (linhas, forma, superfície;
                  ex.: relief=ridges,smooth,solid — campo inválido cai
                  no padrão, como no app)
     relief=all   mede o Relevo em TODAS as variantes numa rodada: o
                  original, mesh x 2 formas e ridges/contours/weave x
                  2 formas x 2 superfícies (15)
     settle=<s>   antes da foto, desenha esses segundos de sinal (até 60):
                  cena com estado próprio (ondas do kick da Lorem, giro da
                  Mandala) aparece com o estado desenvolvido
     shots        envia um PNG de cada cena/variante ao runner
                  (POST /shot?name=<chave>.png; Relevo com variante:
                  relief-<linhas>-<forma>-<superfície>.png)
     replay=fft-real-2609
                  troca o sim.ts pelo sinal REAL gravado no app
                  (src/gl/__fixtures__/fft-real-2609.json), evento a
                  evento com o dt gravado. Com shots, em vez do SHOT_T
                  fixo, fotografa os 2 PIORES instantes da reação antiga
                  do Relevo (maior F do original, a 5 s ou mais um do
                  outro): replay<n>-<chave ou relief-variante>.png. Sem
                  relief=, o Relevo sai em original (reação antiga),
                  ridges,smooth,solid e mesh,detailed,open (reação nova).
     cfg=ceo|default
                  cfg do sinal no replay: ceo (padrão, a que o CEO usa)
                  ou os defaults do app. Sem replay, sempre os defaults.
     xfade        mede cada cena COM a dissolução de troca de cena ativa
                  o quadro inteiro (retrato da cena anterior por cima,
                  gl/engine.ts): o custo extra da transição, por cena.

   O shot e a fração de pixels acesos saem de um quadro num instante
   FIXO do sinal simulado (SHOT_T), igual para todas as cenas e
   variantes: dá para comparar os PNGs lado a lado.

   Ao terminar: POST /result com o JSON e depois document.title =
   "BENCH " + JSON. O runner prefere o POST: o título do WebKit trunca
   em ~1000 caracteres, e a rodada relief=all passa disso.
   ============================================================ */

import { GlEngine } from "../../src/gl/engine";
import { SCENES } from "../../src/gl/registry";
import {
  RELIEF_LINES,
  SCENE_KEYS,
  SCENE_LABELS,
  sanitizeReliefStyle,
  setGlReliefOverride,
  type ReliefStyle,
  type SceneKey,
} from "../../src/gl/meta";
import { DEFAULT_GL_CFG, createGlSignal, stepGlSignal, type GlCfg, type GlSignal } from "../../src/gl/signal";
import {
  CEO_GL_CFG,
  decodeFixture,
  titleAt,
  worstInstants,
  type FftFixture,
  type FftReplay,
} from "../../src/gl/fftReplay";
import { reliefAmpFactor, reliefOriginalFactor } from "../../src/gl/reliefReaction";
import type { GlPalette } from "../../src/gl/palette";
import type { SceneDef } from "../../src/gl/scene";
import { createSim, stepSim } from "./sim";

const QS = new URLSearchParams(location.search);
/** Tamanho do canvas; limitado a 4096 para não pedir buffer absurdo. */
const dim = (name: string, def: number) => {
  const v = parseInt(QS.get(name) ?? "", 10);
  return Number.isFinite(v) && v >= 64 && v <= 4096 ? v : def;
};
const W = dim("w", 1366);
const H = dim("h", 768);
/** Instante do shot, em segundos do sinal simulado: 15,75 s fica no
    pico de energia do ciclo de 32 s do sim.ts (máximo em t = 16 s) e
    ~0,1 s depois de um bumbo (tempo 24 a 92 BPM = 15,65 s) — graves e
    batida altos, terreno com relevo bem visível. */
const SHOT_T = 15.75;
/** Gravações disponíveis para ?replay= (import dinâmico: sem replay, a
    página não carrega os 234 KB da fixture). */
const REPLAYS: Record<string, () => Promise<FftFixture>> = {
  "fft-real-2609": () =>
    import("../../src/gl/__fixtures__/fft-real-2609.json").then((m) => m.default as unknown as FftFixture),
};
/** Instantes fotografados no replay e a distância mínima entre eles (s). */
const REPLAY_SHOTS = 2;
const REPLAY_GAP_S = 5;
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

/** `pal=RRGGBB,RRGGBB` (ink,ink2) troca a paleta: ver a cena com a cor
    de uma capa real. Inválido ou ausente = Copper. */
function paletteFromQuery(v: string | null): GlPalette {
  const hex = (h: string) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(h.trim());
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  };
  const [a, b] = (v ?? "").split(",");
  const ink = a ? hex(a) : null;
  const ink2 = b ? hex(b) : null;
  return ink ? { ...COPPER, ink, ink2: ink2 ?? ink } : COPPER;
}

interface SceneResult {
  key: string;
  label: string;
  /** Relevo: "<linhas>-<forma>-<superfície>"; ausente nas outras cenas. */
  variant?: string;
  /** Mediana dos 5 lotes, ms por quadro. */
  ms: number | null;
  min: number | null;
  max: number | null;
  /** Tamanho da saída da cena (o buffer reduzido, se houver). */
  out: string;
  /** Fração de pixels acesos no quadro de SHOT_T (sanidade: 0 = nada desenhado). */
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

/** Entrega o resultado ao runner (POST, sem limite de tamanho) e sinaliza
    pelo título, que é o que o runner espera. */
async function finish(out: unknown): Promise<void> {
  const json = JSON.stringify(out);
  await fetch("/result", { method: "POST", body: json }).catch(() => {});
  document.title = "BENCH " + json;
}

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

/** As 15 variantes do Relevo, na ordem do painel. "original" e "mesh"
    ignoram a superfície (sempre vazadas) e o original ignora a forma. */
function reliefVariants(): ReliefStyle[] {
  const out: ReliefStyle[] = [{ lines: "original", shape: "detailed", surface: "open" }];
  for (const shape of ["detailed", "smooth"] as const) out.push({ lines: "mesh", shape, surface: "open" });
  for (const lines of ["ridges", "contours", "weave"] as const)
    for (const shape of ["detailed", "smooth"] as const)
      for (const surface of ["open", "solid"] as const) out.push({ lines, shape, surface });
  return out;
}

const variantName = (st: ReliefStyle) => `${st.lines}-${st.shape}-${st.surface}`;
const lineLabel = (st: ReliefStyle) => RELIEF_LINES.find((l) => l.key === st.lines)?.label ?? st.lines;

interface PlanItem {
  key: string;
  label: string;
  relief?: ReliefStyle;
  shot: string;
}

async function run(): Promise<void> {
  const q = QS;
  const only = q.get("scenes")?.split(",").filter(Boolean);
  const wantFull = q.has("full");
  const xfade = q.has("xfade");
  const shots = q.has("shots");
  const settle = Math.max(0, Math.min(60, Number(q.get("settle") ?? 0) || 0));
  const reliefQ = q.get("relief");
  const replayQ = q.get("replay");
  let replay: FftReplay | null = null;
  if (replayQ) {
    const load = REPLAYS[replayQ];
    if (!load) {
      await finish({ error: `replay desconhecido: ${replayQ} (há: ${Object.keys(REPLAYS).join(", ")})`, results: [] });
      return;
    }
    replay = decodeFixture(await load());
  }
  const cfg: GlCfg = replay && q.get("cfg") !== "default" ? CEO_GL_CFG : DEFAULT_GL_CFG;
  const reliefPlan: ReliefStyle[] | null =
    reliefQ === "all"
      ? reliefVariants()
      : reliefQ
        ? (() => {
            const [lines, shape, surface] = reliefQ.split(",");
            return [sanitizeReliefStyle({ lines, shape, surface })];
          })()
        : replay && shots
          ? [
              { lines: "original", shape: "detailed", surface: "open" },
              { lines: "ridges", shape: "smooth", surface: "solid" },
              { lines: "mesh", shape: "detailed", surface: "open" },
            ]
          : null;

  // Replay: o sinal de cada instante a fotografar, calculado uma vez
  // (a cadeia do app desde o 1º evento até o instante, dt gravado).
  const instants: { name: string; t: number; title: string; oldF: number; newF: number; sig: GlSignal }[] = [];
  if (replay) {
    const worst = worstInstants(replay, cfg, reliefOriginalFactor, REPLAY_SHOTS, REPLAY_GAP_S);
    worst.forEach((w, n) => {
      const sig = createGlSignal();
      const raw = { low: 0, mid: 0, high: 0 };
      for (let i = 0; i <= w.index; i++) {
        raw.low = replay.v[3 * i];
        raw.mid = replay.v[3 * i + 1];
        raw.high = replay.v[3 * i + 2];
        stepGlSignal(sig, replay.dt[i], true, raw, cfg);
      }
      instants.push({
        name: `replay${n + 1}`,
        t: +w.t.toFixed(2),
        title: titleAt(replay, w.index),
        oldF: +reliefOriginalFactor(sig).toFixed(3),
        newF: +reliefAmpFactor(sig).toFixed(3),
        sig,
      });
    });
    for (const x of instants) log(`${x.name}: ${x.title} @ ${x.t} s · F antigo ${x.oldF} · F novo ${x.newF}`);
  }

  // Registro do bench: o do app + variantes em resolução cheia (?full).
  const registry: Record<string, SceneDef> = { ...SCENES };
  const plan: PlanItem[] = [];
  for (const k of SCENE_KEYS) {
    if (only && !only.includes(k)) continue;
    if (k === "relief" && reliefPlan) {
      for (const st of reliefPlan) {
        plan.push({
          key: k,
          label: `${SCENE_LABELS[k]} · ${lineLabel(st)} · ${st.shape} · ${st.surface}`,
          relief: st,
          shot: `relief-${variantName(st)}.png`,
        });
      }
    } else {
      plan.push({ key: k, label: SCENE_LABELS[k], shot: `${k}.png` });
    }
    if (wantFull && SCENES[k].maxRows) {
      const fk = `${k}@full`;
      registry[fk] = { ...SCENES[k], maxRows: undefined, key: k };
      plan.push({ key: fk, label: `${SCENE_LABELS[k]} (resolução cheia)`, shot: `${k}-full.png` });
    }
  }

  const out: {
    ua: string;
    renderer: string;
    size: string;
    method: string;
    results: SceneResult[];
    replay?: { name: string; cfg: string; instants: { name: string; t: number; title: string; oldF: number; newF: number }[] };
    error?: string;
  } = {
    ua: navigator.userAgent,
    renderer: "",
    size: `${W}x${H}`,
    method: `${WARM} de aquecimento + ${BATCHES}x${PER_BATCH} quadros, readPixels por lote; ms = mediana dos lotes${q.has("xfade") ? "; com a dissolução ativa" : ""}`,
    results: [],
  };
  if (replay)
    out.replay = {
      name: replayQ!,
      cfg: cfg === CEO_GL_CFG ? "ceo" : "default",
      instants: instants.map(({ sig: _s, ...rest }) => rest),
    };

  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  let engine: GlEngine;
  try {
    engine = new GlEngine(canvas, { scenes: registry, fadeTimeScale: xfade ? 1e-6 : 1 });
  } catch (e) {
    out.error = e instanceof Error ? e.message : String(e);
    await finish(out);
    return;
  }
  const gl = engine.gl;
  out.renderer = engine.rendererName();
  engine.resize(W, H);
  engine.setPalette(paletteFromQuery(q.get("pal")));
  const one = new Uint8Array(4);
  const full = new Uint8Array(W * H * 4);

  // xfade: uma cena anterior desenhada (o retrato sai dela) e, a partir
  // daí, toda cena entra com setScene(…, true) — o véu não termina.
  if (xfade && plan.length) {
    const prev = SCENE_KEYS.find((k) => k !== plan[0].key) ?? plan[0].key;
    try {
      engine.setScene(prev as SceneKey);
      engine.frame(createGlSignal(), DT);
    } catch (e) {
      log(`  xfade: cena anterior ${prev} falhou: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  for (const { key, label, relief, shot } of plan) {
    const r: SceneResult = { key, label, ms: null, min: null, max: null, out: "", lit: null, glError: 0, error: null };
    if (relief) r.variant = variantName(relief);
    out.results.push(r);
    log(`medindo ${label}…`);
    await tick();
    // A cena lê o estilo a cada quadro: o override vale já no aquecimento
    // (que absorve a compilação da variante nova).
    setGlReliefOverride(relief ?? null);
    try {
      engine.setScene(key as SceneKey, xfade);
    } catch (e) {
      r.error = e instanceof Error ? e.message : String(e);
      log(`  ERRO: ${r.error}`);
      continue;
    }
    const o = engine.outputSize;
    r.out = `${o.w}x${o.h}`;
    const sim = createSim();
    const sig = createGlSignal();
    // Replay: um evento gravado por quadro, em laço, com o dt gravado.
    let cursor = 0;
    const raw = { low: 0, mid: 0, high: 0 };
    const step = () => {
      if (replay) {
        const i = cursor;
        cursor = (cursor + 1) % replay.n;
        raw.low = replay.v[3 * i];
        raw.mid = replay.v[3 * i + 1];
        raw.high = replay.v[3 * i + 2];
        stepGlSignal(sig, replay.dt[i], true, raw, cfg);
      } else stepGlSignal(sig, DT, true, stepSim(sim, DT), cfg);
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
      // Quadro do shot: sinal recomeçado e avançado até SHOT_T SEM desenhar,
      // e então UM quadro. O Relevo depende só do sinal, então o shot dele
      // é o mesmo em toda rodada; cena com estado próprio integrado segue
      // de onde a medição parou.
      if (replay) {
        // Um quadro por instante pior; cópia do sinal (o frame não o
        // altera, mas a cena lê o objeto: cópia deixa o de referência limpo).
        for (const x of instants) {
          engine.frame({ ...x.sig }, DT);
          r.glError = r.glError || gl.getError();
          r.lit = +litFraction(gl, full).toFixed(4);
          if (shots) await postShot(`${x.name}-${shot}`, full);
        }
      } else {
        const shotSim = createSim();
        const shotSig = createGlSignal();
        for (let t = 0; t < SHOT_T; t += DT) stepGlSignal(shotSig, DT, true, stepSim(shotSim, DT), DEFAULT_GL_CFG);
        // settle=<s>: cena com estado próprio (ondas do kick, giro) ganha
        // esses segundos DESENHANDO antes da foto, com o sinal já aquecido.
        for (let t = 0; t < settle; t += DT) {
          stepGlSignal(shotSig, DT, true, stepSim(shotSim, DT), DEFAULT_GL_CFG);
          engine.frame(shotSig, DT);
        }
        engine.frame(shotSig, DT);
        r.glError = gl.getError();
        r.lit = +litFraction(gl, full).toFixed(4);
        if (shots) await postShot(shot, full);
      }
      log(`  ${r.ms} ms (min ${r.min}, max ${r.max}) · saída ${r.out} · acesos ${(r.lit * 100).toFixed(1)}%`);
    } catch (e) {
      r.error = e instanceof Error ? e.message : String(e);
      log(`  ERRO: ${r.error}`);
    }
  }
  setGlReliefOverride(null);
  engine.dispose();
  await finish(out);
}

run().catch((e) => finish({ error: e instanceof Error ? e.message : String(e), results: [] }));
