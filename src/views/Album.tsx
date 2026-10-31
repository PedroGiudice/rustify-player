/* ============================================================
   views/Album.tsx — Página de um álbum.
   Rota /album/<título>?artista=<artista> (lib/albumRoute.ts): o álbum é
   título + artista, como em list_albums. Rota antiga, só com o título,
   abre o primeiro álbum com esse nome.
   Cabeçalho: o LibHero comum a Álbum, Artista e Playlist (B2); o nome do
   artista nos números abre a página dele.
   ============================================================ */

import { createResource, For, Show, Switch, Match } from "solid-js";
import { libGetTracks, libGetAlbums, coverUrl, type Album, type Track } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { navigate, route } from "../router";
import { CoverArt } from "../components/CoverArt";
import { Icon, ICONS } from "../components/Icon";
import { TrackRowTable } from "../components/TrackRowTable";
import { EmptyState } from "../components/EmptyState";
import { libraryRevision, openMoveDialog } from "../store/moveDialog";
import { dataOf, listState, peek, settle } from "../lib/loaded";
import { ALBUM_TRACK_LIMIT, parseAlbumParam } from "../lib/albumRoute";
import { plural, totalDur } from "../lib/count";
import { LibHero } from "../components/LibHero";
import { ListenFacts } from "../components/ListenFacts";

export default function AlbumView() {
  const parsed = () => parseAlbumParam(route().param);
  const title = () => parsed().title;

  const [albumRes] = createResource(
    () => ({ t: title(), artist: parsed().artist }),
    async ({ t, artist }): Promise<Album | null> => {
      if (!t) return null;
      try {
        const list = await libGetAlbums({ limit: null });
        return list.find((a) => a.title === t && (!artist || a.artist_name === artist))
          ?? list.find((a) => a.title === t)
          ?? null;
      } catch { return null; }
    },
  );
  const album = () => peek(albumRes) ?? null;

  // Filtra pelo artista do álbum além do título: dois álbuns homônimos
  // ("Greatest Hits") não se misturam — e "Mover para playlist…" não leva
  // faixa de outro artista. O artista da rota vale desde o primeiro
  // quadro; sem ele, espera o álbum resolver. libraryRevision na chave:
  // recarrega depois de mover.
  const [tracksRes, { refetch }] = createResource(
    () => {
      const routeArtist = parsed().artist;
      if (!routeArtist && albumRes.loading) return false;
      return { t: title(), artist: routeArtist ?? album()?.artist_name ?? undefined, rev: libraryRevision() };
    },
    ({ t, artist }) => settle(t ? libGetTracks({ album: t, artist, limit: ALBUM_TRACK_LIMIT }) : Promise.resolve([] as Track[])),
  );
  const tracks = () => dataOf(peek(tracksRes));
  const state = () => listState(peek(tracksRes));
  const truncated = () => tracks().length >= ALBUM_TRACK_LIMIT;
  const artistName = () => parsed().artist ?? album()?.artist_name ?? null;
  const totalMs = () => tracks().reduce((sum, t) => sum + (t.duration_ms || 0), 0);

  // scope "curated": shuffle dentro do album embaralha SO este tracklist.
  function play(t: Track) {
    const all = tracks();
    const idx = all.indexOf(t);
    setQueue(all, idx >= 0 ? idx : 0, "curated", { kind: "album", name: title() ?? undefined });
    playTrack(t);
  }

  function playAll() {
    const all = tracks();
    if (all.length) { setQueue(all, 0, "curated", { kind: "album", name: title() ?? undefined }); playTrack(all[0]); }
  }

  return (
    <article class="view">
      <LibHero
        kicker={album()?.year ? `Álbum · ${album()!.year}` : "Álbum"}
        title={title() ?? "Álbum"}
        cover={<CoverArt seed={title()} src={coverUrl(album()?.cover_path ?? null)} size="lg" class="lib-hero__art" />}
        facts={
          // Sem artista na rota, espera o álbum resolver: só o título misturaria homônimos.
          <ListenFacts query={title() && (artistName() || !albumRes.loading) ? { artist: artistName(), album: title() } : null} />
        }
        stats={
          <>
            <Show when={artistName()} fallback={<span>—</span>}>
              {(n) => (
                <button type="button" class="lib-hero__link" onClick={() => navigate(`/artist/${encodeURIComponent(n())}`)}>
                  {n()}
                </button>
              )}
            </Show>
            <span class="lib-hero__sep">·</span>
            <b>{plural(tracks().length, "faixa", "faixas")}</b>
            <Show when={tracks().length > 0}>
              <span class="lib-hero__sep">·</span>
              {totalDur(totalMs())}
            </Show>
            <Show when={truncated()}>
              <span class="lib-hero__sep">·</span>
              mostrando só as primeiras {ALBUM_TRACK_LIMIT}
            </Show>
          </>
        }
        actions={
          <>
            <button
              class="pl-action-btn"
              type="button"
              disabled={!tracks().length}
              onClick={() => openMoveDialog(tracks(), title())}
              title={truncated()
                ? `Move só as ${ALBUM_TRACK_LIMIT} faixas listadas; o álbum tem mais`
                : "Mover o álbum para outra playlist"}
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
            <EmptyState tone="carregando" title="Carregando o álbum…" />
          </Match>
          <Match when={state() === "erro"}>
            <EmptyState
              tone="erro"
              title="Não consegui ler o acervo agora."
              text="O índice não respondeu. As faixas continuam no disco."
              actions={[{ label: "Tentar de novo", onClick: () => void refetch(), icon: ICONS.refresh }]}
            />
          </Match>
          <Match when={state() === "vazio"}>
            <EmptyState
              icon={ICONS.albums}
              title="Este álbum não tem faixas no acervo."
              text="Ele pode ter sido movido, retagueado ou apagado do disco."
              actions={[{ label: "Ver todos os álbuns", onClick: () => navigate("/albums") }]}
            />
          </Match>
          <Match when={state() === "pronto"}>
            <Show when={tracksRes.state === "refreshing"}>
              <p class="lib-busy" role="status">Atualizando…</p>
            </Show>
            {/* Sem as colunas Álbum e Playlist: repetiriam o mesmo valor em toda linha (A20). */}
            <div class="tracks tracks--album" role="grid" aria-rowcount={tracks().length + 1}>
              <div class="tracks__head tracks__idx" role="columnheader">#</div>
              <div class="tracks__head" role="columnheader">Título</div>
              <div class="tracks__head tracks__mono" role="columnheader">Duração</div>
              <For each={tracks()}>
                {(t, i) => (
                  <TrackRowTable
                    track={t}
                    index={t.track_number ?? i() + 1}
                    columns={[]}
                    onClick={() => play(t)}
                    contextList={tracks()}
                  />
                )}
              </For>
            </div>
          </Match>
        </Switch>
      </div>
    </article>
  );
}
