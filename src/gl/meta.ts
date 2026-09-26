/* ============================================================
   gl/meta.ts — metadados e status do fundo WebGL, SEM código de GL.

   Existe para que o store e os painéis (Tweaks, Settings do
   mobile) saibam os nomes das cenas e o estado do motor sem
   importar as cenas: o motor (gl/engine.ts + gl/scenes/*) entra
   por dynamic import (App.tsx, MobileApp.tsx) e quem roda o
   fundo 2D não paga nada no boot. Este módulo é o canal de ida e
   volta entre o motor e a UI.

   Cena nova: uma entrada em SCENE_META (aqui) e uma em SCENES
   (gl/registry.ts). O contrato da cena está em gl/scene.ts.
   ============================================================ */

import { createSignal } from "solid-js";

/** Ordem = ordem dos botões no painel. */
export const SCENE_META = [
  {
    key: "dust",
    label: "Poeira",
    hint: "Partículas com profundidade: graves inflam e acendem, médios aceleram a deriva",
  },
  {
    key: "relief",
    label: "Relevo",
    hint: "Malha em perspectiva com névoa: o terreno respira com os graves",
  },
  {
    key: "orbits",
    label: "Órbitas",
    hint: "Túnel de anéis: graves dilatam, agudos acendem",
  },
  {
    key: "nebula",
    label: "Nébula",
    hint: "Fluido de ruído num shader só, sem geometria — custo todo em fillrate",
  },
] as const;

export type SceneKey = (typeof SCENE_META)[number]["key"];

export const SCENE_KEYS: readonly SceneKey[] = SCENE_META.map((m) => m.key);

export const SCENE_LABELS = Object.fromEntries(SCENE_META.map((m) => [m.key, m.label])) as Record<SceneKey, string>;

/** Uma linha por cena — o que o usuário lê no painel. */
export const SCENE_HINTS = Object.fromEntries(SCENE_META.map((m) => [m.key, m.hint])) as Record<SceneKey, string>;

export function isSceneKey(v: unknown): v is SceneKey {
  return typeof v === "string" && (SCENE_KEYS as readonly string[]).includes(v);
}

export interface GlStatus {
  /** null = motor nunca montou nesta sessão. */
  ok: boolean | null;
  /** Nome do renderer GL exposto pelo driver (diagnóstico). */
  renderer: string;
  /** Motivo, quando ok === false. */
  error: string;
  /** Medido no app real, 1x/s. É o gate de performance da feature. */
  fps: number;
}

const EMPTY: GlStatus = { ok: null, renderer: "", error: "", fps: 0 };

const [status, setStatus] = createSignal<GlStatus>(EMPTY);

export const glStatus = status;
export const setGlStatus = setStatus;

/** Ao (re)ligar o motor: uma falha anterior não condena a sessão. */
export function resetGlStatus(): void {
  setStatus(EMPTY);
}

/* ---------- cena que o motor está desenhando de fato ---------- */

/** Chave da cena montada no motor agora (null = motor desligado ou a
    cena falhou). Quem escreve é o host do motor (gl/host.ts). */
const [activeScene, setActiveScene] = createSignal<SceneKey | null>(null);
export const glActiveScene = activeScene;
export const setGlActiveScene = setActiveScene;

/* ---------- override da medição ---------- */

/** Enquanto a medição de cenas (gl/bench.ts) roda, força o motor WebGL
    e a cena medida SEM tocar nas preferências salvas do usuário:
    cancelar ou fechar o app no meio não deixa a escolha dele trocada. */
const [sceneOverride, setSceneOverride] = createSignal<SceneKey | null>(null);
export const glSceneOverride = sceneOverride;
export const setGlSceneOverride = setSceneOverride;

/** O motor WebGL deve estar montado? Preferência do usuário OU medição
    em andamento. (A falha de contexto, glStatus.ok === false, é checada
    à parte por quem monta.) */
export function glEngineWanted(pref: string): boolean {
  return pref === "webgl" || sceneOverride() !== null;
}

/* ---------- estilo do Relevo (variantes em avaliação, 26/09) ----------

   O CEO quer o Relevo "menos quadrado e angular" e escolhe vendo, no
   app. Três eixos independentes, todos lidos pela cena a cada quadro
   (gl/scenes/relief.ts); a escolha vencedora vira o padrão e os eixos
   que perderem saem do código.

   Intensidade: decisão do CEO (26/09) — brilho e cor ÚNICOS em todas
   as variantes, estáveis no tempo (sem degradê crista/vale, sem pulso
   com a batida, sem deriva de cor nos agudos). Só a névoa de distância
   continua. "original" é a ÚNICA exceção: é a referência intacta da
   versão anterior, para comparar lado a lado.

   Quem escreve: o desktop sincroniza as preferências do Tweaks
   (store/tweaks.ts) em setGlReliefStyle; o mobile não escreve e fica
   no RELIEF_DEFAULT. A medição de cenas (gl/bench.ts) força uma
   variante por glReliefOverride, sem tocar na preferência salva. */

/** Ordem = ordem dos botões no painel e do ciclo das teclas , e . */
export const RELIEF_LINES = [
  {
    key: "original",
    label: "Original",
    hint: "Referência: a versão anterior, com brilho variando pela altura e pela música",
  },
  {
    key: "mesh",
    label: "Malha",
    hint: "A malha triangulada de sempre, com brilho único",
  },
  {
    key: "ridges",
    label: "Cristas",
    hint: "Só as linhas transversais, em curvas contínuas e suavizadas",
  },
  {
    key: "contours",
    label: "Curvas de nível",
    hint: "Linhas de mesma altura, como um mapa topográfico em relevo",
  },
  {
    key: "weave",
    label: "Rede",
    hint: "Linhas nas duas direções, deformadas para não formar quadrados",
  },
] as const;

export type ReliefLines = (typeof RELIEF_LINES)[number]["key"];

export const RELIEF_LINE_KEYS: readonly ReliefLines[] = RELIEF_LINES.map((m) => m.key);

/** "detailed" = fbm de 5 oitavas (o terreno de sempre); "smooth" = sem
    as oitavas mais finas que a malha consegue desenhar (as que viram
    pontas e vincos). */
export type ReliefShape = "detailed" | "smooth";

/** "open" = linhas de trás aparecem através do morro (o Relevo de
    sempre); "solid" = superfície opaca, o que está atrás some. Só vale
    para as variantes desenhadas por pixel (ridges, contours, weave);
    "original" e "mesh" são sempre vazadas. */
export type ReliefSurface = "open" | "solid";

export interface ReliefStyle {
  readonly lines: ReliefLines;
  readonly shape: ReliefShape;
  readonly surface: ReliefSurface;
}

/** Padrão = a malha de sempre com a decisão do CEO aplicada (brilho
    único) e nada mais presumido. */
export const RELIEF_DEFAULT: ReliefStyle = { lines: "mesh", shape: "detailed", surface: "open" };

export function isReliefLines(v: unknown): v is ReliefLines {
  return typeof v === "string" && (RELIEF_LINE_KEYS as readonly string[]).includes(v);
}

/** Variante desenhada por pixel (a que tem o eixo Superfície). */
export function reliefHasSurface(lines: ReliefLines): boolean {
  return lines === "ridges" || lines === "contours" || lines === "weave";
}

/** Estado salvo por outra versão (ou editado à mão) nunca monta variante
    inexistente: campo inválido cai no padrão, campo a campo. */
export function sanitizeReliefStyle(v: Partial<Record<keyof ReliefStyle, unknown>> | null | undefined): ReliefStyle {
  return {
    lines: isReliefLines(v?.lines) ? v.lines : RELIEF_DEFAULT.lines,
    shape: v?.shape === "detailed" || v?.shape === "smooth" ? v.shape : RELIEF_DEFAULT.shape,
    surface: v?.surface === "open" || v?.surface === "solid" ? v.surface : RELIEF_DEFAULT.surface,
  };
}

const [reliefStyle, setReliefStyle] = createSignal<ReliefStyle>(RELIEF_DEFAULT);
/** Preferência do usuário (desktop: espelho do Tweaks). */
export const glReliefStyle = reliefStyle;
export const setGlReliefStyle = setReliefStyle;

const [reliefOverride, setReliefOverride] = createSignal<ReliefStyle | null>(null);
/** Variante forçada pela medição de cenas; null = vale a preferência. */
export const glReliefOverride = reliefOverride;
export const setGlReliefOverride = setReliefOverride;

/** O que a cena desenha agora: override da medição > preferência. */
export function effectiveReliefStyle(): ReliefStyle {
  return reliefOverride() ?? reliefStyle();
}
