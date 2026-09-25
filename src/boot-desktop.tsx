/* ============================================================
   main.tsx — Entry point Solid.

   CSS: unificado no extractor-lab.css (substitui tokens/base/
   layout/components do design anterior). O sprite de icones
   continua carregado porque a Titlebar usa #icon-logo-mark.
   ============================================================ */

// Registro offline dos ícones Iconify (substitui a CDN) — antes de qualquer render.
import "./icons-offline";

import { render } from "solid-js/web";
import { attachConsole } from "@tauri-apps/plugin-log";
import App from "./App";

// Redesign Extractor Lab — um CSS unico
import "./styles/extractor-lab.css";

// Sprite de icones: Titlebar usa, demais lugares usam Iconify
async function loadIconSprite() {
  try {
    const res = await fetch("assets/icons.svg");
    if (!res.ok) throw new Error(`sprite fetch ${res.status}`);
    const svg = await res.text();
    const holder = document.createElement("div");
    holder.style.display = "none";
    holder.setAttribute("aria-hidden", "true");
    holder.innerHTML = svg;
    document.body.prepend(holder);
  } catch (err) {
    console.error("[icons] sprite load failed", err);
  }
}

// Aplica DSP state persistido ao backend antes de renderizar
import { applyFullDspState } from "./store/dsp";
// Aplica loudness norm/target persistido ao backend (com retry de boot)
import { applyLoudnessState } from "./store/tweaks";
// Restaura o volume persistido (kv-volume) e empurra pro engine
import { applyPersistedVolume } from "./store/player";
// Board do Crate: ciclo LONGO, atravessa views — precisa estar de pé
// desde o boot pra alimentar o badge da sidebar mesmo com a view
// desmontada (spec §3.5, M6).
import { bootCrateStore } from "./store/crate";
// Ink adaptativo: bg/linhas seguem a cor da capa da faixa tocando
import { wireAdaptiveInk } from "./lib/adaptiveInk";
// Custom properties de cor tipadas (<color>) — habilita a transition
// declarada no :root (crossfade nativo de accent/ink/tema)
import { registerAnimatedColorProps } from "./lib/animatedColorProps";

async function boot() {
  attachConsole();
  registerAnimatedColorProps();
  await loadIconSprite();
  applyFullDspState().catch((e) => console.warn("[dsp] initial sync failed:", e));
  applyLoudnessState().catch((e) => console.warn("[loudness] initial sync failed:", e));
  applyPersistedVolume().catch((e) => console.warn("[volume] initial sync failed:", e));
  bootCrateStore().catch((e) => console.warn("[crate] boot failed:", e));

  // Hot-reload armado SEMPRE (não só com tema salvo): quem parte do Default
  // e escolhe um YAML no Settings também recarrega a quente. O listener só
  // re-aplica o tema ativo (ver wireThemeHotReload).
  const { applyThemeByName, watchTheme, wireThemeHotReload } = await import("./tauri");
  wireThemeHotReload().catch((e) => console.warn("[theme] listener failed:", e));
  const savedTheme = localStorage.getItem("rustify-theme");
  if (savedTheme) {
    applyThemeByName(savedTheme).catch((e) => console.warn("[theme] load failed:", savedTheme, e));
    watchTheme(savedTheme).catch((e) => console.warn("[theme] watch failed:", e));
  }

  wireAdaptiveInk();

  render(() => <App />, document.getElementById("app")!);
}

boot();
