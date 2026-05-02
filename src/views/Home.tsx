/* ============================================================
   views/Home.tsx — Pagina inicial com quick start, recent,
   recommendations, albums, stats, genres.
   Markup identico ao home.js vanilla.
   ============================================================ */

import { createResource, Show, For } from "solid-js";
import { libSnapshot, libListGenres, libListHistory, libGetAlbums, libRecommendations, libShuffle, libGetAlbum, libGetTracksByAlbum, coverUrl } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { navigate } from "../router";
import type { Track, Album } from "../tauri";

function initials(name: string): string {
  return (name || "?").split(/\s+/).slice(0, 2).map((w) => w[0] || "").join("").toUpperCase();
}

export default function Home() {
  const [data] = createResource(async () => {
    const [snap, genres, recentTracks, albums, recs] = await Promise.all([
      libSnapshot(),
      libListGenres(),
      libListHistory(8).catch(() => []),
      libGetAlbums(8).catch(() => []),
      libRecommendations().catch(() => ({ most_played: [], based_on_top: [], discover: [] })),
    ]);
    return { snap, genres, recentTracks, albums, recs };
  });

  async function shuffleAll() {
    const tracks = await libShuffle(50);
    if (tracks.length > 0) { setQueue(tracks, 0); playTrack(tracks[0]); }
  }

  function playRecentTrack(t: Track) {
    setQueue([t], 0);
    playTrack(t);
  }

  async function playAlbum(albumId: number) {
    const tracks = await libGetTracksByAlbum(albumId);
    if (tracks.length) { setQueue(tracks, 0); playTrack(tracks[0]); }
  }

  function playRecTrack(tracks: Track[], t: Track) {
    const idx = tracks.indexOf(t);
    setQueue(tracks, idx >= 0 ? idx : 0);
    playTrack(t);
  }

  return (
    <article class="view">
      <header class="view__header">
        <h1 class="view__title">Home</h1>
        <Show when={data()}>
          {(d) => {
            const populated = d().genres.filter((g: any) => g.track_count > 0);
            return (
              <div class="view__stats">
                <span>{d().snap.tracks_total} tracks</span>
                <span class="view__stats-sep">{"•"}</span>
                <span>{populated.length} genres</span>
                <span class="view__stats-sep">{"•"}</span>
                <span>{d().snap.embeddings_done}/{d().snap.tracks_total} embedded</span>
              </div>
            );
          }}
        </Show>
      </header>

      <div class="view__body">
        <Show when={data()} fallback={<p class="empty-state__hint">Loading...</p>}>
          {(d) => {
            const populated = d().genres.filter((g: any) => g.track_count > 0);
            return <>
              {/* Quick Start */}
              <section class="home-section">
                <h2 class="home-section__title">Quick Start</h2>
                <div class="home-actions">
                  <button class="home-action" onClick={shuffleAll}>
                    <span class="home-action__label">Shuffle All</span>
                    <span class="home-action__hint">{d().snap.tracks_total} tracks</span>
                  </button>
                  <a class="home-action" href="#/library">
                    <span class="home-action__label">Browse Library</span>
                    <span class="home-action__hint">folders & genres</span>
                  </a>
                  <a class="home-action" href="#/albums">
                    <span class="home-action__label">Albums</span>
                    <span class="home-action__hint">browse by album</span>
                  </a>
                  <a class="home-action" href="#/now-playing">
                    <span class="home-action__label">Now Playing</span>
                    <span class="home-action__hint">full-screen view</span>
                  </a>
                </div>
              </section>

              {/* Recently Played */}
              <Show when={d().recentTracks.length > 0}>
                <section class="home-section">
                  <h2 class="home-section__title">Recently Played</h2>
                  <div class="recent-grid">
                    <For each={d().recentTracks}>
                      {(t: Track) => (
                        <button class="recent-item" onClick={() => playRecentTrack(t)}>
                          <div class="recent-item__cover">
                            <Show when={t.album_cover_path}>
                              {(p) => <img src={coverUrl(p())!} alt="" />}
                            </Show>
                          </div>
                          <div class="recent-item__meta">
                            <div class="recent-item__title">{t.title || "—"}</div>
                            <div class="recent-item__sub">{t.artist_name || "—"}</div>
                          </div>
                        </button>
                      )}
                    </For>
                  </div>
                </section>
              </Show>

              {/* Based on Your Favorites */}
              <Show when={d().recs.based_on_top?.length > 0}>
                <section class="home-section">
                  <h2 class="home-section__title">Based on Your Favorites</h2>
                  <div class="recent-grid">
                    <For each={d().recs.based_on_top}>
                      {(t: Track) => (
                        <button class="recent-item" onClick={() => playRecTrack(d().recs.based_on_top, t)}>
                          <div class="recent-item__cover">
                            <Show when={t.album_cover_path}>
                              {(p) => <img src={coverUrl(p())!} alt="" />}
                            </Show>
                          </div>
                          <div class="recent-item__meta">
                            <div class="recent-item__title">{t.title || "—"}</div>
                            <div class="recent-item__sub">{t.artist_name || "—"}</div>
                          </div>
                        </button>
                      )}
                    </For>
                  </div>
                </section>
              </Show>

              {/* Discover */}
              <Show when={d().recs.discover?.length > 0}>
                <section class="home-section">
                  <h2 class="home-section__title">Discover</h2>
                  <div class="recent-grid">
                    <For each={d().recs.discover}>
                      {(t: Track) => (
                        <button class="recent-item" onClick={() => playRecTrack(d().recs.discover, t)}>
                          <div class="recent-item__cover">
                            <Show when={t.album_cover_path}>
                              {(p) => <img src={coverUrl(p())!} alt="" />}
                            </Show>
                          </div>
                          <div class="recent-item__meta">
                            <div class="recent-item__title">{t.title || "—"}</div>
                            <div class="recent-item__sub">{t.artist_name || "—"}</div>
                          </div>
                        </button>
                      )}
                    </For>
                  </div>
                </section>
              </Show>

              {/* Albums */}
              <Show when={d().albums.length > 0}>
                <section class="home-section">
                  <h2 class="home-section__title">Albums</h2>
                  <div class="card-grid">
                    <For each={d().albums}>
                      {(a: Album) => (
                        <div class="card" onClick={() => navigate(`/album/${a.id}`)}>
                          <div class={`card__cover${a.cover_path ? "" : " card__cover--initials"}`}>
                            <Show when={a.cover_path} fallback={<span>{initials(a.title)}</span>}>
                              {(p) => <img src={coverUrl(p())!} alt="" />}
                            </Show>
                            <button class="card__cover-play" onClick={(e) => { e.stopPropagation(); playAlbum(a.id); }} aria-label="Play">
                              <svg class="icon icon--filled" aria-hidden="true"><use href="#icon-play" /></svg>
                            </button>
                          </div>
                          <div class="card__label">{a.title}</div>
                          <div class="card__sub">{a.album_artist_name || a.artist_name || "—"}</div>
                        </div>
                      )}
                    </For>
                  </div>
                </section>
              </Show>

              {/* Stats */}
              <section class="home-section">
                <h2 class="home-section__title">Stats</h2>
                <div class="stats-grid">
                  <div class="stat-card">
                    <div class="stat-card__value">{d().snap.tracks_total}</div>
                    <div class="stat-card__label">Tracks</div>
                  </div>
                  <div class="stat-card">
                    <div class="stat-card__value">{d().snap.albums_total || "—"}</div>
                    <div class="stat-card__label">Albums</div>
                  </div>
                  <div class="stat-card">
                    <div class="stat-card__value">{d().snap.artists_total || "—"}</div>
                    <div class="stat-card__label">Artists</div>
                  </div>
                  <div class="stat-card">
                    <div class="stat-card__value">{populated.length}</div>
                    <div class="stat-card__label">Genres</div>
                  </div>
                </div>
              </section>

              {/* Genres */}
              <Show when={populated.length > 0}>
                <section class="home-section">
                  <h2 class="home-section__title">Genres</h2>
                  <div class="genre-chips">
                    <For each={populated}>
                      {(g: any) => (
                        <a class="chip" href={`#/library?genre=${g.id}`}>{g.name} ({g.track_count})</a>
                      )}
                    </For>
                  </div>
                </section>
              </Show>
            </>;
          }}
        </Show>
      </div>
    </article>
  );
}
