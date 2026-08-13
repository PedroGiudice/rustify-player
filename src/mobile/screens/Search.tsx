/* ============================================================
   Search.tsx — porte de S.search do handoff.

   Busca CLIENT-SIDE: substring normalizada sobre título/artista/
   álbum do acervo que já está em memória (mesma escolha do
   desktop). Não existe busca semântica no v0 — o chip "Lyrics" do
   protótipo saiu por isso.

   "Recent searches" é estado local (localStorage), como no
   protótipo — só que de verdade.
   ============================================================ */

import { For, Show, createMemo, createSignal } from "solid-js";
import { Icon } from "../icons";
import { Cover } from "../components/Cover";
import { TrackRow } from "../components/TrackRow";
import { Empty, LazyList, SecHead, ViewHead } from "../components/ui";
import { navigate } from "../nav";
import { albums, artists, folders, playTrackFrom, tracks } from "../store";
import { normalize, searchTracks } from "../derive";

type Scope = "all" | "tracks" | "albums" | "artists" | "folders";
const SCOPES: Array<{ id: Scope; label: string }> = [
  { id: "all", label: "Tudo" },
  { id: "tracks", label: "Faixas" },
  { id: "albums", label: "Álbuns" },
  { id: "artists", label: "Artistas" },
  { id: "folders", label: "Pastas" },
];

const RECENT_KEY = "kv-mobile-recent-searches";

function loadRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((s) => typeof s === "string").slice(0, 5) : [];
  } catch {
    return [];
  }
}

export function Search() {
  const [q, setQ] = createSignal("");
  const [scope, setScope] = createSignal<Scope>("all");
  const [recent, setRecent] = createSignal(loadRecent());

  const remember = (term: string) => {
    const t = term.trim();
    if (t.length < 2) return;
    const list = [t, ...recent().filter((r) => r.toLowerCase() !== t.toLowerCase())].slice(0, 5);
    setRecent(list);
    try {
      localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch {
      /* sem persistência é degradação aceitável */
    }
  };

  const nq = createMemo(() => normalize(q()));
  const hits = createMemo(() => (nq() ? searchTracks(tracks(), q()) : []));
  const albumHits = createMemo(() =>
    nq() ? albums().filter((a) => normalize(a.title).includes(nq()) || normalize(a.artist).includes(nq())).slice(0, 30) : [],
  );
  const artistHits = createMemo(() =>
    nq() ? artists().filter((a) => normalize(a.name).includes(nq())).slice(0, 30) : [],
  );
  const folderHits = createMemo(() =>
    nq() ? folders().filter((f) => normalize(f.name).includes(nq())).slice(0, 30) : [],
  );

  const show = (s: Scope) => scope() === "all" || scope() === s;
  const nothing = () =>
    !!nq() &&
    (!show("tracks") || !hits().length) &&
    (!show("albums") || !albumHits().length) &&
    (!show("artists") || !artistHits().length) &&
    (!show("folders") || !folderHits().length);

  return (
    <div class="screen">
      <ViewHead title="Search" />

      <div class="searchfield">
        <Icon.search />
        <input
          value={q()}
          placeholder="Faixas, álbuns, artistas, pastas"
          autocomplete="off"
          autocapitalize="none"
          spellcheck={false}
          onInput={(e) => setQ(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              remember(q());
              e.currentTarget.blur();
            }
          }}
        />
      </div>

      <div class="chiprow">
        <For each={SCOPES}>
          {(s) => (
            <button class="chip" attr:data-on={scope() === s.id ? "" : undefined} onClick={() => setScope(s.id)}>
              {s.label}
            </button>
          )}
        </For>
      </div>

      <Show
        when={nq()}
        fallback={
          <Show
            when={recent().length}
            fallback={<Empty title="Busque no acervo" hint="Título, artista, álbum ou pasta. A busca roda no aparelho." />}
          >
            <div class="sec">
              <SecHead label="Buscas recentes" />
              <div class="rowlist">
                <For each={recent()}>
                  {(r) => (
                    <button class="rowitem" style={{ "padding-left": 0, "padding-right": 0 }} onClick={() => setQ(r)}>
                      <Icon.search class="lead" />
                      <div class="rt">{r}</div>
                      <Icon.chev />
                    </button>
                  )}
                </For>
              </div>
            </div>
          </Show>
        }
      >
        <Show when={nothing()}>
          <Empty title="Nada encontrado" hint={`Nenhum resultado para “${q()}”.`} />
        </Show>

        <Show when={show("folders") && folderHits().length}>
          <div class="sec">
            <SecHead label="Pastas" />
            <div class="rowlist">
              <For each={folderHits()}>
                {(f) => (
                  <button
                    class="rowitem"
                    onClick={() => {
                      remember(q());
                      navigate("/folder", f.name);
                    }}
                  >
                    <Cover seed={f.name} />
                    <div style={{ flex: 1, "min-width": 0 }}>
                      <div class="rt">{f.name}</div>
                      <div class="rowsub">{f.track_count} faixas</div>
                    </div>
                    <Icon.chev />
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={show("artists") && artistHits().length}>
          <div class="sec">
            <SecHead label="Artistas" />
            <div class="rowlist">
              <For each={artistHits()}>
                {(a) => (
                  <button
                    class="rowitem"
                    onClick={() => {
                      remember(q());
                      navigate("/artist", a.name);
                    }}
                  >
                    <Cover path={a.cover} seed={a.name} icon="person" />
                    <div style={{ flex: 1, "min-width": 0 }}>
                      <div class="rt">{a.name}</div>
                      <div class="rowsub">{a.track_count} faixas</div>
                    </div>
                    <Icon.chev />
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={show("albums") && albumHits().length}>
          <div class="sec">
            <SecHead label="Álbuns" />
            <div class="grid">
              <For each={albumHits()}>
                {(a) => (
                  <button
                    class="alb"
                    onClick={() => {
                      remember(q());
                      navigate("/album", a.key);
                    }}
                  >
                    <Cover path={a.cover} seed={a.key} cls="art" icon="disc" />
                    <div class="t">{a.title}</div>
                    <div class="s">{a.artist ?? "—"}</div>
                  </button>
                )}
              </For>
            </div>
          </div>
        </Show>

        <Show when={show("tracks") && hits().length}>
          <div class="sec" style={{ padding: 0 }}>
            <div style={{ padding: "0 20px" }}>
              <SecHead label="Faixas" />
            </div>
            <div class="rowlist list-lite" style={{ padding: "0 20px" }}>
              <LazyList items={hits()} chunk={40}>
                {(t, i) => (
                  <TrackRow
                    track={t}
                    onPlay={() => {
                      remember(q());
                      void playTrackFrom(hits(), i());
                    }}
                  />
                )}
              </LazyList>
            </div>
          </div>
        </Show>
        <div style={{ height: "16px" }} />
      </Show>
    </div>
  );
}
