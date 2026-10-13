/* ============================================================
   views/Artist.tsx — Detail page for a single artist.
   Lists albums by this artist + their tracks.
   ============================================================ */

import { createResource, For, Show } from "solid-js";
import { libGetAlbumsByArtist, libGetTracksByAlbum, libGetTracksByArtist, coverUrl, type Album } from "../tauri";
import { libraryRevision, openMoveDialog } from "../store/moveDialog";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { navigate, route } from "../router";
import { CoverArt } from "../components/CoverArt";
import { Icon, ICONS } from "../components/Icon";

export default function ArtistView() {
  const name = () => route().param ? decodeURIComponent(route().param!) : null;

  const [albums] = createResource(() => ({ n: name(), rev: libraryRevision() }), async ({ n }): Promise<Album[]> => {
    if (!n) return [];
    // Filtro no backend (mesma igualdade exata do filtro antigo no cliente),
    // sem corte: baixar 500 alfabeticos e filtrar perdia os albuns do fim.
    try { return await libGetAlbumsByArtist(n, null); }
    catch { return []; }
  });

  // Todas as faixas do artista (o teto alto cobre discografia inteira).
  async function moveAll() {
    const n = name(); if (!n) return;
    try {
      const tracks = await libGetTracksByArtist(n, 5000);
      openMoveDialog(tracks, n);
    } catch { /* lista indisponível: o botão só não abre */ }
  }

  async function playAlbum(a: Album) {
    const tracks = await libGetTracksByAlbum(a.title);
    // scope "curated": album e uma unidade coerente do artista.
    if (tracks.length) { setQueue(tracks, 0, "curated", { kind: "album", name: a.title }); playTrack(tracks[0]); }
  }

  return (
    <article class="view">
      <header class="view__head">
        <div style={{ display: "flex", gap: "20px", "align-items": "flex-end" }}>
          <CoverArt
            seed={name() ?? "x"}
            size="lg"
            style={{ width: "120px", height: "120px", "border-radius": "50%" }}
          />
          <div>
            <h1>{name() ?? "Artist"}</h1>
            <p class="view__head-hint">{albums()?.length ?? 0} albums</p>
          </div>
        </div>
        <div class="pl-hero-actions">
          <button
            class="pl-action-btn"
            type="button"
            disabled={!(albums()?.length)}
            onClick={() => void moveAll()}
            title="Mover todas as faixas do artista para outra playlist"
          >
            <Icon name={ICONS.moveTo} size={13} />
            <span>Mover para playlist…</span>
          </button>
        </div>
      </header>

      <div class="view__body">
        <section>
          <div class="section__head"><h2 class="section__title">Albums</h2></div>
          <div class="card-grid">
            <For each={albums() ?? []}>
              {(a) => (
                <div class="card" onClick={() => navigate(`/album/${encodeURIComponent(a.title)}`)}>
                  <CoverArt
                    seed={a.title}
                    src={coverUrl(a.cover_path)}
                    size="md"
                    class="card__cover"
                  >
                    <button class="card__play" type="button" aria-label={`Tocar ${a.title}`} onClick={(e) => { e.stopPropagation(); playAlbum(a); }}>
                      <Icon name={ICONS.play} size={12} />
                    </button>
                  </CoverArt>
                  <div class="card__title">{a.title}</div>
                  <div class="card__sub">{a.track_count} tracks{a.year ? ` · ${a.year}` : ""}</div>
                </div>
              )}
            </For>
          </div>
        </section>
      </div>
    </article>
  );
}
