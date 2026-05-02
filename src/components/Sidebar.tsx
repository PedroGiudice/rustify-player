/* ============================================================
   components/Sidebar.tsx — Migra sidebar.js para Solid.
   VU bars animam reativamente via player store.
   ============================================================ */

import { For, createSignal, onMount, onCleanup } from "solid-js";
import { route, navigate } from "../router";
import { onPlayerState } from "../tauri";

const NAV_ITEMS = [
  { route: "/home",      icon: "home",        label: "Home" },
  { route: "/library",   icon: "library",     label: "Library" },
  { route: "/artists",   icon: "person",      label: "Artists" },
  { route: "/albums",    icon: "album",       label: "Albums" },
  { route: "/tracks",    icon: "audiotrack",  label: "Tracks" },
  { route: "/playlists", icon: "queue-music", label: "Playlists" },
  { route: "/stations",  icon: "radio",       label: "Stations" },
  { route: "/queue",     icon: "queue-music", label: "Queue" },
  { route: "/history",   icon: "history",     label: "History" },
];

export function Sidebar() {
  // VU bars — signal com alturas dos 5 bars
  const [vuHeights, setVuHeights] = createSignal([4, 7, 10, 6, 8]);
  let vuInterval: ReturnType<typeof setInterval> | null = null;

  onMount(async () => {
    const unlisten = await onPlayerState((p) => {
      if ("Position" in p || "TrackStarted" in p) {
        if (!vuInterval) {
          vuInterval = setInterval(() => {
            setVuHeights([0,0,0,0,0].map(() => 3 + Math.random() * 9));
          }, 180);
        }
      } else if ("StateChanged" in p) {
        const s = p.StateChanged;
        if (s === "Paused" || s === "Idle" || s === "Stopped") {
          clearInterval(vuInterval!);
          vuInterval = null;
          setVuHeights([4, 7, 10, 6, 8]);
        }
      }
    });
    onCleanup(() => {
      unlisten();
      if (vuInterval) clearInterval(vuInterval);
    });
  });

  const isActive = (r: string) => route().path === r;

  return (
    <aside class="sidebar" id="sidebar">
      <div class="sidebar__logo">
        <svg class="icon--lg" aria-hidden="true">
          <use href="#icon-logo-mark" />
        </svg>
        <span class="sidebar__logo-word">Rustify</span>
      </div>

      <nav class="sidebar__nav" aria-label="Primary">
        <For each={NAV_ITEMS}>
          {(item) => (
            <a
              class={`sidebar-item${isActive(item.route) ? " active" : ""}`}
              href={`#${item.route}`}
              title={item.label}
            >
              <svg class="icon" aria-hidden="true">
                <use href={`#icon-${item.icon}`} />
              </svg>
              <span class="sidebar-item__label">{item.label}</span>
              <span class="sidebar-item__tooltip">{item.label}</span>
            </a>
          )}
        </For>
      </nav>

      <div class="sidebar__footer">
        <a
          class={`sidebar-item${isActive("/now-playing") ? " active" : ""}`}
          href="#/now-playing"
          title="Now Playing"
        >
          <svg class="icon" aria-hidden="true">
            <use href="#icon-music-note" />
          </svg>
          <span class="sidebar-item__label">Now Playing</span>
          <span class="sidebar-item__tooltip">Now Playing</span>
          {/* VU bars — animadas reativamente via signal */}
          <div class="sidebar__vu" id="sidebar-vu">
            <For each={vuHeights()}>
              {(h) => <span style={{ height: `${h}px` }} />}
            </For>
          </div>
        </a>

        <a
          class={`sidebar-item${isActive("/signal") ? " active" : ""}`}
          href="#/signal"
          title="Signal"
        >
          <svg class="icon" aria-hidden="true"><use href="#icon-sliders" /></svg>
          <span class="sidebar-item__label">Signal</span>
          <span class="sidebar-item__tooltip">Signal</span>
        </a>

        <a
          class={`sidebar-item${isActive("/settings") ? " active" : ""}`}
          href="#/settings"
          title="Settings"
        >
          <svg class="icon" aria-hidden="true"><use href="#icon-settings" /></svg>
          <span class="sidebar-item__label">Settings</span>
          <span class="sidebar-item__tooltip">Settings</span>
        </a>

        <button
          class="sidebar-item"
          id="tweaks-toggle"
          title="Tweaks"
          onClick={() => window.dispatchEvent(new CustomEvent("toggle-tweaks"))}
        >
          <svg class="icon" aria-hidden="true"><use href="#icon-sliders" /></svg>
          <span class="sidebar-item__label">Tweaks</span>
          <span class="sidebar-item__tooltip">Tweaks</span>
        </button>
      </div>
    </aside>
  );
}
