/* ============================================================
   views/Album.tsx — Detail page for a single album.
   Param via route('/album/:title'). Shows hero + track list.
   ============================================================ */

import { createResource, For, Show } from "solid-js";
import { libGetTracks, libGetAlbums, coverUrl, type Album, type Track } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { route } from "../router";
import { CoverArt } from "../components/CoverArt";
import { Icon, ICONS } from "../components/Icon";
import { TrackRowTable } from "../components/TrackRowTable";
import { libraryRevision, openMoveDialog } from "../store/moveDialog";

/** Teto da listagem do álbum; bater nele = lista (e o "Mover") incompleta. */
const ALBUM_TRACK_LIMIT = 200;

export default function AlbumView() {
  const title = () => route().param ? decodeURIComponent(route().param!) : null;

  const [album] = createResource(title, async (t): Promise<Album | null> => {
    if (!t) return null;
    try {
      const list = await libGetAlbums({ limit: null });
      return list.find((a) => a.title === t) ?? null;
    } catch { return null; }
  });

  // Filtra pelo artista do álbum além do título: dois álbuns homônimos
  // ("Greatest Hits") não se misturam — e "Mover para playlist…" não leva
  // faixa de outro artista. Espera o álbum resolver para não buscar duas
  // vezes. libraryRevision na chave: recarrega depois de mover.
  const [tracks] = createResource(
    () => (album.loading ? false : { t: title(), artist: album()?.artist_name ?? undefined, rev: libraryRevision() }),
    async ({ t, artist }): Promise<Track[]> => {
      if (!t) return [];
      try { return await libGetTracks({ album: t, artist, limit: ALBUM_TRACK_LIMIT }); } catch { return []; }
    },
  );
  const truncated = () => (tracks()?.length ?? 0) >= ALBUM_TRACK_LIMIT;

  // scope "curated": shuffle dentro do album embaralha SO este tracklist.
  function play(t: Track) {
    const all = tracks() ?? [];
    const idx = all.indexOf(t);
    setQueue(all, idx >= 0 ? idx : 0, "curated", { kind: "album", name: title() ?? undefined });
    playTrack(t);
  }

  function playAll() {
    const all = tracks() ?? [];
    if (all.length) { setQueue(all, 0, "curated", { kind: "album", name: title() ?? undefined }); playTrack(all[0]); }
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
              <Show when={truncated()}>
                <> · mostrando só as primeiras {ALBUM_TRACK_LIMIT}</>
              </Show>
            </p>
          </div>
        </div>
        <div class="pl-hero-actions">
        <button
          class="pl-action-btn"
          type="button"
          disabled={!(tracks()?.length)}
          onClick={() => openMoveDialog(tracks() ?? [], title())}
          title={truncated()
            ? `Move só as ${ALBUM_TRACK_LIMIT} faixas listadas; o álbum tem mais`
            : "Mover o álbum para outra playlist"}
        >
          <Icon name={ICONS.moveTo} size={13} />
          <span>Mover para playlist…</span>
        </button>
        <button
          class="hero-tile__cta"
          type="button"
          aria-label={`Tocar ${title() ?? "álbum"}`}
          style={{ position: "static", opacity: 1, width: "32px", height: "32px" }}
          onClick={playAll}
        >
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
