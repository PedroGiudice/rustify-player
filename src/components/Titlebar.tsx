/* ============================================================
   components/Titlebar.tsx — Barra de janela custom.

   Pareada com `decorations: false` em tauri.conf.json: a janela
   nao tem chrome nativo, entao precisamos prover drag-region +
   botoes funcionais aqui.

   Traffic lights (estilo claude-memory frontend-tauri):
     - vermelho fecha
     - amarelo minimiza
     - verde alterna maximize/restore

   Chamadas via @tauri-apps/api/window, exposto globalmente
   por `withGlobalTauri: true` em tauri.conf.json -> nao precisa
   adicionar deps no package.json.
   ============================================================ */

import { Show } from "solid-js";
import { route } from "../router";

const TRAFFIC = {
  red:    "#ff5f57",
  yellow: "#febc2e",
  green:  "#28c840",
} as const;

function getWin() {
  return window.__TAURI__?.window?.getCurrentWindow?.();
}

async function handleClose() {
  try { await getWin()?.close(); } catch (e) { console.error("[titlebar] close failed:", e); }
}
async function handleMinimize() {
  try { await getWin()?.minimize(); } catch (e) { console.error("[titlebar] minimize failed:", e); }
}
async function handleMaximize() {
  try {
    const win = getWin();
    if (!win) return;
    if (await win.isMaximized()) await win.unmaximize();
    else await win.maximize();
  } catch (e) { console.error("[titlebar] maximize failed:", e); }
}

export function Titlebar() {
  const showBack = () => {
    const p = route().path;
    return p && p !== "/home" && p !== "/";
  };

  return (
    <header class="titlebar" id="titlebar" data-tauri-drag-region>
      <div class="titlebar__lights no-drag">
        <button
          type="button"
          class="tl-dot"
          style={{ background: TRAFFIC.red }}
          aria-label="Fechar"
          title="Fechar"
          onClick={handleClose}
        />
        <button
          type="button"
          class="tl-dot"
          style={{ background: TRAFFIC.yellow }}
          aria-label="Minimizar"
          title="Minimizar"
          onClick={handleMinimize}
        />
        <button
          type="button"
          class="tl-dot"
          style={{ background: TRAFFIC.green }}
          aria-label="Maximizar"
          title="Maximizar"
          onClick={handleMaximize}
        />
      </div>

      <span class="titlebar__text">
        rustify-player <span class="titlebar__dim">· dev</span>
      </span>

      <Show when={showBack()}>
        <button
          type="button"
          class="nav-back no-drag"
          aria-label="Voltar"
          title="Voltar"
          onClick={() => window.history.back()}
        >
          ←
        </button>
      </Show>

      <div class="titlebar__spacer" data-tauri-drag-region />
    </header>
  );
}
