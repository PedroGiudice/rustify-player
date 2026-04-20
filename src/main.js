// Entry — loads tweaks first (to avoid flash), then wires shell components and router.

import { mountSidebar } from "./js/components/sidebar.js";
import { mountPlayerBar } from "./js/components/player-bar.js";
import { loadTweaks, mountTweaks } from "./js/components/tweaks.js";
import { initRouter } from "./js/router.js";

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

function wireTitlebar() {
  const win = window.__TAURI__?.window;
  if (!win) return;
  const appWindow = win.getCurrentWindow();
  document.getElementById("titlebar-minimize")?.addEventListener("click", () => appWindow.minimize());
  document.getElementById("titlebar-maximize")?.addEventListener("click", async () => {
    (await appWindow.isMaximized()) ? appWindow.unmaximize() : appWindow.maximize();
  });
  document.getElementById("titlebar-close")?.addEventListener("click", () => appWindow.close());
}

async function boot() {
  // 1. Apply persisted tweaks before any rendering to avoid flash
  loadTweaks();

  // 2. Load icon sprite — views and components reference #icon-* symbols
  await loadIconSprite();

  const sidebar = document.getElementById("sidebar");
  const main = document.getElementById("main");
  const playerBar = document.getElementById("player-bar");

  if (!sidebar || !main || !playerBar) {
    console.error("[boot] shell mount points missing");
    return;
  }

  // 3. Wire custom titlebar
  wireTitlebar();

  // 4. Mount shell components
  mountSidebar(sidebar);
  mountPlayerBar(playerBar);
  mountTweaks();

  // 5. Start router
  initRouter(main);
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
