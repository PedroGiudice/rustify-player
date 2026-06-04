/* ============================================================
   views/Home.tsx — Hero + Recently played + Album grid.
   Pulls from libSnapshot/libListHistory/libRecommendations.
   ============================================================ */

import { createResource, For, Show } from "solid-js";
import {
  libSnapshot, libListHistory, libGetAlbums, libRecommendations,
  libShuffle, libGetTracksByAlbum, coverUrl,
  type Track, type Album,
} from "../tauri";
import { setQueue, player } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { navigate } from "../router";
import { Icon, ICONS } from "../components/Icon";
import { CoverArt } from "../components/CoverArt";
import { TrackRowList } from "../components/TrackRowList";
import { fmtDur, relTime } from "../lib/format";

export default function Home() {
  const [data] = createResource(async () => {
    const [snap, recent, albums, recs] = await Promise.all([
      libSnapshot(),
      libListHistory(8).catch(() => []),
      libGetAlbums({ limit: 12 }).catch(() => []),
      libRecommendations().catch(() => ({ most_played: [], based_on_top: [], discover: [] })),
    ]);
    return { snap, recent, albums, recs };
  });

  async function shuffleAll() {
    const tracks = await libShuffle(50);
    if (tracks.length) { setQueue(tracks, 0); playTrack(tracks[0]); }
  }

  async function playAlbum(albumTitle: string) {
    const tracks = await libGetTracksByAlbum(albumTitle);
    // scope "curated": album e unidade coerente; shuffle embaralha so este.
    if (tracks.length) { setQueue(tracks, 0, "curated"); playTrack(tracks[0]); }
  }

  function playRow(t: Track, all: Track[]) {
    const idx = all.indexOf(t);
    setQueue(all, idx >= 0 ? idx : 0);
    playTrack(t);
  }

  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>Home</h1>
          <p class="view__head-hint">Local · PipeWire</p>
        </div>
        <Show when={data()}>
          {(d) => (
            <div class="view__stats">
              <span><b>{d().snap.tracks_total.toLocaleString()}</b> tracks</span>
              <span><b>{(d().snap.albums_total ?? d().albums.length).toLocaleString()}</b> albums</span>
              <span><b>{d().snap.embeddings_done.toLocaleString()}</b> embedded</span>
            </div>
          )}
        </Show>
      </header>

      <div class="view__body">
        <Show when={data()} fallback={<EmptyLoading />}>
          {(d) => (
            <>
              {/* Hero */}
              <section>
                <div class="hero-grid">
                  <button
                    class="hero-tile hero-tile--feature"
                    classList={{ "hero-tile--has-cover": !!(player.currentTrack && coverUrl(player.currentTrack.album_cover_path)) }}
                    onClick={() => player.currentTrack ? navigate("/now-playing") : shuffleAll()}
                  >
                    {/* Cover do track atual como background com zoom (cover-fit). */}
                    <Show when={player.currentTrack && coverUrl(player.currentTrack.album_cover_path)}>
                      {(url) => (
                        <div
                          class="hero-tile__bg"
                          style={{ "background-image": `url(${url()})` }}
                          aria-hidden="true"
                        />
                      )}
                    </Show>
                    <div class="hero-tile__eyebrow">
                      <span class="dot" />
                      {player.currentTrack ? "Pick up where you left off" : "Quick start"}
                    </div>
                    <h3 class="hero-tile__title">
                      {player.currentTrack
                        ? `${player.currentTrack.title} · ${player.currentTrack.artist_name ?? ""}`
                        : "Shuffle all"}
                    </h3>
                    <div class="hero-tile__sub">
                      {player.currentTrack
                        ? `${player.durationSecs ? fmtDur(player.durationSecs * 1000) : "—"} · ready to resume`
                        : `${d().snap.tracks_total.toLocaleString()} tracks`}
                    </div>
                    <span class="hero-tile__cta"><Icon name={ICONS.play} size={12} /></span>
                  </button>

                  <button class="hero-tile" onClick={shuffleAll}>
                    <div class="hero-tile__eyebrow">Quick start</div>
                    <h3 class="hero-tile__title">Shuffle all</h3>
                    <div class="hero-tile__sub">{d().snap.tracks_total.toLocaleString()} tracks</div>
                    <span class="hero-tile__cta"><Icon name={ICONS.play} size={12} /></span>
                  </button>

                  <Show
                    when={d().albums.length > 0}
                    fallback={
                      <button class="hero-tile" onClick={shuffleAll}>
                        <div class="hero-tile__eyebrow">Discover</div>
                        <h3 class="hero-tile__title">Surprise me</h3>
                        <div class="hero-tile__sub">{d().snap.tracks_total.toLocaleString()} tracks</div>
                        <span class="hero-tile__cta"><Icon name={ICONS.play} size={12} /></span>
                      </button>
                    }
                  >
                    {(() => {
                      const top = d().albums[0];
                      return (
                        <button class="hero-tile" onClick={() => playAlbum(top.title)}>
                          <div class="hero-tile__eyebrow">From your library</div>
                          <h3 class="hero-tile__title">{top.title}</h3>
                          <div class="hero-tile__sub">
                            {top.artist_name ?? "—"} · {top.track_count} tracks
                          </div>
                          <span class="hero-tile__cta"><Icon name={ICONS.play} size={12} /></span>
                        </button>
                      );
                    })()}
                  </Show>
                </div>
              </section>

              {/* Recently played */}
              <Show when={d().recent.length > 0}>
                <section>
                  <div class="section__head">
                    <h2 class="section__title">Recently played</h2>
                    <a class="section__action" href="#/history">View history →</a>
                  </div>
                  <div class="row-list">
                    <For each={d().recent}>
                      {(t) => (
                        <TrackRowList
                          track={t}
                          onClick={() => playRow(t, d().recent)}
                          whenText={relTime(t.last_played)}
                          contextList={d().recent}
                        />
                      )}
                    </For>
                  </div>
                </section>
              </Show>

              {/* Album grid */}
              <Show when={d().albums.length > 0}>
                <section>
                  <div class="section__head">
                    <h2 class="section__title">Based on your favorites</h2>
                    <a class="section__action" href="#/albums">View all →</a>
                  </div>
                  <div class="card-grid">
                    <For each={d().albums}>
                      {(a: Album) => (
                        <div class="card" onClick={() => playAlbum(a.title)}>
                          <CoverArt
                            seed={a.title}
                            src={coverUrl(a.cover_path)}
                            size="md"
                            class="card__cover"
                          >
                            <button class="card__play" type="button"><Icon name={ICONS.play} size={12} /></button>
                          </CoverArt>
                          <div class="card__title">{a.title}</div>
                          <div class="card__sub">{a.artist_name ?? "—"}</div>
                          <div class="card__meta">{a.track_count} tracks{a.year ? ` · ${a.year}` : ""}</div>
                        </div>
                      )}
                    </For>
                  </div>
                </section>
              </Show>
            </>
          )}
        </Show>
      </div>
    </article>
  );
}

function EmptyLoading() {
  return (
    <div class="empty-state">
      <p class="empty-state__hint mono">scanning library…</p>
    </div>
  );
}
