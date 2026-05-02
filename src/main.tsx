/* ============================================================
   main.tsx — Entry point. Substitui main.js.
   ============================================================ */

import { render } from "solid-js/web";
import App from "./App";

// CSS inalterado — importado aqui para o Vite bundlar
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/components.css";

// Carrega sprite de ícones (igual ao loadIconSprite em main.js)
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
  await loadIconSprite();
  applyFullDspState().catch((e) => console.warn("[dsp] initial sync failed:", e));
  render(() => <App />, document.getElementById("app")!);
}

boot();
