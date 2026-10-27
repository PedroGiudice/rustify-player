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

import { For, Index, Show, createEffect, createSignal, onCleanup, onMount } from "solid-js";
import { route, navigate } from "../router";
import { player } from "../store/player";
import { activeCount, markArrivalsSeen, newArrivals } from "../store/crate";
import { tweaks, tweaksOpen } from "../store/tweaks";
import { Icon, ICONS } from "./Icon";
import { modCombo } from "../lib/keyboard";
import { CoverArt } from "./CoverArt";
import { coverUrl } from "../tauri";

const PRIMARY = [
  { route: "/home",    icon: ICONS.home,    label: "Home", shortcut: "H" },
  { route: "/search",  icon: ICONS.search,  label: "Search", kbd: modCombo("K"), action: "search" as const },
  // Logo abaixo de Search (spec §4.1): é busca, só que além do acervo.
  // Badge de jobs ativos (não-terminais) via store/crate — some em 0.
  { route: "/crate",   icon: ICONS.packageOpen, label: "Crate" },
  { route: "/library", icon: ICONS.library, label: "Library", shortcut: "L" },
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

/** Marca da barra lateral: o cassete do ícone do app (src-tauri/icons)
    redesenhado em traço, na cor do texto (.brand__mark). Monocromático
    por decisão do CEO (26/10): a etiqueta ferrugem do ícone seria uma cor
    fixa fora das três portas da Regra da Moldura Quieta. */
function BrandMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      stroke-width="1.75"
      stroke-linecap="round"
      stroke-linejoin="round"
      role="img"
      aria-label="Rustify"
    >
      <rect x="2.5" y="5" width="19" height="14" rx="2" />
      <circle cx="8" cy="9.5" r="1.75" />
      <circle cx="16" cy="9.5" r="1.75" />
      <rect x="5.5" y="13.75" width="13" height="2.5" rx="0.6" />
    </svg>
  );
}

/** "1 faixa nova no acervo" / "n faixas novas no acervo". */
export function arrivalsText(n: number): string {
  return n === 1 ? "1 faixa nova no acervo" : `${n} faixas novas no acervo`;
}

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
  // A classe .active só pinta: aria-current diz ao leitor de tela em que
  // página se está (ds-2).
  const current = (r: string) => (isActive(r) ? ("page" as const) : undefined);
  // No modo icons o rótulo sai da tela (fica só para leitor de tela):
  // o tooltip é a única dica do que cada ícone faz. No modo labels
  // seria redundante com o texto visível.
  // Tooltip próprio (B23): o title nativo do GTK demora e não mostra o
  // atalho. .nav-tip aparece após 400 ms de hover ou no foco de teclado;
  // aria-hidden, porque o nome acessível já vem do rótulo escondido.
  const iconsMode = () => tweaks().sidebar === "icons";
  function NavTip(props: { label: string; kbd?: string; note?: string }) {
    return (
      <Show when={iconsMode()}>
        <span class="nav-tip" aria-hidden="true">
          <span>{props.label}</span>
          {props.kbd && <kbd class="nav-tip__kbd">{props.kbd}</kbd>}
          {props.note && <span class="nav-tip__note">{props.note}</span>}
        </span>
      </Show>
    );
  }

  // Chegadas do Crate (B8): abrir o Crate apaga o ponto; o efeito também
  // reage a faixa que chega com o Crate já aberto.
  createEffect(() => {
    if (route().path === "/crate" && newArrivals() > 0) markArrivalsSeen();
  });
  const showArrivals = (r: string) =>
    r === "/crate" && activeCount() === 0 && newArrivals() > 0;

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
          <BrandMark />
        </div>
        <div class="brand__word">Rustify</div>
        <div class="brand__dot" title="Bit-perfect output" />
      </div>

      <div class="sidebar__section">
        <For each={PRIMARY}>
          {(item) => (
            <a
              class={`nav-item${isActive(item.route) ? " active" : ""}`}
              aria-current={current(item.route)}
              href={`#${item.route}`}
              onClick={(e) => handleNavClick(e, item)}
            >
              <Icon name={item.icon} size={16} />
              <span>{item.label}</span>
              {item.kbd && <span class="nav-item__kbd">{item.kbd}</span>}
              <Show when={item.route === "/crate" && activeCount() > 0}>
                <span class="nav-item__badge">{activeCount()}</span>
              </Show>
              <Show when={showArrivals(item.route)}>
                <span class="nav-item__new" role="status" title={arrivalsText(newArrivals())}>
                  <span class="nav-item__new-text">{arrivalsText(newArrivals())}</span>
                </span>
              </Show>
              <NavTip
                label={item.label}
                kbd={item.kbd ?? item.shortcut}
                note={showArrivals(item.route) ? arrivalsText(newArrivals()) : undefined}
              />
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
              aria-current={current(item.route)}
              href={`#${item.route}`}
              onClick={(e) => { e.preventDefault(); navigate(item.route); }}
            >
              <Icon name={item.icon} size={16} />
              <span>{item.label}</span>
              <NavTip label={item.label} />
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
            onKeyDown={(e) => {
              // role=button promete Enter/Espaço; sem isto o chip recebia
              // foco por Tab e não fazia nada.
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                navigate("/now-playing");
              }
            }}
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
              {/* Index (nao For): For keia por valor e recriaria os 3 spans
                  a cada tick de 220ms; Index atualiza height in-place. */}
              <Index each={vu()}>{(h) => <span style={{ height: `${h()}px` }} />}</Index>
            </div>
          </div>
        )}

        <a
          class={`nav-item${isActive("/now-playing") ? " active" : ""}`}
          aria-current={current("/now-playing")}
          href="#/now-playing"
          onClick={(e) => { e.preventDefault(); navigate("/now-playing"); }}
        >
          <Icon name={ICONS.music} size={16} />
          <span>Now Playing</span>
          <span class="nav-item__kbd">N</span>
          <NavTip label="Now Playing" kbd="N" />
        </a>

        <For each={FOOTER}>
          {(item) => (
            <a
              class={`nav-item${isActive(item.route) ? " active" : ""}`}
              aria-current={current(item.route)}
              href={`#${item.route}`}
              onClick={(e) => { e.preventDefault(); navigate(item.route); }}
            >
              <Icon name={item.icon} size={16} />
              <span>{item.label}</span>
              <NavTip label={item.label} />
            </a>
          )}
        </For>

        {/* Tweaks: dispara o painel flutuante (aparência, fundo, loudness).
            .active enquanto o painel está aberto, junto com aria-expanded
            (cfg-9). */}
        <button
          class="nav-item"
          classList={{ active: tweaksOpen() }}
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent("toggle-tweaks"))}
          aria-controls="tweaks-panel"
          aria-expanded={tweaksOpen() ? "true" : "false"}
          title={iconsMode() ? undefined : "Tweaks (appearance, background, loudness)"}
        >
          <Icon name={ICONS.bolt} size={16} />
          <span>Tweaks</span>
          <NavTip label="Tweaks" />
        </button>
      </div>
    </aside>
  );
}
