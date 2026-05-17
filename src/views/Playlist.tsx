/* ============================================================
   views/Playlist.tsx — Pagina de uma playlist (folder) especifica.
   Param via route('/playlist/:name'). Lista as tracks da folder
   com botao de Play All, Pin toggle, e click-to-play por linha.

   Mesma estrutura de Album.tsx pra consistencia visual.
   ============================================================ */

import { createMemo, createResource, For, Show } from "solid-js";
import { libListFolderTracks, libListFolders, coverUrl, type FolderPlaylist, type Track } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { isPinned, togglePin, pins } from "../store/pins";
import { route } from "../router";
import { Icon, ICONS } from "../components/Icon";

function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export default function PlaylistView() {
  const name = () => route().param ? decodeURIComponent(route().param!) : null;

  const [tracks] = createResource(name, async (n): Promise<Track[]> => {
    if (!n) return [];
    try { return await libListFolderTracks(n); } catch { return []; }
  });

  // Folder metadata (cover_paths pro mosaico) — vem da lista de folders.
  const [folder] = createResource(name, async (n): Promise<FolderPlaylist | null> => {
    if (!n) return null;
    try {
      const list = await libListFolders();
      return list.find((f) => f.name === n) ?? null;
    } catch { return null; }
  });

  // Hero cover = primeira capa distinta da folder. Fallback colorido se vazio.
  const heroCover = createMemo(() => {
    const covers = folder()?.cover_paths ?? [];
    return covers.length > 0 ? coverUrl(covers[0]) : null;
  });

  function play(t: Track) {
    const all = tracks() ?? [];
    const idx = all.indexOf(t);
    setQueue(all, idx >= 0 ? idx : 0);
    playTrack(t);
  }

  function playAll() {
    const all = tracks() ?? [];
    if (all.length) { setQueue(all, 0); playTrack(all[0]); }
  }

  // Re-render reativo do estado de pin — pins() e sinal.
  const pinned = createMemo(() => {
    const n = name();
    return n ? pins().includes(n) : false;
  });

  return (
    <article class="view">
      <header class="view__head">
        <div style={{ display: "flex", gap: "20px", "align-items": "flex-end" }}>
          <Show
            when={heroCover()}
            fallback={
              <div
                class="pl-card__quad tone-paper"
                style={{ width: "120px", height: "120px", display: "flex", "align-items": "center", "justify-content": "center", "border-radius": "var(--radius-lg)" }}
              >
                {/* @ts-ignore */}
                <iconify-icon icon="lucide:disc-3" noobserver style={{ "font-size": "40px" }} />
              </div>
            }
          >
            <img
              src={heroCover()!}
              alt=""
              loading="lazy"
              style={{ width: "120px", height: "120px", "border-radius": "var(--radius-lg)", "object-fit": "cover" }}
            />
          </Show>
          <div>
            <h1>{name() ?? "Playlist"}</h1>
            <p class="view__head-hint">
              Folder · {tracks()?.length ?? 0} tracks
            </p>
          </div>
        </div>
        <div style={{ display: "flex", gap: "8px" }}>
          <button
            class="sig-pbtn"
            type="button"
            onClick={() => { const n = name(); if (n) togglePin(n); }}
            title={pinned() ? "Unpin" : "Pin"}
          >
            {/* @ts-ignore */}
            <iconify-icon icon={pinned() ? "lucide:pin-off" : "lucide:pin"} noobserver />
            {pinned() ? "Pinned" : "Pin"}
          </button>
          <button class="hero-tile__cta" style={{ position: "static", opacity: 1, width: "32px", height: "32px" }} onClick={playAll} title="Play all">
            <Icon name={ICONS.play} size={12} />
          </button>
        </div>
      </header>

      <div class="view__body">
        <div class="tracks">
          <div class="tracks__head tracks__idx">#</div>
          <div class="tracks__head">Title</div>
          <div class="tracks__head">Album</div>
          <div class="tracks__head">Genre</div>
          <div class="tracks__head tracks__mono">Length</div>
          <For each={tracks() ?? []}>
            {(t, i) => (
              <div class="tracks__row" onClick={() => play(t)} style={{ display: "contents" }}>
                <div class="tracks__idx">{String(t.track_number ?? i() + 1).padStart(2, "0")}</div>
                <div class="tracks__title"><b>{t.title || "—"}</b><small>{t.artist_name || "—"}</small></div>
                <div class="tracks__cell">{t.album_title ?? "—"}</div>
                <div class="tracks__cell">{t.genre_name ?? "—"}</div>
                <div class="tracks__mono">{fmtDur(t.duration_ms)}</div>
              </div>
            )}
          </For>
        </div>
      </div>
    </article>
  );
}
