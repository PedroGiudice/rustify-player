/* ============================================================
   views/Albums.tsx — Grid of all albums, click to play.
   ============================================================ */

import { createResource, For, Show, type Accessor } from "solid-js";
import { libGetAlbums, libGetTracksByAlbum, coverUrl, type Album } from "../tauri";
import { setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { navigate, route } from "../router";
import { CoverArt } from "../components/CoverArt";
import { Icon, ICONS } from "../components/Icon";

/** `list`: listagem já buscada pela Library (que a usa na contagem da
    aba). Sem ela — rota /albums direta — a view busca a própria. */
export default function Albums(props: { param?: string; list?: Accessor<Album[] | undefined> }) {
  const albums: Accessor<Album[] | undefined> = props.list ?? createResource(async () => {
    try { return await libGetAlbums({ limit: null }); } catch { return [] as Album[]; }
  })[0];

  async function play(album: Album) {
    const tracks = await libGetTracksByAlbum(album.title);
    // scope "curated": album e uma unidade coerente — shuffle embaralha so este.
    if (tracks.length) { setQueue(tracks, 0, "curated", { kind: "album", name: album.title }); playTrack(tracks[0]); }
  }

  // Aberta direto (/albums) a view traz o proprio .view — o unico
  // container que rola (.main tem overflow:hidden). Como aba, a Library
  // ja fornece o dela.
  const standalone = () => route().path === "/albums";

  const body = () => (
    <div class="view__body">
      <div class="card-grid">
        <For each={albums() ?? []}>
          {(a) => (
            <div class="card" onClick={() => play(a)}>
              <CoverArt
                seed={a.title}
                src={coverUrl(a.cover_path)}
                size="md"
                class="card__cover"
              >
                <button class="card__play" type="button" aria-label={`Tocar ${a.title}`} onClick={(e) => { e.stopPropagation(); play(a); }}><Icon name={ICONS.play} size={12} /></button>
              </CoverArt>
              <div class="card__title">{a.title}</div>
              <div class="card__sub">{a.artist_name ?? "—"}</div>
              <div class="card__meta">{a.track_count} tracks{a.year ? ` · ${a.year}` : ""}</div>
            </div>
          )}
        </For>
      </div>
    </div>
  );

  return (
    <Show when={standalone()} fallback={body()}>
      <article class="view">
        <header class="view__head">
          <div><h1>Albums</h1></div>
        </header>
        {body()}
      </article>
    </Show>
  );
}
