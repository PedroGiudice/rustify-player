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
  {
    key: "bokeh",
    label: "Palco",
    hint: "Luzes de palco fora de foco em três planos: graves acendem, o bumbo estoura clarões, agudos cintilam na treliça",
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
