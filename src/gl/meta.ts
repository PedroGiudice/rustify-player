/* ============================================================
   gl/meta.ts — metadados e status do fundo WebGL, SEM three.

   Existe para que o store e o painel de Tweaks saibam os nomes
   das cenas e o estado do motor sem importar `three` — importar
   scenes.ts de dentro do Tweaks arrastaria a lib inteira pro
   bundle de boot mesmo para quem roda o fundo 2D. O componente
   pesado entra por dynamic import (App.tsx); este módulo é o
   canal de ida e volta entre ele e a UI.
   ============================================================ */

import { createSignal } from "solid-js";

export type SceneKey = "dust" | "relief" | "orbits" | "nebula";

export const SCENE_KEYS: readonly SceneKey[] = ["dust", "relief", "orbits", "nebula"] as const;

export const SCENE_LABELS: Record<SceneKey, string> = {
  dust: "Poeira",
  relief: "Relevo",
  orbits: "Órbitas",
  nebula: "Nébula",
};

/** Uma linha por cena — o que o usuário lê no Tweaks. */
export const SCENE_HINTS: Record<SceneKey, string> = {
  dust: "Partículas com profundidade: graves inflam e acendem, médios aceleram a deriva",
  relief: "Malha em perspectiva com névoa: o terreno respira com os graves",
  orbits: "Túnel de anéis: graves dilatam, agudos acendem",
  nebula: "Fluido de ruído num shader só, sem geometria — a mais barata das quatro",
};

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
