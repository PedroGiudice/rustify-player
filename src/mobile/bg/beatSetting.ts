/* ============================================================
   beatSetting.ts — o knob "Beat sync" do handoff.

   O protótipo escrevia --bg-beat-depth/--bg-beat-mode direto no
   <html> (igual ao Tweaks do desktop). Aqui é a mesma coisa, com
   persistência local — nenhum trilho IPC envolvido.
   ============================================================ */

import { createSignal } from "solid-js";

export const BEAT_MODES = ["Off", "Subtle", "Default", "Pulse"] as const;
export type BeatMode = (typeof BEAT_MODES)[number];

const DEPTH: Record<BeatMode, number> = { Off: 0, Subtle: 0.3, Default: 0.55, Pulse: 0.85 };
const KEY = "rustify-beat-mobile";

function load(): BeatMode {
  try {
    const raw = localStorage.getItem(KEY) as BeatMode | null;
    if (raw && (BEAT_MODES as readonly string[]).includes(raw)) return raw;
  } catch {
    /* default abaixo */
  }
  return "Default";
}

const [beatMode, setBeatModeSignal] = createSignal<BeatMode>(load());
export { beatMode };

export function applyBeatMode(mode: BeatMode = beatMode()) {
  const root = document.documentElement;
  root.style.setProperty("--bg-beat-depth", String(DEPTH[mode]));
  root.style.setProperty("--bg-beat-mode", mode === "Pulse" ? "2" : "1");
}

export function setBeatMode(mode: BeatMode) {
  setBeatModeSignal(mode);
  applyBeatMode(mode);
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    /* sem persistência é degradação aceitável */
  }
}
