/* ============================================================
   views/Stations.tsx — Smart radio stations, hi-fi.

   Recriacao da tela do mockup `Rustify ExtractorLab.html`
   (data-screen="stations"). Feature card com live eyebrow + titulo
   grande + chips de seeds + CTA preto + canvas <StationViz />.
   Grid de stations carregado via lib_list_stations do backend.

   StationViz so monta o canvas quando o feature card esta visivel
   no viewport (IntersectionObserver) — evita gastar CPU com RAF
   quando o usuario scrollou pra fora.
   ============================================================ */

import { createResource, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { StationViz } from "../components/dsp/StationViz";
import {
  libListStations,
  libPlayStation,
  libCreateStation,
  Station,
} from "../tauri";

// ── Tipo de tone ─────────────────────────────────────────────────
type Tone =
  | "tone-lavender"
  | "tone-mint"
  | "tone-peach"
  | "tone-sky"
  | "tone-rose"
  | "tone-butter"
  | "tone-paper"
  | "tone-bone";

// ── Wrapper que so renderiza StationViz quando esta no viewport ──
function LazyStationViz() {
  let host!: HTMLDivElement;
  const [visible, setVisible] = createSignal(true);
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

// ── Formata tempo relativo (timestamp Unix em segundos) ──────────
function formatRelative(ts: number | null): string {
  if (!ts) return "—";
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return "agora";
  if (diff < 3600) return `${Math.floor(diff / 60)} m`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} d`;
  return `${Math.floor(diff / 604800)} sem`;
}

// ── Seed chip de uma station (exibe seeds via nome da tone) ──────
function SeedChips(props: { station: Station }) {
  // Exibe nome + icone da station como chips de seed (MVP: 1 chip por station)
  const chips: { label: string; tone: Tone; icon: string }[] = [
    {
      label: props.station.desc || props.station.name,
      tone: (props.station.tone as Tone) || "tone-lavender",
      icon: props.station.icon || "lucide:radio",
    },
  ];
  return (
    <For each={chips}>
      {(c) => (
        <span class="st-seed-chip">
          <span class={`st-seed-chip__cover ${c.tone}`}>
            {/* @ts-ignore */}
            <iconify-icon icon={c.icon} noobserver />
          </span>
          {c.label}
        </span>
      )}
    </For>
  );
}

// ── Feature card — primeira station (mais tocada) ────────────────
function FeatureCard(props: {
  station: Station;
  onResume: (id: string) => void;
}) {
  return (
    <section class="st-feature">
      <div>
        <div class="st-feature__eyebrow">
          <span class="dot" />
          Live · streaming now
        </div>
        <h2 class="st-feature__title">{props.station.name}</h2>
        <p class="st-feature__hint">
          {props.station.desc ||
            "Smart station gerada a partir de seeds e embeddings Qdrant."}
        </p>
        <div class="st-feature__seeds">
          <SeedChips station={props.station} />
        </div>
        <button
          class="st-feature__cta"
          type="button"
          onClick={() => props.onResume(props.station.id)}
        >
          {/* @ts-ignore */}
          <iconify-icon icon="ph:play-fill" noobserver />
          Resume station
        </button>
      </div>
      <LazyStationViz />
    </section>
  );
}

// ── Station card individual ──────────────────────────────────────
function StationCard(props: {
  station: Station;
  isFirst: boolean;
  onResume: (id: string) => void;
}) {
  const { station, isFirst } = props;
  const seedLine =
    station.kind === "seed"
      ? `seed · ${station.seed_track_ids.length} tracks`
      : `mood · ${station.query ?? ""}`;

  return (
    <div class="st-card" onClick={() => props.onResume(station.id)}>
      <Show when={isFirst}>
        <span class="st-card__live">
          <span class="dot" />
          Live
        </span>
      </Show>
      <div class="st-card__top">
        <div class={`st-card__cover ${station.tone}`}>
          {/* @ts-ignore */}
          <iconify-icon icon={station.icon} noobserver />
        </div>
        <div class="st-card__head">
          <span class="st-card__name">{station.name}</span>
          <span class="st-card__seed-line">{seedLine}</span>
        </div>
      </div>
      <p class="st-card__desc">{station.desc}</p>
      <div class="st-card__stats">
        <span>{station.stats.played} played</span>
        <span>
          {station.stats.match_avg != null
            ? `${Math.round(station.stats.match_avg * 100)}% match`
            : "—"}
        </span>
        <span>last: {formatRelative(station.stats.last_played_at)}</span>
      </div>
    </div>
  );
}

// ── View principal ───────────────────────────────────────────────
export default function Stations() {
  const [stations, { refetch }] = createResource(libListStations);

  async function handleResume(id: string) {
    try {
      await libPlayStation(id);
      // Refetch para atualizar estatisticas de played/last_played_at.
      refetch();
    } catch (err) {
      console.error("[stations] play falhou:", err);
    }
  }

  async function handleNewFromCurrent() {
    try {
      // Stub MVP: cria station tipo mood com query vazia.
      // Idealmente usaria a track atual do player como seed.
      await libCreateStation({
        name: "New station",
        kind: "seed",
        icon: "lucide:radio",
        tone: "tone-sky",
        desc: "criada a partir da track atual",
      });
      refetch();
    } catch (err) {
      console.error("[stations] create falhou:", err);
    }
  }

  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>Stations</h1>
          <p class="view__head-hint">
            Smart radio — geradas a partir de seeds e embeddings (qdrant).
          </p>
        </div>
        <div class="view__stats">
          <Show when={!stations.loading} fallback={<span>—</span>}>
            <span>
              <b>{stations()?.length ?? 0}</b> seeded
            </span>
          </Show>
        </div>
      </header>

      <div class="coll">
        {/* ── Feature station ──────────────────────────── */}
        <Show
          when={(stations()?.length ?? 0) > 0}
          fallback={
            <section class="st-feature">
              <div>
                <div class="st-feature__eyebrow">
                  <span class="dot" />
                  {stations.loading ? "Carregando..." : "Nenhuma station"}
                </div>
                <h2 class="st-feature__title">
                  {stations.loading ? "Aguarde" : "Crie sua primeira station"}
                </h2>
                <p class="st-feature__hint">
                  {stations.loading
                    ? "Buscando stations salvas..."
                    : "Use o botao abaixo para criar uma station a partir da track atual."}
                </p>
                <div class="st-feature__seeds">
                  <span class="st-seed-chip">
                    <span class="st-seed-chip__cover tone-lavender">
                      {/* @ts-ignore */}
                      <iconify-icon icon="lucide:sparkles" noobserver />
                    </span>
                    Nenhuma seed ainda
                  </span>
                  <span class="st-seed-chip">
                    <span class="st-seed-chip__cover tone-mint">
                      {/* @ts-ignore */}
                      <iconify-icon icon="lucide:waves" noobserver />
                    </span>
                    Toque musicas para gerar seeds
                  </span>
                  <span class="st-seed-chip">
                    <span class="st-seed-chip__cover tone-bone">
                      {/* @ts-ignore */}
                      <iconify-icon icon="lucide:rainbow" noobserver />
                    </span>
                    Stations aparecem aqui
                  </span>
                </div>
              </div>
              <LazyStationViz />
            </section>
          }
        >
          <FeatureCard
            station={stations()![0]}
            onResume={handleResume}
          />
        </Show>

        {/* ── Grid de stations ────────────────────────── */}
        <section>
          <div class="section__head">
            <h2 class="section__title">All stations</h2>
            <a
              class="section__action"
              style={{ cursor: "pointer" }}
              onClick={handleNewFromCurrent}
            >
              New from current track →
            </a>
          </div>
          <div class="st-grid">
            <Show
              when={(stations()?.length ?? 0) > 0}
              fallback={
                <For each={Array.from({ length: 6 })}>
                  {(_, i) => (
                    <div class="st-card" style={{ opacity: "0.35" }}>
                      <Show when={i() === 0}>
                        <span class="st-card__live">
                          <span class="dot" />
                          Live
                        </span>
                      </Show>
                      <div class="st-card__top">
                        <div class="st-card__cover tone-lavender">
                          {/* @ts-ignore */}
                          <iconify-icon icon="lucide:radio" noobserver />
                        </div>
                        <div class="st-card__head">
                          <span class="st-card__name">—</span>
                          <span class="st-card__seed-line">sem stations</span>
                        </div>
                      </div>
                      <p class="st-card__desc">
                        Toque musicas para gerar stations automaticamente.
                      </p>
                      <div class="st-card__stats">
                        <span>0 played</span>
                        <span>—</span>
                        <span>last: —</span>
                      </div>
                    </div>
                  )}
                </For>
              }
            >
              <For each={stations()}>
                {(s, i) => (
                  <StationCard
                    station={s}
                    isFirst={i() === 0}
                    onResume={handleResume}
                  />
                )}
              </For>
            </Show>
          </div>
        </section>
      </div>
    </article>
  );
}
