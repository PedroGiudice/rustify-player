/* ============================================================
   views/Home.tsx — Hero + Recently played + Album grid.
   Pulls from libSnapshot/libListHistory/libRecommendations.
   ============================================================ */

import { createMemo, createResource, For, Show } from "solid-js";
import {
  libSnapshot, libListHistory, libGetAlbums, libRecommendations,
  libGetTracksByAlbum, coverUrl,
  type Track, type Album, type Recommendations,
} from "../tauri";
import { setQueue, player } from "../store/player";
import { resetRadioSession } from "../store/radioSession";
import { playTrack } from "../components/PlayerBar";
import { navigate } from "../router";
import { Icon, ICONS } from "../components/Icon";
import { CoverArt } from "../components/CoverArt";
import { TrackRowList } from "../components/TrackRowList";
import { fmtDur, relTime } from "../lib/format";
import { shuffleAll } from "../lib/quickPlay";

const EMPTY_RECS: Recommendations = { most_played: [], based_on_top: [], discover: [] };

/** "1 faixa", "12 faixas" (com separador de milhar). */
function faixas(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "faixa" : "faixas"}`;
}

/** Descoberta do dia: a primeira de `discover` (perto do gosto, nunca
    tocada); sem ela, a primeira de `based_on_top`. O motivo diz de onde veio. */
function pickDiscovery(recs: Recommendations): { track: Track; reason: string } | null {
  const d = recs.discover[0];
  if (d) return { track: d, reason: "nunca tocada, perto do que você curte" };
  const b = recs.based_on_top[0];
  if (b) return { track: b, reason: "perto das suas mais tocadas" };
  return null;
}

export default function Home() {
  const [data] = createResource(async () => {
    const [snap, recent, allAlbums, recs] = await Promise.all([
      libSnapshot(),
      libListHistory(8).catch(() => []),
      // Lista completa: o backend agrupa o acervo inteiro de qualquer forma
      // (o limit so trunca a resposta), e o total real sai dela — o snapshot
      // nao tem albums_total. A prateleira segue sendo os 12 primeiros.
      libGetAlbums({ limit: null }).catch(() => null),
      libRecommendations().catch(() => EMPTY_RECS),
    ]);
    return {
      snap,
      recent,
      albums: (allAlbums ?? []).slice(0, 12),
      albumsTotal: allAlbums?.length ?? null,
      recs,
    };
  });

  async function playAlbum(albumTitle: string) {
    const tracks = await libGetTracksByAlbum(albumTitle);
    // scope "curated": album e unidade coerente; shuffle embaralha so este.
    if (tracks.length) { setQueue(tracks, 0, "curated", { kind: "album", name: albumTitle }); playTrack(tracks[0]); }
  }

  /** Toca a descoberta e abre uma rodada de rádio nova semeada por ela:
      quando a faixa acaba (ou é pulada), o autoplay segue a partir dela. */
  function playDiscovery(t: Track) {
    resetRadioSession();
    setQueue([t], 0, "open", { kind: "radio" });
    playTrack(t);
  }

  // Card de retomada: posição arredondada ao segundo (o store atualiza
  // várias vezes por segundo; o texto só muda quando o segundo muda).
  const posSec = createMemo(() => Math.floor(player.positionSecs));
  const resumeSub = () => {
    const dur = player.durationSecs ? fmtDur(player.durationSecs * 1000) : "—";
    const pos = fmtDur(posSec() * 1000);
    return player.isPlaying ? `${pos} de ${dur}` : `parou em ${pos} de ${dur}`;
  };

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
              <Show when={d().albumsTotal != null}>
                <span><b>{d().albumsTotal!.toLocaleString()}</b> albums</span>
              </Show>
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
                      {player.currentTrack
                        ? (player.isPlaying ? "Tocando agora" : "Continuar de onde parou")
                        : "Quick start"}
                    </div>
                    <h2 class="hero-tile__title">
                      {player.currentTrack
                        ? `${player.currentTrack.title} · ${player.currentTrack.artist_name ?? ""}`
                        : "Shuffle all"}
                    </h2>
                    <div class="hero-tile__sub">
                      {player.currentTrack ? resumeSub() : faixas(d().snap.tracks_total)}
                    </div>
                    <span class="hero-tile__cta"><Icon name={ICONS.play} size={12} /></span>
                  </button>

                  <button class="hero-tile" onClick={shuffleAll}>
                    <div class="hero-tile__eyebrow">Quick start</div>
                    <h2 class="hero-tile__title">Shuffle all</h2>
                    <div class="hero-tile__sub">{faixas(d().snap.tracks_total)}</div>
                    <span class="hero-tile__cta"><Icon name={ICONS.play} size={12} /></span>
                  </button>

                  <Show
                    when={pickDiscovery(d().recs)}
                    fallback={
                      <Show
                        when={d().albums[0]}
                        fallback={
                          <button class="hero-tile" onClick={shuffleAll}>
                            <div class="hero-tile__eyebrow">Discover</div>
                            <h2 class="hero-tile__title">Surprise me</h2>
                            <div class="hero-tile__sub">{faixas(d().snap.tracks_total)}</div>
                            <span class="hero-tile__cta"><Icon name={ICONS.play} size={12} /></span>
                          </button>
                        }
                      >
                        {(top) => (
                          <button class="hero-tile" onClick={() => playAlbum(top().title)}>
                            <div class="hero-tile__eyebrow">From your library</div>
                            <h2 class="hero-tile__title">{top().title}</h2>
                            <div class="hero-tile__sub">
                              {top().artist_name ?? "—"} · {faixas(top().track_count)}
                            </div>
                            <span class="hero-tile__cta"><Icon name={ICONS.play} size={12} /></span>
                          </button>
                        )}
                      </Show>
                    }
                  >
                    {(pick) => (
                      <button
                        class="hero-tile hero-tile--discovery"
                        classList={{ "hero-tile--has-cover": !!coverUrl(pick().track.album_cover_path) }}
                        onClick={() => playDiscovery(pick().track)}
                        aria-label={`Tocar ${pick().track.title} e seguir em rádio`}
                      >
                        <Show when={coverUrl(pick().track.album_cover_path)}>
                          {(url) => (
                            <div
                              class="hero-tile__bg"
                              style={{ "background-image": `url(${url()})` }}
                              aria-hidden="true"
                            />
                          )}
                        </Show>
                        <div class="hero-tile__eyebrow">Para descobrir</div>
                        <h2 class="hero-tile__title">{pick().track.title}</h2>
                        <div class="hero-tile__sub hero-tile__sub--reason">
                          {pick().track.artist_name ?? "—"} · {pick().reason}
                        </div>
                        <span class="hero-tile__cta"><Icon name={ICONS.play} size={12} /></span>
                      </button>
                    )}
                  </Show>
                </div>
              </section>

              {/* Recently played */}
              <Show when={d().recent.length > 0}>
                <section class="row-list">
                  <div class="section__head">
                    <h2 class="section__title">Recently played</h2>
                    <a class="section__action" href="#/history">View history →</a>
                  </div>
                  <div class="row-list__rows">
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
                    {/* Ordem alfabetica (os 12 primeiros do acervo): nada de
                        "favoritos" enquanto a selecao nao usar sinal de gosto. */}
                    <h2 class="section__title">Albums</h2>
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
                            <button class="card__play" type="button" aria-label={`Tocar ${a.title}`} onClick={(e) => { e.stopPropagation(); playAlbum(a.title); }}><Icon name={ICONS.play} size={12} /></button>
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
