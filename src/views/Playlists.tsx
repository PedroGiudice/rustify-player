/* ============================================================
   views/Playlists.tsx — Manual + smart playlists, hi-fi.

   Recriacao da tela do mockup `Rustify ExtractorLab.html`
   (data-screen="playlists"). Toolbar + Pinned + Smart playlists
   table + All playlists grid com primeiro tile dashed pra criar.

   MOCK: backend ainda nao expoe lib_list_playlists / lib_create_playlist
   / smart playlists. Quando expuser, trocar PINNED / SMART / ALL por
   createResource consumindo os comandos Tauri.
   ============================================================ */

import { createSignal, For } from "solid-js";

// ── Tones permitidos (vide tokens em extractor-lab.css) ─────────
type Tone =
  | "tone-lavender"
  | "tone-mint"
  | "tone-peach"
  | "tone-sky"
  | "tone-rose"
  | "tone-butter"
  | "tone-paper"
  | "tone-bone";

interface QuadCell {
  tone: Tone;
  icon: string; // iconify name (lucide:* | ph:*)
}

interface PinnedPlaylist {
  title: string;
  sub: string;
  meta: { tracks: number; length: string };
  quads: [QuadCell, QuadCell, QuadCell, QuadCell];
}

interface SmartPlaylist {
  icon: string;
  name: string;
  rule: string;
  updated: string;
  tracks: number;
  length: string;
}

interface PlaylistCard {
  title: string;
  sub: string;
  meta: { tracks: number; length: string };
  quads: [QuadCell, QuadCell, QuadCell, QuadCell];
}

// ── MOCK data — replica do hi-fi mockup ──────────────────────────
const PINNED_PLAYLISTS: PinnedPlaylist[] = [
  {
    title: "Cold morning, hot coffee",
    sub: "Manual · curated by you",
    meta: { tracks: 34, length: "2 h 41 m" },
    quads: [
      { tone: "tone-lavender", icon: "lucide:target" },
      { tone: "tone-mint",     icon: "lucide:waves" },
      { tone: "tone-sky",      icon: "lucide:mountain" },
      { tone: "tone-bone",     icon: "lucide:rainbow" },
    ],
  },
  {
    title: "Coding · low energy",
    sub: "Manual · 18 plays this week",
    meta: { tracks: 52, length: "4 h 12 m" },
    quads: [
      { tone: "tone-peach",    icon: "lucide:audio-lines" },
      { tone: "tone-butter",   icon: "lucide:plus" },
      { tone: "tone-rose",     icon: "lucide:atom" },
      { tone: "tone-paper",    icon: "ph:dots-nine" },
    ],
  },
  {
    title: "Bedtime quietude",
    sub: "Manual · last played yesterday",
    meta: { tracks: 21, length: "1 h 38 m" },
    quads: [
      { tone: "tone-sky",      icon: "lucide:mountain" },
      { tone: "tone-lavender", icon: "lucide:target" },
      { tone: "tone-bone",     icon: "lucide:rainbow" },
      { tone: "tone-mint",     icon: "lucide:waves" },
    ],
  },
];

const SMART_PLAYLISTS: SmartPlaylist[] = [
  { icon: "lucide:sparkles",      name: "Recently added", rule: "added >= 14 days · sort by date_added desc", updated: "live", tracks: 48, length: "3:22:18" },
  { icon: "lucide:flame",         name: "Heavy rotation", rule: "play_count >= 6 in last 30d",                updated: "live", tracks: 26, length: "1:54:02" },
  { icon: "lucide:flask-conical", name: "Never played",   rule: "play_count == 0 · added < 60d",              updated: "live", tracks: 94, length: "6:48:51" },
];

const ALL_PLAYLISTS: PlaylistCard[] = [
  {
    title: "Field recordings",
    sub: "Manual · 7 plays",
    meta: { tracks: 19, length: "1 h 22 m" },
    quads: [
      { tone: "tone-mint",     icon: "lucide:waves" },
      { tone: "tone-paper",    icon: "ph:dots-nine" },
      { tone: "tone-peach",    icon: "lucide:audio-lines" },
      { tone: "tone-sky",      icon: "lucide:mountain" },
    ],
  },
  {
    title: "Drone & long-form",
    sub: "Manual · last played 3 d ago",
    meta: { tracks: 11, length: "2 h 04 m" },
    quads: [
      { tone: "tone-butter",   icon: "lucide:plus" },
      { tone: "tone-rose",     icon: "lucide:atom" },
      { tone: "tone-lavender", icon: "lucide:target" },
      { tone: "tone-mint",     icon: "lucide:waves" },
    ],
  },
  {
    title: "Winter strings",
    sub: "Manual · 4 plays",
    meta: { tracks: 27, length: "1 h 47 m" },
    quads: [
      { tone: "tone-bone",     icon: "lucide:rainbow" },
      { tone: "tone-sky",      icon: "lucide:mountain" },
      { tone: "tone-paper",    icon: "ph:dots-nine" },
      { tone: "tone-mint",     icon: "lucide:waves" },
    ],
  },
  {
    title: "Bright mornings",
    sub: "Manual · 12 plays",
    meta: { tracks: 16, length: "1 h 02 m" },
    quads: [
      { tone: "tone-rose",     icon: "lucide:atom" },
      { tone: "tone-peach",    icon: "lucide:audio-lines" },
      { tone: "tone-butter",   icon: "lucide:plus" },
      { tone: "tone-lavender", icon: "lucide:target" },
    ],
  },
  {
    title: "Long drive",
    sub: "Manual · 1 play",
    meta: { tracks: 41, length: "3 h 14 m" },
    quads: [
      { tone: "tone-paper",    icon: "ph:dots-nine" },
      { tone: "tone-bone",     icon: "lucide:rainbow" },
      { tone: "tone-mint",     icon: "lucide:waves" },
      { tone: "tone-peach",    icon: "lucide:audio-lines" },
    ],
  },
  {
    title: "Saturday slow",
    sub: "Manual · 9 plays",
    meta: { tracks: 23, length: "1 h 32 m" },
    quads: [
      { tone: "tone-lavender", icon: "lucide:target" },
      { tone: "tone-mint",     icon: "lucide:waves" },
      { tone: "tone-paper",    icon: "ph:dots-nine" },
      { tone: "tone-rose",     icon: "lucide:atom" },
    ],
  },
];

// Total agregado dos counts (header stats).
const TOTAL_TRACKS = (() => {
  let sum = 0;
  for (const p of PINNED_PLAYLISTS) sum += p.meta.tracks;
  for (const p of SMART_PLAYLISTS) sum += p.tracks;
  for (const p of ALL_PLAYLISTS) sum += p.meta.tracks;
  return sum;
})();
const TOTAL_PLAYLISTS = PINNED_PLAYLISTS.length + ALL_PLAYLISTS.length;
const TOTAL_SMART = SMART_PLAYLISTS.length;

// ── Cover quad helper ────────────────────────────────────────────
function CoverQuads(props: { quads: PinnedPlaylist["quads"] }) {
  return (
    <For each={props.quads}>
      {(q) => (
        <div class={`pl-card__quad ${q.tone}`}>
          {/* @ts-ignore -- iconify-icon web component */}
          <iconify-icon icon={q.icon} noobserver />
        </div>
      )}
    </For>
  );
}

export default function Playlists() {
  const [filter, setFilter] = createSignal("");

  // Filtragem client-side simples — case insensitive sobre titulo.
  // Mock: backend nao oferece search server-side.
  const filtered = (list: PlaylistCard[]) => {
    const q = filter().trim().toLowerCase();
    if (!q) return list;
    return list.filter((p) => p.title.toLowerCase().includes(q));
  };

  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>Playlists</h1>
          <p class="view__head-hint">Coleções pessoais — manuais e smart playlists.</p>
        </div>
        <div class="view__stats">
          <span><b>{TOTAL_PLAYLISTS}</b> playlists</span>
          <span><b>{TOTAL_SMART}</b> smart</span>
          <span><b>{TOTAL_TRACKS}</b> tracks total</span>
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
            <button class="sig-pbtn" type="button">
              {/* @ts-ignore */}
              <iconify-icon icon="lucide:arrow-down-narrow-wide" noobserver />
              Recently played
            </button>
          </div>
        </div>

        {/* ── Pinned ───────────────────────────────────── */}
        <section>
          <div class="section__head">
            <h2 class="section__title">Pinned</h2>
            <a class="section__action">Reorder ⇅</a>
          </div>
          <div class="pl-grid">
            <For each={PINNED_PLAYLISTS}>
              {(p) => (
                <div class="pl-card">
                  <div class="pl-card__cover">
                    <span class="pl-card__pin">
                      {/* @ts-ignore */}
                      <iconify-icon icon="lucide:pin" noobserver />
                    </span>
                    <CoverQuads quads={p.quads} />
                  </div>
                  <div class="pl-card__title">{p.title}</div>
                  <div class="pl-card__sub">{p.sub}</div>
                  <div class="pl-card__meta">
                    <span>{p.meta.tracks} tracks</span>
                    <span>·</span>
                    <span>{p.meta.length}</span>
                  </div>
                </div>
              )}
            </For>
          </div>
        </section>

        {/* ── Smart playlists ──────────────────────────── */}
        <section>
          <div class="section__head">
            <h2 class="section__title">Smart playlists · rule-based</h2>
            <a class="section__action">View all rules →</a>
          </div>
          <div class="smart-tbl">
            <div class="smart-tbl__head"></div>
            <div class="smart-tbl__head">Name</div>
            <div class="smart-tbl__head">Rule</div>
            <div class="smart-tbl__head">Updated</div>
            <div class="smart-tbl__head" style={{ "justify-content": "flex-end" }}>Tracks</div>
            <div class="smart-tbl__head" style={{ "justify-content": "flex-end" }}>Length</div>
            <For each={SMART_PLAYLISTS}>
              {(s) => (
                <div class="smart-tbl__row">
                  <div class="smart-tbl__icon">
                    {/* @ts-ignore */}
                    <iconify-icon icon={s.icon} noobserver />
                  </div>
                  <div class="smart-tbl__name">{s.name}</div>
                  <div class="smart-tbl__rule">{s.rule}</div>
                  <div class="smart-tbl__updated">{s.updated}</div>
                  <div class="smart-tbl__count">{s.tracks}</div>
                  <div class="smart-tbl__time">{s.length}</div>
                </div>
              )}
            </For>
          </div>
        </section>

        {/* ── All playlists ────────────────────────────── */}
        <section>
          <div class="section__head">
            <h2 class="section__title">All playlists · {ALL_PLAYLISTS.length + 1}</h2>
            <a class="section__action">Sort by name ↓</a>
          </div>
          <div class="pl-grid">
            <div class="pl-card pl-card--new">
              <div class="pl-card__cover">
                {/* @ts-ignore */}
                <iconify-icon icon="lucide:plus" noobserver />
              </div>
              <div class="pl-card__title">New playlist</div>
              <div class="pl-card__sub">empty · drag tracks here</div>
            </div>
            <For each={filtered(ALL_PLAYLISTS)}>
              {(p) => (
                <div class="pl-card">
                  <div class="pl-card__cover">
                    <CoverQuads quads={p.quads} />
                  </div>
                  <div class="pl-card__title">{p.title}</div>
                  <div class="pl-card__sub">{p.sub}</div>
                  <div class="pl-card__meta">
                    <span>{p.meta.tracks} tracks</span>
                    <span>·</span>
                    <span>{p.meta.length}</span>
                  </div>
                </div>
              )}
            </For>
          </div>
        </section>
      </div>
    </article>
  );
}
