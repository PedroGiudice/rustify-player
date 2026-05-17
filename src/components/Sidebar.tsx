/* ============================================================
   components/Sidebar.tsx — Light sidebar with Extractor Lab
   styling.

   Reads:
     - route()                  → active highlight
     - player.currentTrack      → mini chip + VU pulse
     - player.isPlaying         → toggle VU animation
   Dispatches:
     - navigate('/now-playing') → opens NP screen
     - postMessage opening cmd palette via custom event
   ============================================================ */

import { For, createSignal, onCleanup, onMount } from "solid-js";
import { route, navigate } from "../router";
import { player } from "../store/player";
import { Icon, ICONS } from "./Icon";
import { CoverArt } from "./CoverArt";
import { coverUrl } from "../tauri";
import logoCassette from "../assets/logo-cassette.png";

const PRIMARY = [
  { route: "/home",    icon: ICONS.home,    label: "Home" },
  { route: "/search",  icon: ICONS.search,  label: "Search", kbd: "⌘K", action: "search" as const },
  { route: "/library", icon: ICONS.library, label: "Library" },
];

const COLECOES = [
  { route: "/playlists", icon: ICONS.playlists, label: "Playlists" },
  { route: "/stations",  icon: ICONS.stations,  label: "Stations" },
];

const FOOTER = [
  { route: "/signal",   icon: ICONS.signal,   label: "Signal" },
  { route: "/settings", icon: ICONS.settings, label: "Settings" },
];

/** Tiny event used by the search nav item to open the command palette. */
export const SEARCH_EVENT = "rustify:open-palette";

export function Sidebar() {
  const [vu, setVu] = createSignal([4, 7, 10]);
  let vuTimer: ReturnType<typeof setInterval> | null = null;

  onMount(() => {
    vuTimer = setInterval(() => {
      if (player.isPlaying) {
        setVu([0, 0, 0].map(() => 2 + Math.random() * 8));
      } else {
        setVu([4, 7, 10]);
      }
    }, 220);
    onCleanup(() => { if (vuTimer) clearInterval(vuTimer); });
  });

  const isActive = (r: string) => route().path === r;

  function handleNavClick(e: MouseEvent, item: { route: string; action?: "search" }) {
    e.preventDefault();
    if (item.action === "search") {
      window.dispatchEvent(new CustomEvent(SEARCH_EVENT));
      return;
    }
    navigate(item.route);
  }

  return (
    <aside class="sidebar" data-screen-label="Sidebar">
      <div class="brand">
        <div class="brand__mark">
          {/* Logo do app (Cassette · Paper Outline). PNG importado direto pra
              Vite resolver o asset com hash. Substitui o lucide:flask-conical
              que era placeholder. */}
          <img src={logoCassette} alt="Rustify" width="20" height="20" />
        </div>
        <div class="brand__word">Rustify</div>
        <div class="brand__dot" title="Bit-perfect output" />
      </div>

      <div class="sidebar__section">
        <For each={PRIMARY}>
          {(item) => (
            <a
              class={`nav-item${isActive(item.route) ? " active" : ""}`}
              href={`#${item.route}`}
              onClick={(e) => handleNavClick(e, item)}
            >
              <Icon name={item.icon} size={16} />
              <span>{item.label}</span>
              {item.kbd && <span class="nav-item__kbd">{item.kbd}</span>}
            </a>
          )}
        </For>
      </div>

      <div class="sidebar__section">
        <div class="sidebar__label">Coleções</div>
        <For each={COLECOES}>
          {(item) => (
            <a
              class={`nav-item${isActive(item.route) ? " active" : ""}`}
              href={`#${item.route}`}
              onClick={(e) => { e.preventDefault(); navigate(item.route); }}
            >
              <Icon name={item.icon} size={16} />
              <span>{item.label}</span>
            </a>
          )}
        </For>
      </div>

      <div class="sidebar__spacer" />

      <div class="sidebar__footer">
        {/* Mini now-playing chip */}
        {player.currentTrack && (
          <div
            class="np-mini"
            onClick={() => navigate("/now-playing")}
            role="button"
            tabindex="0"
          >
            <CoverArt
              seed={player.currentTrack.album_title || player.currentTrack.id}
              src={coverUrl(player.currentTrack.album_cover_path)}
              size="sm"
              style={{ width: "32px", height: "32px" }}
            />
            <div class="np-mini__meta">
              <div class="np-mini__title">{player.currentTrack.title || "—"}</div>
              <div class="np-mini__artist">{player.currentTrack.artist_name || "—"}</div>
            </div>
            <div class="np-mini__vu">
              <For each={vu()}>{(h) => <span style={{ height: `${h}px` }} />}</For>
            </div>
          </div>
        )}

        <a
          class={`nav-item${isActive("/now-playing") ? " active" : ""}`}
          href="#/now-playing"
          onClick={(e) => { e.preventDefault(); navigate("/now-playing"); }}
        >
          <Icon name={ICONS.music} size={16} />
          <span>Now Playing</span>
          <span class="nav-item__kbd">N</span>
        </a>

        <For each={FOOTER}>
          {(item) => (
            <a
              class={`nav-item${isActive(item.route) ? " active" : ""}`}
              href={`#${item.route}`}
              onClick={(e) => { e.preventDefault(); navigate(item.route); }}
            >
              <Icon name={item.icon} size={16} />
              <span>{item.label}</span>
            </a>
          )}
        </For>

        {/* Tweaks: dispara o painel flutuante (fonts + zoom). */}
        <button
          class="nav-item"
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("toggle-tweaks"))}
          title="Tweaks (fonts, zoom)"
        >
          <Icon name={ICONS.bolt} size={16} />
          <span>Tweaks</span>
        </button>
      </div>
    </aside>
  );
}
