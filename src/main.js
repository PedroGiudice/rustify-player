// Entry — loads tweaks first (to avoid flash), then wires shell components and router.

import { mountSidebar } from "./js/components/sidebar.js";
import { mountPlayerBar } from "./js/components/player-bar.js";
import { loadTweaks, mountTweaks } from "./js/components/tweaks.js";
import { mountResources, toggleResources } from "./js/components/resources.js";
import { mountSearchBar } from "./js/components/search-bar.js";
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
  // Tauri 2 with withGlobalTauri: window API lives under __TAURI__.window
  const api = window.__TAURI__?.window;
  if (!api) {
    console.warn("[titlebar] Tauri window API not available");
    return;
  }
  const appWindow = api.getCurrentWindow();
  if (!appWindow) {
    console.warn("[titlebar] getCurrentWindow() returned null");
    return;
  }
  document.getElementById("titlebar-minimize")?.addEventListener("click", () => {
    appWindow.minimize().catch((e) => console.error("[titlebar] minimize:", e));
  });
  document.getElementById("titlebar-maximize")?.addEventListener("click", async () => {
    try {
      (await appWindow.isMaximized()) ? await appWindow.unmaximize() : await appWindow.maximize();
    } catch (e) {
      console.error("[titlebar] maximize:", e);
    }
  });
  document.getElementById("titlebar-close")?.addEventListener("click", () => {
    appWindow.close().catch((e) => console.error("[titlebar] close:", e));
  });
}

function wireGlobalBack() {
  const btn = document.getElementById("nav-back");
  if (!btn) return;

  btn.addEventListener("click", () => {
    window.history.back();
  });

  const update = (path) => {
    const hideOn = !path || path === "/home" || path === "/" || path === "";
    btn.hidden = hideOn;
  };

  // Initial state based on current hash
  const initialPath = window.location.hash.replace(/^#/, "").split("/").slice(0, 2).join("/") || "/home";
  update(initialPath || "/home");

  window.addEventListener("route-changed", (e) => {
    update(e.detail?.path);
  });
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
  wireGlobalBack();

  // 4. Mount shell components
  mountSidebar(sidebar);
  mountPlayerBar(playerBar);
  mountTweaks();
  mountResources();

  // 4b. Mount search bar in titlebar
  const titlebarCenter = document.getElementById("titlebar-center");
  if (titlebarCenter) mountSearchBar(titlebarCenter);

  // Wire RES button in titlebar
  document.getElementById("titlebar-res")?.addEventListener("click", toggleResources);

  // 5. Start router
  initRouter(main);
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
