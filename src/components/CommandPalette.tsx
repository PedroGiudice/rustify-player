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
import { libSearch, coverUrl, type Track } from "../tauri";

export const CMD_PALETTE_EVENT = "rustify:open-palette";

interface ActionItem {
  kind: "action";
  id: string;
  title: string;
  sub: string;
  icon: string;
  run: () => void;
}
interface TrackItem {
  kind: "track";
  track: Track;
}
type Item = ActionItem | TrackItem;

function fmtDur(ms: number): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

export function CommandPalette() {
  const [open, setOpen] = createSignal(false);
  const [query, setQuery] = createSignal("");
  const [active, setActive] = createSignal(0);
  let inputEl!: HTMLInputElement;

  // libSearch retorna { tracks, albums, artists } no backend; aqui só usamos tracks.
  const [searchResults] = createResource(query, async (q): Promise<Track[]> => {
    if (!q.trim()) return [];
    try {
      const r = await libSearch(q, 6);
      if (Array.isArray(r)) return r as Track[];
      return (r?.tracks as Track[]) ?? [];
    } catch { return []; }
  });

  const actions = (): ActionItem[] => [
    {
      kind: "action", id: "shuffle", icon: ICONS.bolt,
      title: "Shuffle all", sub: "play library tracks in random order",
      run: () => { navigate("/library"); close(); },
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
    const tracks = (searchResults() ?? []).map<TrackItem>((t) => ({ kind: "track", track: t }));
    if (tracks.length === 0) return actions();
    return [...tracks, ...actions()];
  });

  function close() {
    setOpen(false);
    setQuery("");
    setActive(0);
  }

  function openPalette() {
    setOpen(true);
    setTimeout(() => inputEl?.focus(), 50);
  }

  function runItem(it: Item) {
    if (it.kind === "action") it.run();
    else {
      setQueue([it.track], 0);
      playTrack(it.track);
      close();
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
            onInput={(e) => batch(() => { setQuery(e.currentTarget.value); setActive(0); })}
          />
          <span class="palette__esc">ESC</span>
        </div>
        <div class="palette__list">
          <Show when={query() && (searchResults()?.length ?? 0) > 0}>
            <div class="palette__section">Tracks</div>
          </Show>
          <For each={items()}>
            {(it, i) => (
              <div
                class={`palette__item${active() === i() ? " active" : ""}`}
                onMouseMove={() => setActive(i())}
                onClick={() => runItem(it)}
              >
                <Show
                  when={it.kind === "track"}
                  fallback={
                    <div class="palette__item-icon">
                      <Icon name={(it as ActionItem).icon} size={14} />
                    </div>
                  }
                >
                  {() => {
                    const t = (it as TrackItem).track;
                    return (
                      <div class="palette__item-icon" style={{ background: "transparent", border: "0", padding: 0 }}>
                        <CoverArt
                          seed={t.album_title || t.id}
                          src={coverUrl(t.album_cover_path)}
                          size="sm"
                          style={{ width: "28px", height: "28px" }}
                        />
                      </div>
                    );
                  }}
                </Show>
                <div class="palette__item-text">
                  <div class="palette__item-title">
                    {it.kind === "action" ? it.title : it.track.title}
                  </div>
                  <div class="palette__item-sub">
                    {it.kind === "action"
                      ? it.sub
                      : `${it.track.artist_name ?? "—"} · ${it.track.album_title ?? "—"} · ${fmtDur(it.track.duration_ms)}`}
                  </div>
                </div>
                <div class="palette__item-hint">
                  {it.kind === "track" ? "↵ play · ⌘↵ next · ⇧↵ queue" : "↵"}
                </div>
              </div>
            )}
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
