/* ============================================================
   views/Stations.tsx — Smart radio stations, hi-fi.

   Recriacao da tela do mockup `Rustify ExtractorLab.html`
   (data-screen="stations"). Feature card (a station mais tocada:
   lib_list_stations ordena por played desc) + titulo grande + chips
   de seeds + CTA preto + canvas <StationViz />. Grid de stations
   carregado via lib_list_stations do backend. Nada aqui afirma que
   uma station esta tocando: a tela nao consulta isso.

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
  libDeleteStation,
  libMoodVocabulary,
  Station,
} from "../tauri";
import { player, setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { startRadioSession, registerSeen } from "../store/radioSession";

// Lote inicial reduzido (Fase 2 do session-awareness): a station vira fila
// incremental — o topup (PlayerBar.tsx topUpStation) busca mais conforme a
// audição avança, com o sinal de sessão (seenIds/skippedIds) já ativo desde
// o 2º lote. 40 tracks de uma vez congelava a recomendação no momento do
// clique; 8 é o mesmo espelho de UX que o modo radio/shuffle já tem hoje
// via prefetchRadio.
const STATION_INITIAL_BATCH = 8;

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
// Dono unico da moldura .st-feature__visual: o StationViz devolve so o
// <canvas>, entao visivel e fallback compartilham a mesma moldura.
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
// Exportado para testes (regressao de reatividade sob parent nao-keyed).
export function SeedChips(props: { station: Station }) {
  // Exibe nome + icone da station como chips de seed (MVP: 1 chip por station).
  // Accessor (nao const): FeatureCard vive sob <Show> nao-keyed, entao a
  // mesma instancia sobrevive a refetch() — os chips precisam re-derivar
  // quando props.station muda.
  const chips = (): { label: string; tone: Tone; icon: string }[] => [
    {
      label: props.station.desc || props.station.name,
      tone: (props.station.tone as Tone) || "tone-lavender",
      icon: props.station.icon || "lucide:radio",
    },
  ];
  return (
    <For each={chips()}>
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
        <Show when={props.station.stats.played > 0}>
          <div class="st-feature__eyebrow">Most played</div>
        </Show>
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
          <iconify-icon icon="lucide:play" noobserver />
          Play station
        </button>
      </div>
      <LazyStationViz />
    </section>
  );
}

// ── Station card individual ──────────────────────────────────────
// Exportado para testes (regressao de reatividade de seedLine).
export function StationCard(props: {
  station: Station;
  onResume: (id: string) => void;
  onDelete?: (id: string) => void;
}) {
  // Sem destructuring de props (quebra reatividade no Solid): station pode
  // trocar sob a mesma row.
  const seedLine = () => {
    if (props.station.kind !== "seed") return `mood · ${props.station.query ?? ""}`;
    const n = props.station.seed_track_ids.length;
    return `seed · ${n} ${n === 1 ? "track" : "tracks"}`;
  };

  // Exclusao e destrutiva e o card inteiro dispara play: 1o clique arma,
  // 2o confirma. Desarma sozinho em 4s pra nao ficar uma bomba engatilhada
  // esperando um clique distraido.
  //
  // O estado guarda o ID da station, nao um booleano: o <For> do grid nao e
  // keyed, entao a MESMA instancia do card recebe outra station quando a lista
  // muda (o refetch pos-delete faz exatamente isso). Com booleano, o card
  // ficava armado e o clique seguinte apagava a station ERRADA — mesmo motivo
  // pelo qual isFirst/seedLine derivam de props em vez de const.
  const [armedId, setArmedId] = createSignal<string | null>(null);
  const armed = () => armedId() === props.station.id;
  let disarmTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(disarmTimer));

  function handleDeleteClick(e: MouseEvent) {
    e.stopPropagation();
    clearTimeout(disarmTimer);
    if (!armed()) {
      setArmedId(props.station.id);
      disarmTimer = setTimeout(() => setArmedId(null), 4000);
      return;
    }
    setArmedId(null);
    props.onDelete?.(props.station.id);
  }

  // Tocar é um <button> próprio (o nome da station), irmão do de apagar: o
  // card como role=button deixava o apagar aninhado, e filhos de role=button
  // são apresentacionais (o Orca não anunciava o apagar). O ::after do botão
  // estende a área de clique ao card inteiro (extractor-lab.css).
  return (
    <div class="st-card">
      <button
        type="button"
        class={`st-card__delete${armed() ? " is-armed" : ""}`}
        title={armed() ? "Clique de novo para apagar" : "Apagar station"}
        aria-label={armed() ? `Confirmar exclusao de ${props.station.name}` : `Apagar ${props.station.name}`}
        onClick={handleDeleteClick}
      >
        <Show
          when={armed()}
          fallback={
            /* @ts-ignore */
            <iconify-icon icon="lucide:trash-2" noobserver />
          }
        >
          Apagar?
        </Show>
      </button>
      <div class="st-card__top">
        <div class={`st-card__cover ${props.station.tone}`}>
          {/* @ts-ignore */}
          <iconify-icon icon={props.station.icon} noobserver />
        </div>
        <div class="st-card__head">
          <button
            type="button"
            class="st-card__name st-card__play"
            aria-label={`Tocar station ${props.station.name}`}
            onClick={() => props.onResume(props.station.id)}
          >
            {props.station.name}
          </button>
          <span class="st-card__seed-line">{seedLine()}</span>
        </div>
      </div>
      <p class="st-card__desc">{props.station.desc}</p>
      <div class="st-card__stats">
        <span>{props.station.stats.played} played</span>
        {/* match_avg é declarado mas nunca escrito pelo backend: sem slot
            vazio enquanto não houver valor. */}
        <Show when={props.station.stats.match_avg != null}>
          <span>{`${Math.round(props.station.stats.match_avg! * 100)}% match`}</span>
        </Show>
        <span>last: {formatRelative(props.station.stats.last_played_at)}</span>
      </div>
    </div>
  );
}

// ── Painel de criacao de mood station ─────────────────────────────
// Chips multi-select de mood/activity (vocabulario buscado no mount via
// lib_mood_vocabulary — o MESMO vocabulario que MoodFilters::parse aceita,
// entao o round-trip nunca produz 0 resultados por divergencia PT/EN),
// select opcional de genero, nome com autoname sugerido pela selecao.
// Validacao: exige >=1 mood OU >=1 activity (senao MoodFilters::is_empty
// e a station nasce vazia).
function MoodStationCreator(props: { onCreated: () => void }) {
  const [vocab] = createResource(libMoodVocabulary);
  const [selectedMoods, setSelectedMoods] = createSignal<string[]>([]);
  const [selectedActivities, setSelectedActivities] = createSignal<string[]>([]);
  const [genre, setGenre] = createSignal("");
  const [customName, setCustomName] = createSignal("");

  function toggle(list: () => string[], setList: (v: string[]) => void, tag: string) {
    setList(list().includes(tag) ? list().filter((t) => t !== tag) : [...list(), tag]);
  }

  const autoName = () => [...selectedMoods(), ...selectedActivities()].join(" · ");
  const canCreate = () => selectedMoods().length > 0 || selectedActivities().length > 0;

  async function handleCreate() {
    if (!canCreate()) return;
    const tokens = [...selectedMoods(), ...selectedActivities()];
    // MoodFilters::parse (Rust) reconhece genero via bigram/token exato sobre
    // a string em minusculas — "Funk & Soul" so bate no bigram "funk soul"
    // (sem "&"); mandando o "&" cru, o bigram nao bate e os TOKENS soltos
    // "funk"/"soul" caem no ramo de single-token errado ("funk" sozinho vira
    // "Funk Brasileiro"). Remover " & " evita a tokenizacao ambigua sem
    // tocar no parser (fora de escopo — ver CLAUDE.md).
    const genreQuery = genre().replace(/\s*&\s*/g, " ");
    const query = genre() ? `${tokens.join(" ")} ${genreQuery}` : tokens.join(" ");
    const name = customName().trim() || autoName();
    try {
      await libCreateStation({
        name,
        kind: "mood",
        query,
        icon: "lucide:sparkles",
        tone: "tone-mint",
        desc: query,
      });
      setSelectedMoods([]);
      setSelectedActivities([]);
      setGenre("");
      setCustomName("");
      props.onCreated();
    } catch (err) {
      console.error("[stations] criar mood station falhou:", err);
    }
  }

  return (
    <div class="st-mood-create">
      <div class="st-mood-create__group">
        <span class="st-mood-create__label">Mood</span>
        <div class="st-mood-create__chips">
          <For each={vocab()?.moods ?? []}>
            {(m) => (
              <button
                type="button"
                class={`chip${selectedMoods().includes(m) ? " active" : ""}`}
                aria-pressed={selectedMoods().includes(m) ? "true" : "false"}
                onClick={() => toggle(selectedMoods, setSelectedMoods, m)}
              >
                {m}
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="st-mood-create__group">
        <span class="st-mood-create__label">Activity</span>
        <div class="st-mood-create__chips">
          <For each={vocab()?.activities ?? []}>
            {(a) => (
              <button
                type="button"
                class={`chip${selectedActivities().includes(a) ? " active" : ""}`}
                aria-pressed={selectedActivities().includes(a) ? "true" : "false"}
                onClick={() => toggle(selectedActivities, setSelectedActivities, a)}
              >
                {a}
              </button>
            )}
          </For>
        </div>
      </div>
      <div class="st-mood-create__row">
        <select
          class="st-mood-create__genre"
          aria-label="Gênero"
          value={genre()}
          onChange={(e) => setGenre(e.currentTarget.value)}
        >
          <option value="">Qualquer genero</option>
          <For each={vocab()?.genres ?? []}>
            {(g) => <option value={g}>{g}</option>}
          </For>
        </select>
        <input
          class="st-mood-create__name"
          type="text"
          aria-label="Nome da station"
          placeholder={autoName() || "Nome da station"}
          value={customName()}
          onInput={(e) => setCustomName(e.currentTarget.value)}
        />
        <button
          type="button"
          class="st-feature__cta"
          disabled={!canCreate()}
          onClick={handleCreate}
        >
          Criar mood station
        </button>
      </div>
    </div>
  );
}

// ── View principal ───────────────────────────────────────────────
export default function Stations() {
  const [stations, { refetch }] = createResource(libListStations);
  const [moodPanelOpen, setMoodPanelOpen] = createSignal(false);

  async function handleResume(id: string) {
    try {
      // Fase 2 do session-awareness: inicia a rodada (contextId novo,
      // seen/skipped zerados) ANTES de buscar o lote — startRadioSession
      // já reseta qualquer sessão anterior de outra station.
      const contextId = startRadioSession(id);
      // lib_play_station atualiza stats E retorna as tracks geradas —
      // a fila entra em scope "curated" (shuffle embaralha o contexto,
      // nao vira radio), lote inicial reduzido (fila incremental) e a
      // primeira track toca imediatamente.
      const tracks = await libPlayStation(id, STATION_INITIAL_BATCH);
      if (tracks.length > 0) {
        // source "station": continuações (auto-advance/skip) logam
        // origin="station" — régua e behavioral_signals dependem disso.
        // O nome alimenta o tooltip do chip de origem da PlayerBar.
        const name = stations()?.find((s) => s.id === id)?.name;
        setQueue(tracks, 0, "curated", { kind: "station", name });
        registerSeen(tracks.map((t) => t.id));
        playTrack(tracks[0], "station", contextId);
      }
      // Refetch para atualizar estatisticas de played/last_played_at.
      refetch();
    } catch (err) {
      console.error("[stations] play falhou:", err);
    }
  }

  async function handleDelete(id: string) {
    try {
      await libDeleteStation(id);
    } catch (err) {
      console.error("[stations] apagar falhou:", err);
    }
    // Refetch mesmo em erro: se o arquivo ja nao existia, a lista em tela
    // e que esta stale.
    refetch();
  }

  async function handleNewFromCurrent() {
    // Sem track tocando nao ha seed — nada a criar.
    const current = player.currentTrack;
    if (!current) return;
    try {
      await libCreateStation({
        name: `${current.title} radio`,
        kind: "seed",
        seedTrackIds: [current.id],
        icon: "lucide:radio",
        tone: "tone-sky",
        desc: current.artist_name
          ? `a partir de ${current.title} — ${current.artist_name}`
          : `a partir de ${current.title}`,
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
          {/* stations.latest mantém o último valor durante o refetch (play,
              criar, apagar): o número não pisca "—" a cada ação. */}
          <Show when={stations.latest} fallback={<span>—</span>}>
            {(list) => (
              <span>
                <b>{list().length}</b> stations
              </span>
            )}
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
            <div style={{ display: "flex", gap: "16px" }}>
              <button
                type="button"
                class="section__action"
                onClick={handleNewFromCurrent}
              >
                New from current track →
              </button>
              <button
                type="button"
                class="section__action"
                aria-expanded={moodPanelOpen() ? "true" : "false"}
                onClick={() => setMoodPanelOpen((v) => !v)}
              >
                {moodPanelOpen() ? "Fechar" : "Nova mood station"} →
              </button>
            </div>
          </div>
          <Show when={moodPanelOpen()}>
            <MoodStationCreator
              onCreated={() => {
                setMoodPanelOpen(false);
                refetch();
              }}
            />
          </Show>
          <div class="st-grid">
            <Show
              when={(stations()?.length ?? 0) > 0}
              fallback={
                <For each={Array.from({ length: 6 })}>
                  {() => (
                    <div class="st-card" style={{ opacity: "0.35" }}>
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
                        <span>last: —</span>
                      </div>
                    </div>
                  )}
                </For>
              }
            >
              <For each={stations()}>
                {(s) => (
                  <StationCard
                    station={s}
                    onResume={handleResume}
                    onDelete={handleDelete}
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
