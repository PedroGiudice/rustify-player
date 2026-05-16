/* ============================================================
   main.tsx — Entry point Solid.

   CSS: unificado no extractor-lab.css (substitui tokens/base/
   layout/components do design anterior). O sprite de icones
   continua carregado porque a Titlebar usa #icon-logo-mark.
   ============================================================ */

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

async function boot() {
  attachConsole();
  await loadIconSprite();
  applyFullDspState().catch((e) => console.warn("[dsp] initial sync failed:", e));

  const savedTheme = localStorage.getItem("rustify-theme");
  if (savedTheme) {
    import("./tauri").then(({ applyThemeByName }) =>
      applyThemeByName(savedTheme).catch(() => {})
    );
  }

  render(() => <App />, document.getElementById("app")!);
}

boot();
