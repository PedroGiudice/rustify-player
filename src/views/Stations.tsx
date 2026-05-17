/* ============================================================
   views/Stations.tsx — Smart radio stations, hi-fi.

   Recriacao da tela do mockup `Rustify ExtractorLab.html`
   (data-screen="stations"). Feature card com live eyebrow + titulo
   grande + chips de seeds + CTA preto + canvas <StationViz />.
   Grid de 6 st-cards (primeiro com badge Live verde).

   MOCK: backend ainda nao expoe lib_get_stations / seed engine.
   Quando expuser, trocar FEATURE / STATIONS por createResource.

   StationViz so monta o canvas quando o feature card esta visivel
   no viewport (IntersectionObserver) — evita gastar CPU com RAF
   quando o usuario scrollou pra fora.
   ============================================================ */

import { createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { StationViz } from "../components/dsp/StationViz";

type Tone =
  | "tone-lavender"
  | "tone-mint"
  | "tone-peach"
  | "tone-sky"
  | "tone-rose"
  | "tone-butter"
  | "tone-paper"
  | "tone-bone";

interface SeedChip {
  title: string;
  artist: string;
  tone: Tone;
  icon: string;
}

interface StationCard {
  name: string;
  tone: Tone;
  icon: string;
  seedLine: string;
  desc: string;
  stats: { played: number; match: number; last: string };
  live?: boolean;
}

// ── MOCK feature station ─────────────────────────────────────────
const FEATURE_SEEDS: SeedChip[] = [
  { title: "Northern Drift",                artist: "Aki Yamamura",   tone: "tone-lavender", icon: "lucide:target" },
  { title: "Slow Drift Through Static",     artist: "Boreal Trio",    tone: "tone-mint",     icon: "lucide:waves" },
  { title: "Solstice in B Minor",           artist: "Maren Hartwell", tone: "tone-bone",     icon: "lucide:rainbow" },
];

const STATIONS: StationCard[] = [
  {
    name: "Midnight",
    tone: "tone-lavender",
    icon: "lucide:target",
    seedLine: "seed · 3 tracks · 24 generated",
    desc: "ambient · drone · sleepless",
    stats: { played: 312, match: 97, last: "12 m" },
    live: true,
  },
  {
    name: "Sunday slow",
    tone: "tone-bone",
    icon: "lucide:rainbow",
    seedLine: "seed · 4 tracks · 38 generated",
    desc: "modern classical · acoustic · low tempo",
    stats: { played: 184, match: 91, last: "2 h" },
  },
  {
    name: "Bridge cable",
    tone: "tone-paper",
    icon: "ph:dots-nine",
    seedLine: "seed · 2 tracks · 21 generated",
    desc: "field recording · industrial · long form",
    stats: { played: 54, match: 88, last: "1 d" },
  },
  {
    name: "Solstice",
    tone: "tone-sky",
    icon: "lucide:mountain",
    seedLine: "seed · 5 tracks · 31 generated",
    desc: "winter strings · cold piano · church reverb",
    stats: { played: 96, match: 93, last: "4 d" },
  },
  {
    name: "Pylon",
    tone: "tone-peach",
    icon: "lucide:audio-lines",
    seedLine: "seed · 1 track · 17 generated",
    desc: "minimal electronic · krautrock-adjacent",
    stats: { played: 28, match: 85, last: "6 d" },
  },
  {
    name: "Halocline",
    tone: "tone-rose",
    icon: "lucide:atom",
    seedLine: "seed · 3 tracks · 29 generated",
    desc: "deep ambient · brackish · slow drone",
    stats: { played: 72, match: 90, last: "1 w" },
  },
];

// ── Header stats ─────────────────────────────────────────────────
const TOTAL_SEEDED = STATIONS.length;
const TOTAL_EMBEDDED = 2401;  // MOCK
const TOTAL_PENDING = 86;     // MOCK

// ── Wrapper que so renderiza StationViz quando esta no viewport ──
function LazyStationViz() {
  let host!: HTMLDivElement;
  const [visible, setVisible] = createSignal(true); // default true (caso IO nao exista)
  let obs: IntersectionObserver | null = null;

  onMount(() => {
    if (typeof IntersectionObserver === "undefined") return;
    obs = new IntersectionObserver(
      (entries) => {
        for (const e of entries) setVisible(e.isIntersecting);
      },
      { threshold: 0.05 },
    );
    obs.observe(host);
  });

  onCleanup(() => {
    if (obs) {
      obs.disconnect();
      obs = null;
    }
  });

  return (
    <div ref={host} class="st-feature__visual">
      <Show when={visible()} fallback={<canvas aria-hidden="true" />}>
        <StationViz />
      </Show>
    </div>
  );
}

export default function Stations() {
  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>Stations</h1>
          <p class="view__head-hint">Smart radio — geradas a partir de seeds e embeddings (qdrant).</p>
        </div>
        <div class="view__stats">
          <span><b>{TOTAL_SEEDED}</b> seeded</span>
          <span><b>{TOTAL_EMBEDDED}</b> embedded</span>
          <span><b>{TOTAL_PENDING}</b> pending</span>
        </div>
      </header>

      <div class="coll">
        {/* ── Feature station ──────────────────────────── */}
        <section class="st-feature">
          <div>
            <div class="st-feature__eyebrow">
              <span class="dot" />
              Live · streaming now
            </div>
            <h2 class="st-feature__title">Midnight station</h2>
            <p class="st-feature__hint">
              Quiet ambient, drone and modern classical clustered around the seeds below.
              Skips and dwells refeed the embedding to drift the station in the direction you listen.
            </p>
            <div class="st-feature__seeds">
              <For each={FEATURE_SEEDS}>
                {(s) => (
                  <span class="st-seed-chip">
                    <span class={`st-seed-chip__cover ${s.tone}`}>
                      {/* @ts-ignore */}
                      <iconify-icon icon={s.icon} noobserver />
                    </span>
                    {s.title} · {s.artist}
                  </span>
                )}
              </For>
            </div>
            <button class="st-feature__cta" type="button">
              {/* @ts-ignore */}
              <iconify-icon icon="ph:play-fill" noobserver />
              Resume station
            </button>
          </div>
          <LazyStationViz />
        </section>

        {/* ── Grid de stations ────────────────────────── */}
        <section>
          <div class="section__head">
            <h2 class="section__title">All stations</h2>
            <a class="section__action">New from current track →</a>
          </div>
          <div class="st-grid">
            <For each={STATIONS}>
              {(s) => (
                <div class="st-card">
                  <Show when={s.live}>
                    <span class="st-card__live">
                      <span class="dot" />
                      Live
                    </span>
                  </Show>
                  <div class="st-card__top">
                    <div class={`st-card__cover ${s.tone}`}>
                      {/* @ts-ignore */}
                      <iconify-icon icon={s.icon} noobserver />
                    </div>
                    <div class="st-card__head">
                      <span class="st-card__name">{s.name}</span>
                      <span class="st-card__seed-line">{s.seedLine}</span>
                    </div>
                  </div>
                  <p class="st-card__desc">{s.desc}</p>
                  <div class="st-card__stats">
                    <span>{s.stats.played} played</span>
                    <span>{s.stats.match}% match</span>
                    <span>last: {s.stats.last}</span>
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
