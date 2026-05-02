/* ============================================================
   components/Titlebar.tsx
   ============================================================ */

import { Show, onMount } from "solid-js";
import { route } from "../router";
import { mountSearchBar } from "../js/components/search-bar.js";
import { toggleResources } from "../js/components/resources.js";

export function Titlebar() {
  // Wire Tauri window controls
  onMount(() => {
    const api = window.__TAURI__?.window;
    if (!api) return;
    const win = api.getCurrentWindow();
    if (!win) return;

    document.getElementById("titlebar-minimize")
      ?.addEventListener("click", () => win.minimize().catch(console.error));
    document.getElementById("titlebar-maximize")
      ?.addEventListener("click", async () => {
        (await win.isMaximized()) ? win.unmaximize() : win.maximize();
      });
    document.getElementById("titlebar-close")
      ?.addEventListener("click", () => win.close().catch(console.error));

    // Mount vanilla SearchBar
    const center = document.getElementById("titlebar-center");
    if (center) mountSearchBar(center);

    // Wire RES button
    document.getElementById("titlebar-res")
      ?.addEventListener("click", () => toggleResources());
  });

  const showBack = () => {
    const p = route().path;
    return p && p !== "/home" && p !== "/";
  };

  return (
    <header class="titlebar" id="titlebar" data-tauri-drag-region>
      <div class="titlebar__left">
        <svg class="titlebar__logo" aria-hidden="true">
          <use href="#icon-logo-mark" />
        </svg>
        <span class="titlebar__text">
          rustify-player <span class="titlebar__dim">· dev</span>
        </span>
        <Show when={showBack()}>
          <button
            class="nav-back"
            id="nav-back"
            type="button"
            aria-label="Back"
            onClick={() => window.history.back()}
          >
            ←
          </button>
        </Show>
      </div>
      <div class="titlebar__center" id="titlebar-center">
        {/* SearchBar é montado aqui via mountSearchBar — deixar vazio por ora */}
      </div>
      <div class="titlebar__controls">
        <button class="titlebar__res" id="titlebar-res" title="Resources (Ctrl+R)">RES</button>
        <button class="titlebar__btn" id="titlebar-minimize" aria-label="Minimize">
          <svg width="10" height="10">
            <line x1="1" y1="5" x2="9" y2="5" stroke="currentColor" stroke-width="1.2" />
          </svg>
        </button>
        <button class="titlebar__btn" id="titlebar-maximize" aria-label="Maximize">
          <svg width="10" height="10">
            <rect x="1" y="1" width="8" height="8" stroke="currentColor" stroke-width="1.2" fill="none" />
          </svg>
        </button>
        <button class="titlebar__btn titlebar__btn--close" id="titlebar-close" aria-label="Close">
          <svg width="10" height="10">
            <line x1="1" y1="1" x2="9" y2="9" stroke="currentColor" stroke-width="1.2" />
            <line x1="9" y1="1" x2="1" y2="9" stroke="currentColor" stroke-width="1.2" />
          </svg>
        </button>
      </div>
    </header>
  );
}
