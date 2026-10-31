/* ============================================================
   components/Titlebar.tsx — Barra de janela custom.

   Pareada com `decorations: false` em tauri.conf.json: a janela
   nao tem chrome nativo, entao precisamos prover drag-region +
   botoes funcionais aqui.

   Traffic lights (estilo claude-memory frontend-tauri):
     - vermelho fecha
     - amarelo minimiza
     - verde alterna maximize/restore
   Em repouso os três ficam neutros (--fg-7); a cor só aparece com o
   ponteiro ou o foco no grupo (B26, 31/10). A cor mora no CSS
   (.tl-dot--close/min/max), nunca inline.

   Chamadas via @tauri-apps/api/window, exposto globalmente
   por `withGlobalTauri: true` em tauri.conf.json -> nao precisa
   adicionar deps no package.json.
   ============================================================ */

import { Show, onMount } from "solid-js";
import { route } from "../router";
import { mountResources, toggleResources } from "../js/components/resources.js";
import { Icon } from "./Icon";

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
  // Monta o overlay de Resources (HUD) — o overlay vive fora do shell,
  // injetado no body. O botao de Recursos abaixo apenas toggla.
  onMount(() => {
    try { mountResources(); } catch (e) { console.warn("[titlebar] mountResources failed:", e); }
  });

  const showBack = () => {
    const p = route().path;
    return p && p !== "/home" && p !== "/";
  };

  return (
    <header class="titlebar" id="titlebar" data-tauri-drag-region>
      <div class="titlebar__lights no-drag">
        <button
          type="button"
          class="tl-dot tl-dot--close"
          aria-label="Fechar"
          title="Fechar"
          onClick={handleClose}
        />
        <button
          type="button"
          class="tl-dot tl-dot--min"
          aria-label="Minimizar"
          title="Minimizar"
          onClick={handleMinimize}
        />
        <button
          type="button"
          class="tl-dot tl-dot--max"
          aria-label="Maximizar"
          title="Maximizar"
          onClick={handleMaximize}
        />
      </div>

      <span class="titlebar__text">
        Rustify Player {import.meta.env.DEV && <span class="titlebar__dim">· dev</span>}
      </span>

      <Show when={showBack()}>
        <button
          type="button"
          class="nav-back no-drag"
          aria-label="Voltar"
          title="Voltar"
          onClick={() => window.history.back()}
        >
          <Icon name="lucide:arrow-left" size={14} />
        </button>
      </Show>

      <div class="titlebar__spacer" data-tauri-drag-region />

      <button
        type="button"
        class="titlebar__res no-drag"
        aria-label="Recursos (Ctrl+R)"
        title="Recursos (Ctrl+R)"
        onClick={() => toggleResources()}
      >
        {/* Era "RES" em mono 10 px (A14): o HUD de recursos (CPU, memória). */}
        <Icon name="lucide:activity" size={14} />
      </button>
    </header>
  );
}
