/* ============================================================
   components/CommandPalette.tsx — ⌘K overlay.

   Opens on:
     - 'rustify:open-palette' custom event (dispatched by Sidebar)
     - Ctrl/Cmd+K  global keydown
   Closes on Esc or scrim click.

   Search hits libSearch() from tauri.ts and shows top tracks +
   action items.
   ============================================================ */

import { For, Show, batch, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { Icon, ICONS } from "./Icon";
import { CoverArt } from "./CoverArt";
import { navigate } from "../router";
import { playTrack } from "./PlayerBar";
import { setQueue, enqueueEnd, enqueueNext } from "../store/player";
import { openTrackMenu } from "../store/contextMenu";
import { libSearch, libShuffle, coverUrl, type Track, type Album, type Artist } from "../tauri";

export const CMD_PALETTE_EVENT = "rustify:open-palette";

interface ActionItem {
  kind: "action";
  id: string;
  title: string;
  sub: string;
  icon: string;
  run: () => void | Promise<void>;
}
interface TrackItem {
  kind: "track";
  track: Track;
}
interface AlbumItem {
  kind: "album";
  album: Album;
}
interface ArtistItem {
  kind: "artist";
  artist: Artist;
}
type Item = ActionItem | TrackItem | AlbumItem | ArtistItem;

interface SearchBundle {
  tracks: Track[];
  albums: Album[];
  artists: Artist[];
}

function fmtDur(ms: number): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function CommandPalette() {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  // `query` reflete o input na hora (controlled); `debouncedQuery` alimenta a
  // busca com ~150ms de atraso, evitando um scroll da biblioteca por tecla.
  const [debouncedQuery, setDebouncedQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  let inputEl!: HTMLInputElement;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;

  // libSearch retorna { tracks, albums, artists } no backend.
  // Caso o backend retorne array (formato legado), trata como apenas tracks.
  const [searchResults] = createResource(debouncedQuery, async (q): Promise<SearchBundle> => {
    const empty: SearchBundle = { tracks: [], albums: [], artists: [] };
    if (!q.trim()) return empty;
    try {
      const r = await libSearch(q, 6);
      if (Array.isArray(r)) return { tracks: r as Track[], albums: [], artists: [] };
      return {
        tracks: (r?.tracks as Track[]) ?? [],
        albums: (r?.albums as Album[]) ?? [],
        artists: (r?.artists as Artist[]) ?? [],
      };
    } catch { return empty; }
  });

  const hasResults = () => {
    const r = searchResults();
    return !!r && (r.tracks.length + r.albums.length + r.artists.length) > 0;
  };

  // ActionItem do Crate: sempre presente com query digitada (busca na rede
  // Soulseek), promovido ao topo quando o acervo local não achou nada — é
  // o gancho de descoberta inteiro (spec §4.1): o usuário procura, não
  // tem, e a saída está exatamente ali.
  const crateAction = (): ActionItem | null => {
    const q = query().trim();
    if (!q) return null;
    return {
      kind: "action", id: "crate-search", icon: ICONS.packageOpen,
      title: `Procurar "${q}" na rede →`, sub: "busca na rede Soulseek (Crate)",
      run: () => { navigate(`/crate/${encodeURIComponent(q)}`); close(); },
    };
  };

  const actions = (): ActionItem[] => [
    {
      kind: "action", id: "shuffle", icon: ICONS.bolt,
      title: "Shuffle all", sub: "play library tracks in random order",
      run: async () => {
        try {
          const tracks = await libShuffle(50);
          if (tracks.length) {
            setQueue(tracks, 0);
            playTrack(tracks[0]);
          }
        } catch (e) {
          console.error("[palette] shuffle all failed:", e);
        }
        close();
      },
    },
    {
      kind: "action", id: "queue", icon: ICONS.queue,
      title: "Open queue", sub: "see what's up next",
      run: () => { window.dispatchEvent(new CustomEvent("rustify:open-queue")); close(); },
    },
    {
      kind: "action", id: "signal", icon: ICONS.signal,
      title: "Open Signal", sub: "DSP · EQ · normalization",
      run: () => { navigate("/signal"); close(); },
    },
    {
      kind: "action", id: "settings", icon: ICONS.settings,
      title: "Open Settings", sub: "library, audio, theme",
      run: () => { navigate("/settings"); close(); },
    },
  ];

  const items = createMemo<Item[]>(() => {
    const r = searchResults();
    const ca = crateAction();
    if (!r || (r.tracks.length + r.albums.length + r.artists.length) === 0) {
      // Sem resultados locais: promovido ao topo, antes das demais actions.
      return ca ? [ca, ...actions()] : actions();
    }
    const tracks = r.tracks.map<TrackItem>((t) => ({ kind: "track", track: t }));
    const albums = r.albums.map<AlbumItem>((a) => ({ kind: "album", album: a }));
    const artists = r.artists.map<ArtistItem>((a) => ({ kind: "artist", artist: a }));
    const acts = ca ? [...actions(), ca] : actions();
    return [...tracks, ...albums, ...artists, ...acts];
  });

  // Indices das fronteiras de secao (para inserir headers no render).
  const sectionBoundaries = createMemo(() => {
    const r = searchResults();
    const tracks = r?.tracks.length ?? 0;
    const albums = r?.albums.length ?? 0;
    const artists = r?.artists.length ?? 0;
    return {
      tracksStart: 0,
      albumsStart: tracks,
      artistsStart: tracks + albums,
      actionsStart: tracks + albums + artists,
      counts: { tracks, albums, artists },
    };
  });

  function close() {
    setOpen(false);
    setQuery("");
    setDebouncedQuery("");
    clearTimeout(debounceTimer);
    setActive(0);
  }

  function openPalette() {
    setOpen(true);
    setTimeout(() => inputEl?.focus(), 50);
  }

  function runItem(it: Item) {
    if (it.kind === "action") { it.run(); return; }
    if (it.kind === "track") {
      setQueue([it.track], 0);
      playTrack(it.track);
      close();
      return;
    }
    if (it.kind === "album") {
      navigate(`/album/${encodeURIComponent(it.album.title)}`);
      close();
      return;
    }
    if (it.kind === "artist") {
      navigate(`/artist/${encodeURIComponent(it.artist.name)}`);
      close();
      return;
    }
  }

  function handleKey(e: KeyboardEvent) {
    if (!open()) return;
    const all = items();
    if (e.key === "Escape") { e.preventDefault(); close(); return; }
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => (i + 1) % all.length); return; }
    if (e.key === "ArrowUp")   { e.preventDefault(); setActive((i) => (i - 1 + all.length) % all.length); return; }
    if (e.key === "Enter") {
      e.preventDefault();
      const it = all[active()];
      if (!it) return;
      // Mod+Enter = play next; Shift+Enter = queue
      if (it.kind === "track" && (e.metaKey || e.ctrlKey)) { enqueueNext(it.track); close(); return; }
      if (it.kind === "track" && e.shiftKey)               { enqueueEnd(it.track);  close(); return; }
      runItem(it);
    }
  }

  onMount(() => {
    const onOpenEvt = () => openPalette();
    const onGlobalKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        if (open()) close(); else openPalette();
      }
    };
    window.addEventListener(CMD_PALETTE_EVENT, onOpenEvt);
    window.addEventListener("keydown", onGlobalKey);
    onCleanup(() => {
      window.removeEventListener(CMD_PALETTE_EVENT, onOpenEvt);
      window.removeEventListener("keydown", onGlobalKey);
      clearTimeout(debounceTimer);
    });
  });

  return (
    <div
      class="palette-scrim"
      data-open={open() ? "true" : "false"}
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div class="palette" onKeyDown={handleKey}>
        <div class="palette__input-row">
          <div class="palette__icon"><Icon name={ICONS.search} size={18} /></div>
          <input
            ref={inputEl}
            class="palette__input"
            value={query()}
            placeholder="Buscar tracks, albums, artists ou comandos…"
            onInput={(e) => {
              const val = e.currentTarget.value;
              batch(() => { setQuery(val); setActive(0); });
              clearTimeout(debounceTimer);
              debounceTimer = setTimeout(() => setDebouncedQuery(val), 150);
            }}
          />
          <span class="palette__esc">ESC</span>
        </div>
        <div class="palette__list">
          <For each={items()}>
            {(it, i) => {
              // Accessors (nao consts): i() e sectionBoundaries() sao signals;
              // capturar o valor na criacao da row congelaria os headers se a
              // row for reconciliada em vez de remontada.
              const showTracksHeader = () => {
                const b = sectionBoundaries();
                return hasResults() && b.counts.tracks > 0 && i() === b.tracksStart;
              };
              const showAlbumsHeader = () => {
                const b = sectionBoundaries();
                return hasResults() && b.counts.albums > 0 && i() === b.albumsStart;
              };
              const showArtistsHeader = () => {
                const b = sectionBoundaries();
                return hasResults() && b.counts.artists > 0 && i() === b.artistsStart;
              };
              const showActionsHeader = () =>
                hasResults() && i() === sectionBoundaries().actionsStart;
              return (
                <>
                  <Show when={showTracksHeader()}>
                    <div class="palette__section">Tracks</div>
                  </Show>
                  <Show when={showAlbumsHeader()}>
                    <div class="palette__section">Albums</div>
                  </Show>
                  <Show when={showArtistsHeader()}>
                    <div class="palette__section">Artists</div>
                  </Show>
                  <Show when={showActionsHeader()}>
                    <div class="palette__section">Actions</div>
                  </Show>
                  <div
                    class={`palette__item${active() === i() ? " active" : ""}`}
                    onMouseMove={() => setActive(i())}
                    onClick={() => runItem(it)}
                    onContextMenu={(e) => {
                      // Só tracks têm menu de contexto (play next / queue /
                      // shuffle / like). Abre o menu e fecha o palette: o menu
                      // (Portal no body, z-index 300) cobre o scrim (z-index 100)
                      // e o close evita overlay órfão se a ação navegar.
                      if (it.kind !== "track") return;
                      openTrackMenu(e, it.track, {
                        list: searchResults()?.tracks,
                        onPlay: () => runItem(it),
                      });
                      close();
                    }}
                  >
                    <Show
                      when={it.kind === "track" ? (it as TrackItem).track : null}
                      keyed
                      fallback={
                        <Show
                          when={it.kind === "album" ? (it as AlbumItem).album : null}
                          keyed
                          fallback={
                            <Show
                              when={it.kind === "artist"}
                              fallback={
                                <div class="palette__item-icon">
                                  <Icon name={(it as ActionItem).icon} size={14} />
                                </div>
                              }
                            >
                              <div class="palette__item-icon">
                                <Icon name={ICONS.artists ?? ICONS.search} size={14} />
                              </div>
                            </Show>
                          }
                        >
                          {(a) => (
                            <div class="palette__item-icon" style={{ background: "transparent", border: "0", padding: 0 }}>
                              <CoverArt
                                seed={a.title}
                                src={coverUrl(a.cover_path)}
                                size="sm"
                                style={{ width: "28px", height: "28px" }}
                              />
                            </div>
                          )}
                        </Show>
                      }
                    >
                      {(t) => (
                        <div class="palette__item-icon" style={{ background: "transparent", border: "0", padding: 0 }}>
                          <CoverArt
                            seed={t.album_title || t.id}
                            src={coverUrl(t.album_cover_path)}
                            size="sm"
                            style={{ width: "28px", height: "28px" }}
                          />
                        </div>
                      )}
                    </Show>
                    <div class="palette__item-text">
                      <div class="palette__item-title">
                        {it.kind === "action"
                          ? it.title
                          : it.kind === "track"
                            ? it.track.title
                            : it.kind === "album"
                              ? it.album.title
                              : it.artist.name}
                      </div>
                      <div class="palette__item-sub">
                        {it.kind === "action"
                          ? it.sub
                          : it.kind === "track"
                            ? `${it.track.artist_name ?? "—"} · ${it.track.album_title ?? "—"} · ${fmtDur(it.track.duration_ms)}`
                            : it.kind === "album"
                              ? `${it.album.artist_name ?? "—"} · ${it.album.track_count} tracks`
                              : `${it.artist.track_count} tracks · ${it.artist.album_count} albums`}
                      </div>
                    </div>
                    <div class="palette__item-hint">
                      {it.kind === "track"
                        ? "↵ play · ⌘↵ next · ⇧↵ queue"
                        : it.kind === "album" || it.kind === "artist"
                          ? "↵ open"
                          : "↵"}
                    </div>
                  </div>
                </>
              );
            }}
          </For>
        </div>
        <div class="palette__footer">
          <span><span class="kbd">↑↓</span> navigate</span>
          <span><span class="kbd">↵</span> play</span>
          <span><span class="kbd">⌘↵</span> play next</span>
          <span><span class="kbd">⇧↵</span> add to queue</span>
        </div>
      </div>
    </div>
  );
}
