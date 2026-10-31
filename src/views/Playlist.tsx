/* ============================================================
   views/Playlist.tsx — Pagina de uma playlist (folder) especifica.
   Param via route('/playlist/:name'). Cabeçalho = o LibHero comum a
   Álbum, Artista e Playlist (B2), com o mosaico de capas
   (lib/mosaic.ts) e os botões Fixar / Tocar; tracklist com cover por
   linha (.tracks--with-cover). Ellipsis em title/cell pra texto longo
   nao vazar.
   ============================================================ */

import { createMemo, createResource, For, Show, Switch, Match } from "solid-js";
import {
  libListFolderTracks,
  libListFolders,
  coverUrl,
  type FolderPlaylist,
  type Track,
} from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { isPinned, togglePin, pins } from "../store/pins";
import { navigate, route } from "../router";
import { Icon, ICONS } from "../components/Icon";
import { TrackRowTable } from "../components/TrackRowTable";
import { libraryRevision } from "../store/moveDialog";
import { EmptyState } from "../components/EmptyState";
import { dataOf, listState, peek, settle } from "../lib/loaded";
import { mosaicCells } from "../lib/mosaic";
import { plural, totalDur } from "../lib/count";
import { LibHero } from "../components/LibHero";

export default function PlaylistView() {
  const name = () => (route().param ? decodeURIComponent(route().param!) : null);

  // libraryRevision na chave: recarrega depois de "Mover para playlist…".
  const [tracksRes, { refetch }] = createResource(
    () => ({ n: name(), rev: libraryRevision() }),
    ({ n }) => settle(n ? libListFolderTracks(n) : Promise.resolve([] as Track[])),
  );
  const tracks = () => dataOf(peek(tracksRes));
  const state = () => listState(peek(tracksRes));

  const [folderRes] = createResource(() => ({ n: name(), rev: libraryRevision() }), async ({ n }): Promise<FolderPlaylist | null> => {
    if (!n) return null;
    try {
      const list = await libListFolders();
      return list.find((f) => f.name === n) ?? null;
    } catch { return null; }
  });
  const folder = () => peek(folderRes) ?? null;

  // Mosaico de capas distintas, mesma regra do card da listagem (A42):
  // uma capa ocupa o quadro; duas ou três repetem; sem capa, o disco.
  const heroCovers = createMemo(() => mosaicCells(folder()?.cover_paths ?? []));

  // scope "curated": shuffle dentro da playlist embaralha SO esta lista
  // (em vez de virar radio mode baseado em recommendations da track atual).
  function play(t: Track) {
    const all = tracks();
    const idx = all.indexOf(t);
    setQueue(all, idx >= 0 ? idx : 0, "curated", { kind: "playlist", name: name() ?? undefined });
    playTrack(t);
  }

  function playAll() {
    const all = tracks();
    if (all.length) {
      setQueue(all, 0, "curated", { kind: "playlist", name: name() ?? undefined });
      playTrack(all[0]);
    }
  }

  const pinned = createMemo(() => {
    const n = name();
    return n ? pins().includes(n) : false;
  });

  const totalDuration = createMemo(() =>
    tracks().reduce((sum, t) => sum + (t.duration_ms || 0), 0),
  );

  return (
    <article class="view">
      <LibHero
        kicker="Playlist"
        title={name() ?? "Playlist"}
        cover={
          <Show
            when={heroCovers().length > 0}
            fallback={
              <div class="pl-hero-cover__empty" aria-hidden="true">
                <Icon name={ICONS.albums} size={44} />
              </div>
            }
          >
            <div class="pl-hero-cover" aria-hidden="true">
              <For each={heroCovers()}>
                {(src) => (
                  <div class="pl-hero-cover__quad" classList={{ "pl-hero-cover__quad--full": heroCovers().length === 1 }}>
                    <img src={coverUrl(src)} alt="" loading="lazy" />
                  </div>
                )}
              </For>
            </div>
          </Show>
        }
        stats={
          <>
            <b>{plural(tracks().length, "faixa", "faixas")}</b>
            <Show when={tracks().length > 0}>
              <span class="lib-hero__sep">·</span>
              {totalDur(totalDuration())}
            </Show>
          </>
        }
        actions={
          <>
            <button
              class="pl-action-btn"
              classList={{ "is-on": pinned() }}
              type="button"
              aria-pressed={pinned()}
              onClick={() => { const n = name(); if (n) togglePin(n); }}
              title={pinned() ? "Tirar dos fixados" : "Fixar no topo das playlists"}
            >
              <Icon name={pinned() ? "lucide:pin-off" : "lucide:pin"} size={13} />
              <span>{pinned() ? "Fixada" : "Fixar"}</span>
            </button>
            <button class="pl-action-btn pl-action-btn--primary" type="button" onClick={playAll} disabled={!tracks().length}>
              <Icon name={ICONS.play} size={13} />
              <span>Tocar</span>
            </button>
          </>
        }
      />

      <div class="view__body">
        <Switch>
          <Match when={state() === "carregando"}>
            <EmptyState tone="carregando" title="Carregando a playlist…" />
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
              icon={ICONS.playlists}
              title="Esta playlist está vazia."
              text="A pasta existe em ~/Music, mas não tem faixa indexada. Mova faixas para cá pelo menu de contexto (Mover para playlist…)."
              actions={[{ label: "Ver as playlists", onClick: () => navigate("/playlists") }]}
            />
          </Match>
          <Match when={state() === "pronto"}>
            <Show when={tracksRes.state === "refreshing"}>
              <p class="lib-busy" role="status">Atualizando…</p>
            </Show>
            {/* Sem a coluna Playlist: seria esta mesma em toda linha (A21). */}
            <div class="tracks tracks--with-cover" role="grid" aria-rowcount={tracks().length + 1}>
              <div class="tracks__head tracks__idx" role="columnheader">#</div>
              <div class="tracks__head" role="columnheader" aria-label="Capa" />
              <div class="tracks__head" role="columnheader">Título</div>
              <div class="tracks__head" role="columnheader">Álbum</div>
              <div class="tracks__head tracks__mono" role="columnheader">Duração</div>
              <For each={tracks()}>
                {(t, i) => (
                  <TrackRowTable
                    track={t}
                    index={i() + 1}
                    columns={["album"]}
                    onClick={() => play(t)}
                    contextList={tracks()}
                    coverSlot={
                      <div class="tracks__cover" role="gridcell">
                        <Show
                          when={t.album_cover_path}
                          fallback={
                            <div class="tracks__cover-fallback">
                              {/* @ts-ignore */}
                              <iconify-icon icon="lucide:disc-3" noobserver style={{ "font-size": "14px" }} />
                            </div>
                          }
                        >
                          <img src={coverUrl(t.album_cover_path!)} alt="" loading="lazy" />
                        </Show>
                      </div>
                    }
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
