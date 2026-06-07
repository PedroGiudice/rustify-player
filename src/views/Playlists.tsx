/* ============================================================
   views/Playlists.tsx — Folders reais + mosaico 2x2 de capas.

   Fonte de dados:
   - "All playlists" = lib_list_folders() — folders do disco com
     mosaico 2x2 das primeiras 4 covers distintas.
   - "Smart playlists" = mock visual (feature nao existe no backend
     ainda — sem lib_create_smart_playlist ou similar).
   - "Pinned" = lista persistida em localStorage via store/pins.ts.
     Toggle via icon no canto sup. dir. do card.

   Click no card -> navega pra /playlist/<name> (Playlist.tsx).
   Pin toggle -> store/pins, sem navegar.

   Fallback do mosaico: se o folder tem < 4 covers distintas, slots
   vazios viram placeholder colorido (tones do extractor-lab).
   ============================================================ */

import { createMemo, createResource, createSignal, For, Show } from "solid-js";
import { libListFolders, coverUrl, type FolderPlaylist } from "../tauri";
import { isPinned, togglePin, pins } from "../store/pins";
import { navigate } from "../router";

function openPlaylist(folder: FolderPlaylist) {
  navigate(`/playlist/${encodeURIComponent(folder.name)}`);
}

// ── Tones de fallback (vide tokens em extractor-lab.css) ─────────
type Tone =
  | "tone-lavender" | "tone-mint" | "tone-peach" | "tone-sky"
  | "tone-rose" | "tone-butter" | "tone-paper" | "tone-bone";

const TONES: Tone[] = [
  "tone-lavender", "tone-mint", "tone-peach", "tone-sky",
  "tone-rose", "tone-butter", "tone-paper", "tone-bone",
];

// Hash deterministico (folder name -> tone idx) pra o mesmo folder
// sempre cair na mesma combinacao de cores quando precisar de fallback.
function toneFor(folder: string, offset: number): Tone {
  let h = 0;
  for (let i = 0; i < folder.length; i++) h = (h * 31 + folder.charCodeAt(i)) | 0;
  return TONES[Math.abs(h + offset) % TONES.length];
}

// ── Mosaico 2x2 de covers reais com fallback colorido ───────────
function CoverMosaic(props: { folder: FolderPlaylist }) {
  const cells = createMemo(() => {
    const out: Array<{ src: string | null; tone: Tone }> = [];
    const covers = props.folder.cover_paths ?? [];
    for (let i = 0; i < 4; i++) {
      const src = covers[i] ? coverUrl(covers[i]) : null;
      out.push({ src, tone: toneFor(props.folder.name, i) });
    }
    return out;
  });
  const pinned = createMemo(() => pins().includes(props.folder.name));
  return (
    <>
      <button
        class="pl-card__pin"
        classList={{ "is-pinned": pinned() }}
        title={pinned() ? "Unpin" : "Pin"}
        onClick={(e) => { e.stopPropagation(); togglePin(props.folder.name); }}
      >
        {/* @ts-ignore */}
        <iconify-icon icon="lucide:pin" noobserver />
      </button>
      <For each={cells()}>
        {(c) => (
          <Show
            when={c.src}
            fallback={
              <div class={`pl-card__quad ${c.tone}`}>
                {/* @ts-ignore */}
                <iconify-icon icon="lucide:disc-3" noobserver />
              </div>
            }
          >
            <div class="pl-card__quad pl-card__quad--cover">
              <img src={c.src!} alt="" loading="lazy" />
            </div>
          </Show>
        )}
      </For>
    </>
  );
}

// ── Smart playlists — mock ate backend expor smart playlists ─────
interface SmartPlaylist {
  icon: string;
  name: string;
  rule: string;
  updated: string;
  tracks: number;
  length: string;
}
const SMART_PLAYLISTS: SmartPlaylist[] = [
  { icon: "lucide:sparkles",      name: "Recently added", rule: "added >= 14 days · sort by date_added desc", updated: "preview", tracks: 0, length: "—" },
  { icon: "lucide:flame",         name: "Heavy rotation", rule: "play_count >= 6 in last 30d",                updated: "preview", tracks: 0, length: "—" },
  { icon: "lucide:flask-conical", name: "Never played",   rule: "play_count == 0 · added < 60d",              updated: "preview", tracks: 0, length: "—" },
];

// ── Helpers ─────────────────────────────────────────────────────
function fmtTracks(n: number): string {
  return `${n} ${n === 1 ? "track" : "tracks"}`;
}

export default function Playlists() {
  const [filter, setFilter] = createSignal("");
  const [folders] = createResource(() => libListFolders().catch(() => [] as FolderPlaylist[]));

  // "none" = ordem da API, "asc" = A→Z, "desc" = Z→A. Toggle ciclico.
  const [sortDir, setSortDir] = createSignal<"none" | "asc" | "desc">("none");
  function cycleSortDir() {
    setSortDir((cur) => (cur === "none" ? "asc" : cur === "asc" ? "desc" : "none"));
  }

  const visibleFolders = createMemo(() => {
    const list = folders() ?? [];
    const q = filter().trim().toLowerCase();
    if (!q) return list;
    return list.filter((f) => f.name.toLowerCase().includes(q));
  });

  // Pinned: lista persistida em localStorage (store/pins.ts). Reativo a pins().
  // Ordem segue a ordem em pins() — primeiro pinado = primeiro card.
  const pinned = createMemo(() => {
    const list = folders() ?? [];
    const pinSet = pins();
    return pinSet
      .map((n) => list.find((f) => f.name === n))
      .filter((f): f is FolderPlaylist => !!f);
  });
  const rest = createMemo(() => {
    const list = visibleFolders();
    const pinnedNames = new Set(pinned().map((p) => p.name));
    const filtered = list.filter((f) => !pinnedNames.has(f.name));
    const dir = sortDir();
    if (dir === "none") return filtered;
    const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    return dir === "asc" ? sorted : sorted.reverse();
  });

  const totalPlaylists = () => (folders() ?? []).length;
  const totalTracks    = () => (folders() ?? []).reduce((sum, f) => sum + f.track_count, 0);
  const totalSmart     = () => SMART_PLAYLISTS.length;

  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>Playlists</h1>
          <p class="view__head-hint">Coleções pessoais — manuais e smart playlists.</p>
        </div>
        <div class="view__stats">
          <span><b>{totalPlaylists()}</b> playlists</span>
          <span><b>{totalSmart()}</b> smart</span>
          <span><b>{totalTracks()}</b> tracks total</span>
        </div>
      </header>

      <div class="coll">
        {/* ── Toolbar ──────────────────────────────────── */}
        <div class="coll-toolbar">
          <div class="coll-search">
            {/* @ts-ignore */}
            <iconify-icon icon="lucide:search" noobserver />
            <input
              type="text"
              placeholder="Filter playlists…"
              value={filter()}
              onInput={(e) => setFilter(e.currentTarget.value)}
            />
          </div>
          <div class="sig-preset-actions">
            <button class="sig-pbtn" type="button" title="Backend pendente">
              {/* @ts-ignore */}
              <iconify-icon icon="lucide:plus" noobserver />
              New playlist
            </button>
            <button class="sig-pbtn" type="button" title="Backend pendente">
              {/* @ts-ignore */}
              <iconify-icon icon="lucide:sparkles" noobserver />
              New smart playlist
            </button>
          </div>
        </div>

        {/* ── Pinned ───────────────────────────────────── */}
        <Show when={pinned().length > 0}>
          <section>
            <div class="section__head">
              <h2 class="section__title">Pinned</h2>
              <a class="section__action">Reorder ⇅</a>
            </div>
            <div class="pl-grid">
              <For each={pinned()}>
                {(p) => (
                  <div class="pl-card" onClick={() => openPlaylist(p)} role="button" tabIndex={0} style={{ cursor: "pointer" }}>
                    <div class="pl-card__cover">
                      <CoverMosaic folder={p} />
                    </div>
                    <div class="pl-card__title">{p.name}</div>
                    <div class="pl-card__sub">Folder · {p.track_count} tracks</div>
                    <div class="pl-card__meta">
                      <span>{fmtTracks(p.track_count)}</span>
                    </div>
                  </div>
                )}
              </For>
            </div>
          </section>
        </Show>

        {/* ── Smart playlists (mock visual ate backend expor) ─── */}
        <section>
          <div class="section__head">
            <h2 class="section__title">Smart playlists · rule-based <span style={{ "font-size": "10px", color: "var(--fg-6)", "margin-left": "8px", "font-family": "var(--font-mono)" }}>preview</span></h2>
            <a class="section__action">View all rules →</a>
          </div>
          <table class="smart-tbl">
            <thead>
              <tr>
                <th class="smart-tbl__head" aria-label="icon"></th>
                <th class="smart-tbl__head">Name</th>
                <th class="smart-tbl__head">Rule</th>
                <th class="smart-tbl__head">Updated</th>
                <th class="smart-tbl__head smart-tbl__head--num">Tracks</th>
                <th class="smart-tbl__head smart-tbl__head--num">Length</th>
              </tr>
            </thead>
            <tbody>
              <For each={SMART_PLAYLISTS}>
                {(s) => (
                  <tr class="smart-tbl__row">
                    <td class="smart-tbl__icon">
                      {/* @ts-ignore */}
                      <iconify-icon icon={s.icon} noobserver />
                    </td>
                    <td class="smart-tbl__name">{s.name}</td>
                    <td class="smart-tbl__rule">{s.rule}</td>
                    <td class="smart-tbl__updated">{s.updated}</td>
                    <td class="smart-tbl__count">{s.tracks}</td>
                    <td class="smart-tbl__time">{s.length}</td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </section>

        {/* ── All playlists ────────────────────────────── */}
        <section>
          <div class="section__head">
            <h2 class="section__title">All playlists · {rest().length}</h2>
            <a class="section__action" style={{ cursor: "pointer" }} onClick={cycleSortDir}>
              {sortDir() === "none" ? "Sort by name" : sortDir() === "asc" ? "Sort: A→Z ↑" : "Sort: Z→A ↓"}
            </a>
          </div>
          <Show
            when={folders.loading || folders()}
            fallback={<p style={{ color: "var(--fg-5)", "font-size": "13px" }}>Sem playlists.</p>}
          >
            <div class="pl-grid">
              <div class="pl-card pl-card--new">
                <div class="pl-card__cover">
                  {/* @ts-ignore */}
                  <iconify-icon icon="lucide:plus" noobserver />
                </div>
                <div class="pl-card__title">New playlist</div>
                <div class="pl-card__sub">empty · drag tracks here</div>
              </div>
              <For each={rest()}>
                {(p) => (
                  <div class="pl-card" onClick={() => openPlaylist(p)} role="button" tabIndex={0} style={{ cursor: "pointer" }}>
                    <div class="pl-card__cover">
                      <CoverMosaic folder={p} />
                    </div>
                    <div class="pl-card__title">{p.name}</div>
                    <div class="pl-card__sub">Folder · {fmtTracks(p.track_count)}</div>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </section>
      </div>
    </article>
  );
}
