/* ============================================================
   views/Artist.tsx — Página de um artista: álbuns e faixas sem álbum.

   - Os cards de álbum abrem pelo teclado (A18) e levam o artista na rota
     (A19: dois álbuns homônimos não se misturam).
   - Faixa sem tag de álbum não entra em list_albums (query.rs): ela ganha
     a seção "Faixas sem álbum", e o "Mover" e o "Tocar" contam com ela.
     Antes um artista só de faixas soltas abria vazio, com o Mover apagado.
   - "Tocar" no cabeçalho (A20): os álbuns em ordem, as soltas no fim.
   - Cabeçalho: o LibHero comum (B2), capa redonda com o rosto do artista.
   ============================================================ */

import { createMemo, createResource, For, Show, Switch, Match } from "solid-js";
import { libGetAlbumsByArtist, libGetTracks, libGetTracksByArtist, coverUrl, type Album, type Track } from "../tauri";
import { libraryRevision, openMoveDialog } from "../store/moveDialog";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { navigate, route } from "../router";
import { CoverArt } from "../components/CoverArt";
import { Icon, ICONS } from "../components/Icon";
import { TrackRowTable } from "../components/TrackRowTable";
import { EmptyState } from "../components/EmptyState";
import { dataOf, peek, settle } from "../lib/loaded";
import { ALBUM_TRACK_LIMIT, albumHref } from "../lib/albumRoute";
import { truncTipEvent } from "../lib/truncTip";
import { plural, totalDur } from "../lib/count";
import { LibHero } from "../components/LibHero";

/** Teto das faixas do artista (cobre discografia inteira). */
const ARTIST_TRACK_LIMIT = 5000;

export default function ArtistView() {
  const name = () => route().param ? decodeURIComponent(route().param!) : null;

  // Filtro no backend (mesma igualdade exata do filtro antigo no cliente),
  // sem corte: baixar 500 alfabeticos e filtrar perdia os albuns do fim.
  // libraryRevision na chave: recarrega depois de mover.
  const [albumsRes, { refetch: refetchAlbums }] = createResource(
    () => ({ n: name(), rev: libraryRevision() }),
    ({ n }) => settle(n ? libGetAlbumsByArtist(n, null) : Promise.resolve([] as Album[])),
  );
  const [tracksRes, { refetch: refetchTracks }] = createResource(
    () => ({ n: name(), rev: libraryRevision() }),
    ({ n }) => settle(n ? libGetTracksByArtist(n, ARTIST_TRACK_LIMIT) : Promise.resolve([] as Track[])),
  );
  const albums = () => dataOf(peek(albumsRes));
  // O backend ordena por álbum, disco e faixa, com as sem álbum primeiro:
  // para tocar, os álbuns vêm antes e as soltas fecham a fila.
  const tracks = createMemo(() => {
    const all = dataOf(peek(tracksRes));
    const withAlbum = all.filter((t) => t.album_title);
    return withAlbum.length === all.length ? all : [...withAlbum, ...all.filter((t) => !t.album_title)];
  });
  const loose = createMemo(() => tracks().filter((t) => !t.album_title));
  const totalMs = () => tracks().reduce((sum, t) => sum + (t.duration_ms || 0), 0);
  // Rosto do artista: a capa do álbum dele com mais faixas (a mesma regra
  // do list_artists no backend, B3); sem álbum com capa, a de uma solta.
  const heroCover = createMemo(() => {
    const best = albums()
      .filter((a) => a.cover_path)
      .reduce<Album | null>((b, a) => (!b || a.track_count > b.track_count ? a : b), null);
    return best?.cover_path ?? loose().find((t) => t.album_cover_path)?.album_cover_path ?? null;
  });

  const state = () => {
    const a = peek(albumsRes), t = peek(tracksRes);
    if (a === undefined || t === undefined) return "carregando";
    if (!a.ok || !t.ok) return "erro";
    return a.data.length === 0 && t.data.length === 0 ? "vazio" : "pronto";
  };
  const retry = () => { void refetchAlbums(); void refetchTracks(); };

  function playFrom(list: Track[], t: Track, name: string | undefined) {
    const idx = list.indexOf(t);
    setQueue(list, idx >= 0 ? idx : 0, "curated", { kind: "album", name });
    playTrack(t);
  }

  function playAll() {
    const all = tracks();
    if (!all.length) return;
    // scope "curated": a discografia do artista é uma unidade coerente.
    setQueue(all, 0, "curated", { kind: "album", name: name() ?? undefined });
    playTrack(all[0]);
  }

  async function playAlbum(a: Album) {
    const list = await libGetTracks({ album: a.title, artist: name() ?? undefined, limit: ALBUM_TRACK_LIMIT });
    // scope "curated": album e uma unidade coerente do artista.
    if (list.length) { setQueue(list, 0, "curated", { kind: "album", name: a.title }); playTrack(list[0]); }
  }

  return (
    <article class="view">
      <LibHero
        kicker="Artista"
        title={name() ?? "Artista"}
        round
        cover={<CoverArt seed={name() ?? "x"} src={coverUrl(heroCover())} size="lg" class="lib-hero__art" />}
        stats={
          <>
            <b>{plural(albums().length, "álbum", "álbuns")}</b>
            <span class="lib-hero__sep">·</span>
            {plural(tracks().length, "faixa", "faixas")}
            <Show when={tracks().length > 0}>
              <span class="lib-hero__sep">·</span>
              {totalDur(totalMs())}
            </Show>
          </>
        }
        actions={
          <>
            <button
              class="pl-action-btn"
              type="button"
              disabled={!tracks().length}
              onClick={() => openMoveDialog(tracks(), name())}
              title="Mover todas as faixas do artista para outra playlist"
            >
              <Icon name={ICONS.moveTo} size={13} />
              <span>Mover para playlist…</span>
            </button>
            <button
              class="pl-action-btn pl-action-btn--primary"
              type="button"
              disabled={!tracks().length}
              onClick={playAll}
            >
              <Icon name={ICONS.play} size={13} />
              <span>Tocar</span>
            </button>
          </>
        }
      />

      <div class="view__body">
        <Switch>
          <Match when={state() === "carregando"}>
            <EmptyState tone="carregando" title="Carregando o artista…" />
          </Match>
          <Match when={state() === "erro"}>
            <EmptyState
              tone="erro"
              title="Não consegui ler o acervo agora."
              text="O índice não respondeu. As faixas continuam no disco."
              actions={[{ label: "Tentar de novo", onClick: retry, icon: ICONS.refresh }]}
            />
          </Match>
          <Match when={state() === "vazio"}>
            <EmptyState
              icon={ICONS.artists}
              title="Nenhuma faixa deste artista no acervo."
              text="O nome vem da tag de artista; se a faixa foi retagueada, ela está sob o nome novo."
              actions={[{ label: "Ver todos os artistas", onClick: () => navigate("/artists") }]}
            />
          </Match>
          <Match when={state() === "pronto"}>
            <Show when={albums().length > 0}>
              <section>
                <div class="section__head"><h2 class="section__title">Álbuns</h2></div>
                <div class="card-grid">
                  <For each={albums()}>
                    {(a) => (
                      <div class="card" onPointerEnter={truncTipEvent}>
                        <CoverArt
                          seed={a.title}
                          src={coverUrl(a.cover_path)}
                          size="md"
                          class="card__cover"
                        >
                          <button class="card__play" type="button" aria-label={`Tocar ${a.title}`} onClick={(e) => { e.stopPropagation(); void playAlbum(a); }}>
                            <Icon name={ICONS.play} size={12} />
                          </button>
                        </CoverArt>
                        <button
                          type="button"
                          class="card__title card__open"
                          data-trunc
                          onClick={() => navigate(albumHref(a.title, name()))}
                          onFocus={truncTipEvent}
                        >
                          {a.title}
                        </button>
                        <div class="card__sub">{plural(a.track_count, "faixa", "faixas")}{a.year ? ` · ${a.year}` : ""}</div>
                      </div>
                    )}
                  </For>
                </div>
              </section>
            </Show>
            <Show when={loose().length > 0}>
              <section>
                <div class="section__head"><h2 class="section__title">Faixas sem álbum</h2></div>
                <div class="tracks tracks--album" role="grid" aria-rowcount={loose().length + 1}>
                  <div class="tracks__head tracks__idx" role="columnheader">#</div>
                  <div class="tracks__head" role="columnheader">Título</div>
                  <div class="tracks__head tracks__mono" role="columnheader">Duração</div>
                  <For each={loose()}>
                    {(t, i) => (
                      <TrackRowTable
                        track={t}
                        index={i() + 1}
                        columns={[]}
                        onClick={() => playFrom(loose(), t, name() ?? undefined)}
                        contextList={loose()}
                      />
                    )}
                  </For>
                </div>
              </section>
            </Show>
          </Match>
        </Switch>
      </div>
    </article>
  );
}
