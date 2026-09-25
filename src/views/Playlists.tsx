/* ============================================================
   views/Playlists.tsx — Folders reais + mosaico 2x2 de capas.

   Fonte de dados:
   - "All playlists" = lib_list_folders() — folders do disco com
     mosaico 2x2 das primeiras 4 covers distintas.
   - Sem smart playlists, "New playlist" nem reorder das fixadas: eram
     mock e controles sem acao (auditoria 25/09, lib-9). Voltam quando
     existirem de verdade (triagem D1/D6/item 2.5).
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

/** role=button promete Enter/Espaço: sem isto o card recebia foco por Tab
    e não fazia nada (o Espaço ainda rolava a página). */
function openOnKey(e: KeyboardEvent, folder: FolderPlaylist) {
  if (e.key !== "Enter" && e.key !== " ") return;
  e.preventDefault();
  openPlaylist(folder);
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
  // Parte das pastas ja filtradas: o filtro vale pras fixadas tambem.
  const pinned = createMemo(() => {
    const list = visibleFolders();
    const pinSet = pins();
    return pinSet
      .map((n) => list.find((f) => f.name === n))
      .filter((f): f is FolderPlaylist => !!f);
  });
  const rest = createMemo(() => {
    const list = visibleFolders();
    const pinnedNames = new Set(pins());
    const filtered = list.filter((f) => !pinnedNames.has(f.name));
    const dir = sortDir();
    if (dir === "none") return filtered;
    const sorted = [...filtered].sort((a, b) => a.name.localeCompare(b.name));
    return dir === "asc" ? sorted : sorted.reverse();
  });

  const totalPlaylists = () => (folders() ?? []).length;
  const totalTracks    = () => (folders() ?? []).reduce((sum, f) => sum + f.track_count, 0);

  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>Playlists</h1>
          <p class="view__head-hint">Coleções pessoais — uma pasta do acervo por playlist.</p>
        </div>
        <div class="view__stats">
          <span><b>{totalPlaylists()}</b> playlists</span>
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
        </div>

        {/* ── Pinned ───────────────────────────────────── */}
        <Show when={pinned().length > 0}>
          <section>
            <div class="section__head">
              <h2 class="section__title">Pinned</h2>
            </div>
            <div class="pl-grid">
              <For each={pinned()}>
                {(p) => (
                  <div class="pl-card" onClick={() => openPlaylist(p)} onKeyDown={(e) => openOnKey(e, p)} role="button" tabIndex={0} style={{ cursor: "pointer" }}>
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
              <For each={rest()}>
                {(p) => (
                  <div class="pl-card" onClick={() => openPlaylist(p)} onKeyDown={(e) => openOnKey(e, p)} role="button" tabIndex={0} style={{ cursor: "pointer" }}>
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
