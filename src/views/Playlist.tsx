/* ============================================================
   views/Playlist.tsx — Pagina de uma playlist (folder) especifica.
   Param via route('/playlist/:name'). Hero grande (cover mosaico
   2x2) + tracklist com cover por linha. Botoes Pin / Play.

   Estrutura visual alinhada com Album.tsx mas reforcada: hero
   180px, tracklist com .tracks--with-cover (6 cols). Ellipsis em
   title/cell pra texto longo nao vazar.
   ============================================================ */

import { createMemo, createResource, For, Show } from "solid-js";
import {
  libListFolderTracks,
  libListFolders,
  coverUrl,
  type FolderPlaylist,
  type Track,
} from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { isPinned, togglePin, pins } from "../store/pins";
import { route } from "../router";
import { Icon, ICONS } from "../components/Icon";
import { TrackRowTable } from "../components/TrackRowTable";

function fmtTotalDur(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, "0")}min`;
  return `${m}min`;
}

export default function PlaylistView() {
  const name = () => (route().param ? decodeURIComponent(route().param!) : null);

  const [tracks] = createResource(name, async (n): Promise<Track[]> => {
    if (!n) return [];
    try { return await libListFolderTracks(n); } catch { return []; }
  });

  const [folder] = createResource(name, async (n): Promise<FolderPlaylist | null> => {
    if (!n) return null;
    try {
      const list = await libListFolders();
      return list.find((f) => f.name === n) ?? null;
    } catch { return null; }
  });

  // Mosaico 2x2 de capas distintas. Mesma logica do card da listagem
  // de playlists pra manter coerencia visual.
  const heroCovers = createMemo(() => (folder()?.cover_paths ?? []).slice(0, 4));

  // scope "curated": shuffle dentro da playlist embaralha SO esta lista
  // (em vez de virar radio mode baseado em recommendations da track atual).
  function play(t: Track) {
    const all = tracks() ?? [];
    const idx = all.indexOf(t);
    setQueue(all, idx >= 0 ? idx : 0, "curated");
    playTrack(t);
  }

  function playAll() {
    const all = tracks() ?? [];
    if (all.length) {
      setQueue(all, 0, "curated");
      playTrack(all[0]);
    }
  }

  const pinned = createMemo(() => {
    const n = name();
    return n ? pins().includes(n) : false;
  });

  const totalDuration = createMemo(() =>
    (tracks() ?? []).reduce((sum, t) => sum + (t.duration_ms || 0), 0),
  );

  return (
    <article class="view">
      <header class="view__head">
        <div style={{ display: "flex", gap: "24px", "align-items": "flex-end" }}>
          {/* Hero mosaico 2x2 de capas (igual aos cards na lista) */}
          <div class="pl-hero-cover" aria-hidden="true">
            <Show
              when={heroCovers().length > 0}
              fallback={
                <div class="pl-hero-cover__empty">
                  {/* @ts-ignore */}
                  <iconify-icon icon="lucide:disc-3" noobserver />
                </div>
              }
            >
              <For each={Array.from({ length: 4 })}>
                {(_, i) => {
                  const src = () => heroCovers()[i()];
                  return (
                    <Show
                      when={src()}
                      fallback={<div class="pl-hero-cover__quad pl-hero-cover__quad--empty" />}
                    >
                      <div class="pl-hero-cover__quad">
                        <img src={coverUrl(src()!)} alt="" loading="lazy" />
                      </div>
                    </Show>
                  );
                }}
              </For>
            </Show>
          </div>

          <div class="pl-hero-meta">
            <div class="pl-hero-meta__kicker">Playlist · Folder</div>
            <h1 class="pl-hero-meta__title">{name() ?? "Playlist"}</h1>
            <p class="pl-hero-meta__stats">
              <b>{tracks()?.length ?? 0}</b> tracks
              <Show when={(tracks() ?? []).length > 0}>
                <span class="pl-hero-meta__sep">·</span>
                {fmtTotalDur(totalDuration())}
              </Show>
            </p>
          </div>
        </div>

        <div class="pl-hero-actions">
          <button
            class="pl-action-btn"
            classList={{ "is-on": pinned() }}
            type="button"
            onClick={() => { const n = name(); if (n) togglePin(n); }}
            title={pinned() ? "Unpin" : "Pin"}
          >
            {/* @ts-ignore */}
            <iconify-icon icon={pinned() ? "lucide:pin-off" : "lucide:pin"} noobserver />
            <span>{pinned() ? "Pinned" : "Pin"}</span>
          </button>
          <button class="pl-action-btn pl-action-btn--primary" type="button" onClick={playAll} title="Play all">
            <Icon name={ICONS.play} size={13} />
            <span>Play</span>
          </button>
        </div>
      </header>

      <div class="view__body">
        <div class="tracks tracks--with-cover">
          <div class="tracks__head tracks__idx">#</div>
          <div class="tracks__head" aria-label="Cover" />
          <div class="tracks__head">Title</div>
          <div class="tracks__head">Album</div>
          <div class="tracks__head">Genre</div>
          <div class="tracks__head tracks__mono">Length</div>
          <For each={tracks() ?? []}>
            {(t, i) => (
              <TrackRowTable
                track={t}
                index={i() + 1}
                onClick={() => play(t)}
                coverSlot={
                  <div class="tracks__cover">
                    <Show
                      when={t.album_cover_path}
                      fallback={
                        <div class="tracks__cover-fallback">
                          {/* @ts-ignore */}
                          <iconify-icon icon="lucide:disc-3" noobserver style={{ "font-size": "14px" }} />
                        </div>
                      }
                    >
                      <img src={coverUrl(t.album_cover_path!)} alt="" loading="lazy" />
                    </Show>
                  </div>
                }
              />
            )}
          </For>
        </div>
      </div>
    </article>
  );
}
