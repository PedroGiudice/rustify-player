// Entry — wires shell components and kicks off the router.

import { mountSidebar } from "./js/components/sidebar.js";
import { mountPlayerBar } from "./js/components/player-bar.js";
import { initRouter } from "./js/router.js";

async function loadIconSprite() {
  // Inline the SVG sprite so `<use href="#icon-X">` references resolve
  // without relying on cross-document <use>, which has inconsistent
  // support in webviews (especially under file://).
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

async function boot() {
  // Sprite first — views and components reference #icon-* symbols.
  await loadIconSprite();

  const sidebar = document.getElementById("sidebar");
  const main = document.getElementById("main");
  const playerBar = document.getElementById("player-bar");

  if (!sidebar || !main || !playerBar) {
    console.error("[boot] shell mount points missing");
    return;
  }

  mountSidebar(sidebar);
  mountPlayerBar(playerBar);
  initRouter(main);
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
