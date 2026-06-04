/* ============================================================
   views/Album.tsx — Detail page for a single album.
   Param via route('/album/:title'). Shows hero + track list.
   ============================================================ */

import { createResource, For, Show } from "solid-js";
import { libGetTracksByAlbum, libGetAlbums, coverUrl, type Album, type Track } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { route } from "../router";
import { CoverArt } from "../components/CoverArt";
import { Icon, ICONS } from "../components/Icon";
import { TrackRowTable } from "../components/TrackRowTable";

export default function AlbumView() {
  const title = () => route().param ? decodeURIComponent(route().param!) : null;

  const [tracks] = createResource(title, async (t): Promise<Track[]> => {
    if (!t) return [];
    try { return await libGetTracksByAlbum(t); } catch { return []; }
  });

  const [album] = createResource(title, async (t): Promise<Album | null> => {
    if (!t) return null;
    try {
      const list = await libGetAlbums({ limit: 500 });
      return list.find((a) => a.title === t) ?? null;
    } catch { return null; }
  });

  // scope "curated": shuffle dentro do album embaralha SO este tracklist.
  function play(t: Track) {
    const all = tracks() ?? [];
    const idx = all.indexOf(t);
    setQueue(all, idx >= 0 ? idx : 0, "curated");
    playTrack(t);
  }

  function playAll() {
    const all = tracks() ?? [];
    if (all.length) { setQueue(all, 0, "curated"); playTrack(all[0]); }
  }

  return (
    <article class="view">
      <header class="view__head">
        <div style={{ display: "flex", gap: "20px", "align-items": "flex-end" }}>
          <Show when={album()}>
            {(a) => (
              <CoverArt
                seed={a().title}
                src={coverUrl(a().cover_path)}
                size="lg"
                style={{ width: "120px", height: "120px" }}
              />
            )}
          </Show>
          <div>
            <h1>{title() ?? "Album"}</h1>
            <p class="view__head-hint">
              {album()?.artist_name ?? "—"} · {tracks()?.length ?? 0} tracks
              {album()?.year && <> · {album()!.year}</>}
            </p>
          </div>
        </div>
        <button class="hero-tile__cta" style={{ position: "static", opacity: 1, width: "32px", height: "32px" }} onClick={playAll}>
          <Icon name={ICONS.play} size={12} />
        </button>
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
              <TrackRowTable
                track={t}
                index={t.track_number ?? i() + 1}
                onClick={() => play(t)}
                contextList={tracks() ?? []}
              />
            )}
          </For>
        </div>
      </div>
    </article>
  );
}
