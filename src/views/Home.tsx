/* ============================================================
   views/Home.tsx — Hero + chegadas + escuta + álbuns.
   Pulls from libSnapshot/libListHistory/libRecommendations.

   A Home reflete a escuta e as chegadas (B12, varredura de 31/10). Ela já
   buscava as recomendações e usava uma (a descoberta do hero); agora:
   - "Mais tocadas" (`most_played`) e "Para descobrir" (o resto de
     `discover`) em linhas;
   - a prateleira de álbuns puxa os álbuns do que tocou por último e das
     mais tocadas antes do acervo alfabético (lib/homeShelves.ts);
   - o aviso de chegadas do Crate (Soulseek, SoundCloud e Tidal), o mesmo
     contador da barra lateral, que zera ao abrir o Crate.
   Card de álbum ABRE o álbum (B1/A19, como em Álbuns); só o play do hover
   toca, por título e artista.

   Cada leitura passa por `settle`: uma falha do índice esconde a seção e
   avisa no topo, em vez de derrubar a Home ou travar no carregando (A7).
   ============================================================ */

import { createMemo, createResource, createSignal, For, onCleanup, Show } from "solid-js";
import {
  libSnapshot, libListHistory, libGetAlbums, libRecommendations, libListArrivals, coverUrl,
  type Track, type Recommendations,
} from "../tauri";
import { setQueue, player } from "../store/player";
import { resetRadioSession } from "../store/radioSession";
import { newArrivals } from "../store/crate";
import { playTrack } from "../components/PlayerBar";
import { navigate } from "../router";
import { Icon, ICONS } from "../components/Icon";
import { CoverArt } from "../components/CoverArt";
import { TrackRowList } from "../components/TrackRowList";
import { EmptyState } from "../components/EmptyState";
import { fmtDur, relTime } from "../lib/format";
import { shuffleAll } from "../lib/quickPlay";
import { peek, settle } from "../lib/loaded";
import { plural } from "../lib/count";
import { albumHref } from "../lib/albumRoute";
import { listenedAlbums } from "../lib/homeShelves";
import { arrivalsCutoff, countUnseen, isUnseen, loadArrivalsSeen, saveArrivalsSeen } from "../lib/arrivals";
import { truncTipEvent } from "../lib/truncTip";
import { playAlbum } from "./Albums";

const EMPTY_RECS: Recommendations = { most_played: [], based_on_top: [], discover: [] };
/** Linhas por prateleira de faixas. */
const SHELF_ROWS = 6;
/** "Chegou esta semana": linhas antes do "Mostrar todas" e teto do pedido. */
const ARRIVALS_ROWS = 8;
const ARRIVALS_MAX = 200;

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
  const [res, { refetch }] = createResource(async () => {
    const [snap, recent, albums, recs, arrivals] = await Promise.all([
      settle(libSnapshot()),
      settle(libListHistory(8)),
      // Lista completa: o backend agrupa o acervo inteiro de qualquer forma
      // (o limit so trunca a resposta), e o total real sai dela — o snapshot
      // nao tem albums_total.
      settle(libGetAlbums({ limit: null })),
      settle(libRecommendations()),
      // B12: o que o ingest gravou na última semana, por qualquer porta.
      settle(libListArrivals(arrivalsCutoff(), ARRIVALS_MAX)),
    ]);
    return { snap, recent, albums, recs, arrivals };
  });
  const data = () => peek(res);
  const snap = () => { const s = data()?.snap; return s?.ok ? s.data : null; };
  const recent = (): Track[] => { const r = data()?.recent; return r?.ok ? r.data : []; };
  const recs = (): Recommendations => { const r = data()?.recs; return r?.ok ? r.data : EMPTY_RECS; };
  const albumsAll = () => { const a = data()?.albums; return a?.ok ? a.data : null; };
  const failed = () => {
    const d = data();
    return !!d && (!d.snap.ok || !d.recent.ok || !d.albums.ok || !d.recs.ok || !d.arrivals.ok);
  };

  // "Chegou esta semana" (B12): a marca de nova vale contra a visita anterior
  // durante toda esta visita; sair da Home (ou "Marcar como vistas") grava a
  // chegada mais nova mostrada, então o que entrar depois continua novo.
  const arrivals = (): Track[] => { const a = data()?.arrivals; return a?.ok ? a.data : []; };
  const [seenAt, setSeenAt] = createSignal(loadArrivalsSeen());
  const [allArrivals, setAllArrivals] = createSignal(false);
  const newestArrival = () => arrivals().reduce((m, t) => Math.max(m, t.indexed_at ?? 0), 0);
  const unseenArrivals = createMemo(() => countUnseen(arrivals(), seenAt()));
  const shownArrivals = createMemo(() => (allArrivals() ? arrivals() : arrivals().slice(0, ARRIVALS_ROWS)));
  function markArrivalsSeen() {
    const at = newestArrival();
    if (!at) return;
    saveArrivalsSeen(at);
    setSeenAt((s) => Math.max(s ?? 0, at));
  }
  onCleanup(() => { const at = newestArrival(); if (at) saveArrivalsSeen(at); });
  const arrivalWhen = (t: Track) => (isUnseen(t, seenAt()) ? `nova · ${relTime(t.indexed_at)}` : relTime(t.indexed_at));

  const mostPlayed = createMemo(() => recs().most_played.slice(0, SHELF_ROWS));
  // A primeira descoberta já está no hero; a prateleira mostra as outras.
  const discoveries = createMemo(() => {
    const pick = pickDiscovery(recs());
    return recs().discover.filter((t) => t.id !== pick?.track.id).slice(0, SHELF_ROWS);
  });
  const shelfAlbums = createMemo(() => listenedAlbums(albumsAll() ?? [], recent(), recs().most_played, 12));
  const libraryCount = () => (snap() ? faixas(snap()!.tracks_total) : "Todo o acervo");

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
          <h1>Início</h1>
          <p class="view__head-hint">Seu acervo, tocado localmente</p>
        </div>
        <Show when={snap()}>
          {(s) => (
            <div class="view__stats">
              <span><b>{s().tracks_total.toLocaleString("pt-BR")}</b> {s().tracks_total === 1 ? "faixa" : "faixas"}</span>
              <Show when={albumsAll()}>
                {(a) => <span><b>{a().length.toLocaleString("pt-BR")}</b> {a().length === 1 ? "álbum" : "álbuns"}</span>}
              </Show>
              <span title="Vetor = o que o rádio usa para achar faixas parecidas"><b>{s().embeddings_done.toLocaleString("pt-BR")}</b> com vetor</span>
            </div>
          )}
        </Show>
      </header>

      <div class="view__body">
        <Show when={data()} fallback={<EmptyState tone="carregando" title="Carregando o acervo…" />}>
          <>
            <Show when={failed()}>
              <EmptyState
                compact
                tone="erro"
                title="Parte da Home não carregou."
                text="O índice não respondeu a tempo. O acervo continua no disco."
                actions={[{ label: "Tentar de novo", onClick: () => void refetch(), icon: ICONS.refresh }]}
              />
            </Show>

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
                      : "Início rápido"}
                  </div>
                  <h2 class="hero-tile__title">
                    {player.currentTrack
                      ? `${player.currentTrack.title} · ${player.currentTrack.artist_name ?? ""}`
                      : "Tocar tudo em aleatório"}
                  </h2>
                  <div class="hero-tile__sub">
                    {player.currentTrack ? resumeSub() : libraryCount()}
                  </div>
                  <span class="hero-tile__cta"><Icon name={ICONS.play} size={12} /></span>
                </button>

                <button class="hero-tile" onClick={shuffleAll}>
                  <div class="hero-tile__eyebrow">Início rápido</div>
                  <h2 class="hero-tile__title">Tocar tudo em aleatório</h2>
                  <div class="hero-tile__sub">{libraryCount()}</div>
                  <span class="hero-tile__cta"><Icon name={ICONS.play} size={12} /></span>
                </button>

                <Show
                  when={pickDiscovery(recs())}
                  fallback={
                    <Show
                      when={shelfAlbums()[0]}
                      fallback={
                        <button class="hero-tile" onClick={shuffleAll}>
                          <div class="hero-tile__eyebrow">Descoberta</div>
                          <h2 class="hero-tile__title">Me surpreenda</h2>
                          <div class="hero-tile__sub">{libraryCount()}</div>
                          <span class="hero-tile__cta"><Icon name={ICONS.play} size={12} /></span>
                        </button>
                      }
                    >
                      {(top) => (
                        <button class="hero-tile" onClick={() => void playAlbum(top())}>
                          <div class="hero-tile__eyebrow">Do seu acervo</div>
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

            {/* Chegou esta semana (B12): toda porta de entrada, pelo indexed_at. */}
            <Show when={arrivals().length > 0}>
              <section class="row-list home-shelf" aria-label="Chegou esta semana">
                <div class="section__head">
                  <h2 class="section__title">Chegou esta semana</h2>
                  <span class="section__hint home-shelf__count">
                    {plural(arrivals().length, "faixa", "faixas")}
                    <Show when={unseenArrivals() > 0}>{` · ${plural(unseenArrivals(), "nova", "novas")}`}</Show>
                  </span>
                  <Show when={unseenArrivals() > 0}>
                    <button type="button" class="section__action home-shelf__act" onClick={markArrivalsSeen}>
                      Marcar como vistas
                    </button>
                  </Show>
                </div>
                <div class="row-list__rows">
                  <For each={shownArrivals()}>
                    {(t) => (
                      <TrackRowList
                        track={t}
                        onClick={() => playRow(t, arrivals())}
                        whenText={arrivalWhen(t)}
                        contextList={shownArrivals()}
                      />
                    )}
                  </For>
                </div>
                <Show when={!allArrivals() && arrivals().length > ARRIVALS_ROWS}>
                  <button type="button" class="home-shelf__more" onClick={() => setAllArrivals(true)}>
                    Mostrar todas <span class="home-shelf__more-n">{arrivals().length}</span>
                  </button>
                </Show>
              </section>
            </Show>

            {/* Chegadas do Crate: o mesmo contador da barra lateral. Com a
                prateleira acima já mostrando o que entrou, o aviso sairia
                repetido; fica só para quando ela está vazia. */}
            <Show when={newArrivals() > 0 && arrivals().length === 0}>
              <button type="button" class="home-arrivals" onClick={() => navigate("/crate")}>
                <Icon name={ICONS.download} size={16} class="home-arrivals__icon" />
                <span class="home-arrivals__text">
                  <b>{plural(newArrivals(), "faixa nova chegou", "faixas novas chegaram")}</b> ao acervo
                </span>
                <span class="home-arrivals__go">Ver no Crate</span>
                <Icon name={ICONS.chevronRight} size={14} />
              </button>
            </Show>

            {/* Tocadas recentemente */}
            <Show when={recent().length > 0}>
              <section class="row-list">
                <div class="section__head">
                  <h2 class="section__title">Tocadas recentemente</h2>
                  <a class="section__action" href="#/history">Ver histórico</a>
                </div>
                <div class="row-list__rows">
                  <For each={recent()}>
                    {(t) => (
                      <TrackRowList
                        track={t}
                        onClick={() => playRow(t, recent())}
                        whenText={relTime(t.last_played)}
                        contextList={recent()}
                      />
                    )}
                  </For>
                </div>
              </section>
            </Show>

            {/* Mais tocadas */}
            <Show when={mostPlayed().length > 0}>
              <section class="row-list home-shelf" aria-label="Mais tocadas">
                <div class="section__head">
                  <h2 class="section__title">Mais tocadas</h2>
                </div>
                <div class="row-list__rows">
                  <For each={mostPlayed()}>
                    {(t) => (
                      <TrackRowList
                        track={t}
                        onClick={() => playRow(t, mostPlayed())}
                        whenText={plural(t.play_count ?? 0, "vez", "vezes")}
                        contextList={mostPlayed()}
                      />
                    )}
                  </For>
                </div>
              </section>
            </Show>

            {/* Para descobrir: cada uma abre uma rodada de rádio nova. */}
            <Show when={discoveries().length > 0}>
              <section class="row-list home-shelf" aria-label="Para descobrir">
                <div class="section__head">
                  <h2 class="section__title">Para descobrir</h2>
                  <span class="section__hint">nunca tocadas, perto do que você curte</span>
                </div>
                <div class="row-list__rows">
                  <For each={discoveries()}>
                    {(t) => (
                      <TrackRowList
                        track={t}
                        onClick={() => playDiscovery(t)}
                        contextList={discoveries()}
                      />
                    )}
                  </For>
                </div>
              </section>
            </Show>

            {/* Álbuns: os do que tocou por último e das mais tocadas, depois o
                acervo (lib/homeShelves.ts). O card abre; o play do hover toca. */}
            <Show when={shelfAlbums().length > 0}>
              <section>
                <div class="section__head">
                  <h2 class="section__title">Álbuns</h2>
                  <a class="section__action" href="#/albums">Ver todos</a>
                </div>
                <div class="card-grid">
                  <For each={shelfAlbums()}>
                    {(a) => (
                      <div class="card" onPointerEnter={truncTipEvent}>
                        <CoverArt
                          seed={a.title}
                          src={coverUrl(a.cover_path)}
                          size="md"
                          class="card__cover"
                        >
                          <button class="card__play" type="button" aria-label={`Tocar ${a.title}`} onClick={(e) => { e.stopPropagation(); void playAlbum(a); }}><Icon name={ICONS.play} size={12} /></button>
                        </CoverArt>
                        <button
                          type="button"
                          class="card__title card__open"
                          data-trunc
                          onClick={() => navigate(albumHref(a.title, a.artist_name))}
                          onFocus={truncTipEvent}
                        >
                          {a.title}
                        </button>
                        <div class="card__sub" data-trunc>{a.artist_name ?? "—"}</div>
                        <div class="card__meta">{plural(a.track_count, "faixa", "faixas")}{a.year ? ` · ${a.year}` : ""}</div>
                      </div>
                    )}
                  </For>
                </div>
              </section>
            </Show>
          </>
        </Show>
      </div>
    </article>
  );
}
