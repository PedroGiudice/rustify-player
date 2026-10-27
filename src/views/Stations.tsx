/* ============================================================
   views/Stations.tsx — Smart radio stations, hi-fi.

   Destaque (a station mais tocada: lib_list_stations ordena por played
   desc) com título, CTA e o retrato da station: as capas das faixas-
   semente em leque (seed) ou as palavras do clima (mood). O destaque
   sai da grade logo abaixo, que lista as demais. Nada aqui afirma que
   uma station esta tocando: a tela nao consulta isso.
   ============================================================ */

import { createResource, createSignal, For, onCleanup, Show } from "solid-js";
import { Icon, ICONS } from "../components/Icon";
import {
  libListStations,
  libPlayStation,
  libCreateStation,
  libDeleteStation,
  libMoodVocabulary,
  libGetTracksByIds,
  coverUrl,
  Station,
  Track,
} from "../tauri";
import { player, setQueue } from "../store/player";
import { playTrack } from "../components/PlayerBar";
import { startRadioSession, registerSeen } from "../store/radioSession";
import { relTime } from "../lib/format";

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

// ── Texto que repete o nome não aparece de novo ──────────────────
// "chill · romance" e "chill romance" são a mesma coisa para quem lê:
// compara as palavras (sem acento, caixa ou pontuação). Repete = todas as
// palavras do texto já estão no nome.
function words(s: string | null | undefined): string[] {
  return (s ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function repeatsName(
  text: string | null | undefined,
  ...names: (string | null | undefined)[]
): boolean {
  const t = words(text);
  if (t.length === 0) return true;
  const known = new Set(names.flatMap(words));
  return t.every((w) => known.has(w));
}

/** Palavras do clima de uma mood station, na ordem da query, sem repetir. */
export function moodWords(query: string | null | undefined): string[] {
  return Array.from(new Set((query ?? "").split(/\s+/).filter(Boolean)));
}

// ── Apagar station: 1o clique arma, 2o confirma ──────────────────
// Exclusao e destrutiva e o card inteiro dispara play: desarma sozinho em
// 4s pra nao ficar uma bomba engatilhada esperando um clique distraido.
//
// O estado guarda o ID da station, nao um booleano: o <For> do grid nao e
// keyed, entao a MESMA instancia do card recebe outra station quando a lista
// muda (o refetch pos-delete faz exatamente isso). Com booleano, o card
// ficava armado e o clique seguinte apagava a station ERRADA.
function DeleteStationButton(props: {
  station: Station;
  onDelete?: (id: string) => void;
  class?: string;
}) {
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

  return (
    <button
      type="button"
      class={`st-card__delete${props.class ? ` ${props.class}` : ""}${armed() ? " is-armed" : ""}`}
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
  );
}

// ── Leque das capas das faixas-semente ───────────────────────────
// Até 5 capas, a do centro maior e por cima; as de fora menores e giradas.
// Exportado para testes.
const FAN_MAX = 5;

export function SeedMosaic(props: { station: Station }) {
  const ids = () => props.station.seed_track_ids.slice(0, FAN_MAX);
  // Uma chamada por destaque. A ordem é a das sementes, não a do backend.
  const [tracks] = createResource(
    () => ids().join(","),
    async (key): Promise<Track[]> => {
      if (!key) return [];
      const want = key.split(",");
      const got = (await libGetTracksByIds(want)) ?? [];
      const byId = new Map(got.map((t) => [String(t.id), t]));
      return want.map((id) => byId.get(id)).filter((t): t is Track => !!t);
    },
  );
  // Enquanto carrega, as vagas já ocupam o lugar (sem salto de layout).
  const slots = (): (Track | null)[] =>
    tracks.loading ? ids().map(() => null) : (tracks() ?? []);
  const total = () => props.station.seed_track_ids.length;

  function slotStyle(i: number, n: number) {
    const c = (n - 1) / 2;
    const d = Math.abs(i - c);
    return {
      "--fan-size": `${Math.round(64 - d * 10)}px`,
      "--fan-rot": `${((i - c) * 5).toFixed(1)}deg`,
      "--fan-z": String(10 - Math.round(d * 2)),
    };
  }

  const caption = () => {
    const shown = slots().length;
    if (total() > shown) return `nasce de ${total()} faixas; aqui, ${shown} delas`;
    return shown === 1 ? "nasce desta faixa" : `nasce destas ${shown} faixas`;
  };

  return (
    <Show
      when={slots().length > 0}
      fallback={
        <div class={`st-fan__solo ${props.station.tone}`} aria-hidden="true">
          {/* @ts-ignore */}
          <iconify-icon icon={props.station.icon || "lucide:radio"} noobserver />
        </div>
      }
    >
      <ul class="st-fan" aria-label="Faixas-semente">
        <For each={slots()}>
          {(t, i) => {
            const label = () => (t ? [t.title, t.artist_name].filter(Boolean).join(" — ") : "");
            const src = () => (t ? coverUrl(t.album_cover_path) : null);
            return (
              <li
                class={`st-fan__item${src() ? "" : ` ${props.station.tone}`}`}
                style={slotStyle(i(), slots().length)}
                title={label() || undefined}
              >
                <Show
                  when={src()}
                  fallback={
                    <span
                      class="st-fan__ph"
                      role={label() ? "img" : undefined}
                      aria-label={label() || undefined}
                    >
                      {/* @ts-ignore */}
                      <iconify-icon icon={ICONS.tracks} noobserver />
                    </span>
                  }
                >
                  {(u) => <img src={u()} alt={label()} loading="lazy" decoding="async" />}
                </Show>
              </li>
            );
          }}
        </For>
      </ul>
      <p class="st-feature__caption">{caption()}</p>
    </Show>
  );
}

// ── Palavras do clima (mood station) ─────────────────────────────
export function MoodWords(props: { station: Station }) {
  const list = () => moodWords(props.station.query || props.station.desc);
  return (
    <Show when={list().length > 0}>
      <ul class="st-feature__words" aria-label="Clima">
        <For each={list()}>{(w) => <li class="st-feature__word">{w}</li>}</For>
      </ul>
      <p class="st-feature__caption">nasce destas palavras</p>
    </Show>
  );
}

// ── Feature card — primeira station (mais tocada) ────────────────
function FeatureCard(props: {
  station: Station;
  onResume: (id: string) => void;
  onDelete?: (id: string) => void;
}) {
  // A dica some quando só repete o nome (ou o clima, que já aparece ao lado).
  const hint = () => {
    const d = props.station.desc;
    return repeatsName(d, props.station.name, props.station.query) ? null : d;
  };
  return (
    <section class="st-feature">
      {/* Fora da grade, o destaque é o único lugar de apagar esta station. */}
      <DeleteStationButton
        station={props.station}
        onDelete={props.onDelete}
        class="st-feature__delete"
      />
      <div>
        <Show when={props.station.stats.played > 0}>
          <div class="st-feature__eyebrow">Most played</div>
        </Show>
        <h2 class="st-feature__title">{props.station.name}</h2>
        <Show when={hint()}>
          <p class="st-feature__hint">{hint()}</p>
        </Show>
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
      <div class="st-feature__visual">
        <Show
          when={props.station.kind === "mood"}
          fallback={<SeedMosaic station={props.station} />}
        >
          <MoodWords station={props.station} />
        </Show>
      </div>
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
    if (props.station.kind !== "seed") return null;
    const n = props.station.seed_track_ids.length;
    return `${n} ${n === 1 ? "faixa-semente" : "faixas-semente"}`;
  };
  // A descrição só aparece quando diz algo além do nome.
  const desc = () =>
    repeatsName(props.station.desc, props.station.name) ? null : props.station.desc;

  // Tocar é um <button> próprio (o nome da station), irmão do de apagar: o
  // card como role=button deixava o apagar aninhado, e filhos de role=button
  // são apresentacionais (o Orca não anunciava o apagar). O ::after do botão
  // estende a área de clique ao card inteiro (extractor-lab.css).
  return (
    <div class="st-card">
      <DeleteStationButton station={props.station} onDelete={props.onDelete} />
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
            title={props.station.name}
            onClick={() => props.onResume(props.station.id)}
          >
            <span class="st-card__name-text">{props.station.name}</span>
          </button>
          <Show when={seedLine()}>
            <span class="st-card__seed-line">{seedLine()}</span>
          </Show>
        </div>
      </div>
      <Show when={desc()}>
        <p class="st-card__desc">{desc()}</p>
      </Show>
      <div class="st-card__stats">
        <span>{props.station.stats.played} played</span>
        {/* match_avg é declarado mas nunca escrito pelo backend: sem slot
            vazio enquanto não houver valor. */}
        <Show when={props.station.stats.match_avg != null}>
          <span>{`${Math.round(props.station.stats.match_avg! * 100)}% match`}</span>
        </Show>
        <span>
          {props.station.stats.last_played_at
            ? `tocou ${relTime(props.station.stats.last_played_at)}`
            : "nunca tocou"}
        </span>
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
        <span class="select-shell">
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
        <Icon class="select-shell__chev" name={ICONS.chevronDown} size={14} />
        </span>
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
            Rádios montadas a partir do que você ouve.
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
            <section class="st-feature st-feature--solo">
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
            </section>
          }
        >
          <FeatureCard
            station={stations()![0]}
            onResume={handleResume}
            onDelete={handleDelete}
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
              {/* A primeira já está no destaque: a grade lista as demais. */}
              <For each={stations()!.slice(1)}>
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
