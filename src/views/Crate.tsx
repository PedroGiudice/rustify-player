/* ============================================================
   views/Crate.tsx — busca e download da rede Soulseek in-app.

   Fluxo (spec §4): digitar → escolher a faixa → um clique → a
   linha vira `▸ Tocar`. Busca NUNCA dispara on-input (⏎ ou botão
   apenas — guard-rail contra rajada na rede real, spec §6.1).

   Busca é poll de ciclo CURTO, atado a esta view (setInterval
   morto no onCleanup). A fila (jobs) é ciclo LONGO — vem do store
   global (store/crate.ts), que sobrevive a esta view desmontar
   (é o que alimenta o badge da sidebar).
   ============================================================ */

import {
  createSignal, createMemo, For, Show, onMount, onCleanup,
} from "solid-js";
import {
  slskStatus, slskSearch, slskResults, slskCancelSearch, slskDedupProbe,
  slskDownload, slskTryOtherSource, slskCancel,
  parseSlskSearchError, libListFolders, libGetTracksByIds, formatDuration,
  type SlskStatus, type SearchSnapshot, type ResultGroup, type Candidate,
  type DownloadJob, type FolderPlaylist, type Track, type RejectReason,
} from "../tauri";
import { jobs, activeCount, bootCrateStore, loadLastDest, saveLastDest } from "../store/crate";
import { playTrack } from "../components/PlayerBar";
import { Icon, ICONS } from "../components/Icon";
import { revealItemInDir } from "@tauri-apps/plugin-opener";

const POLL_MS = 800;

// Estados de linha (idle/owned + os 10 estados não-canceled de JobState —
// "canceled" é tratado como idle: o usuário pode baixar de novo).
type RowState =
  | "idle" | "owned"
  | "queued" | "enqueued" | "downloading" | "stalled" | "processing" | "indexing"
  | "ready" | "rejected" | "manual" | "failed";

function deriveRowState(group: ResultGroup, job: DownloadJob | null): RowState {
  if (job && job.state.kind !== "canceled") return job.state.kind as RowState;
  if (group.owned) return "owned";
  return "idle";
}

function isAlreadyOwnedReason(r: RejectReason): r is { already_owned: { track_id: string } } {
  return typeof r === "object" && r !== null && "already_owned" in r;
}

function rejectReasonText(reason: RejectReason): string {
  if (isAlreadyOwnedReason(reason)) return "já tinhas — o arquivo ficou em downloads";
  if (reason === "bit32_unsupported") return "FLAC 32-bit — o player não decodifica";
  if (reason === "corrupt") return "arquivo inválido (corrompido)";
  return "arquivo inválido";
}

function formatSpeed(bps: number): string {
  if (bps >= 1_000_000) return `${(bps / 1_000_000).toFixed(1)} MB/s`;
  return `${Math.max(0, Math.round(bps / 1000))} KB/s`;
}

function formatAgo(secs: number): string {
  if (secs < 60) return `${secs}s`;
  return `${Math.round(secs / 60)} min`;
}

async function playById(trackId: string) {
  try {
    const tracks = await libGetTracksByIds([trackId]);
    if (tracks[0]) playTrack(tracks[0], "crate");
  } catch (e) {
    console.error("[crate] playById falhou:", e);
  }
}

/** Estado `manual` (spec §5.2 degrau 3 — slskd não reportou path local e a
    varredura não achou o arquivo por basename/mtime): abre o gerenciador de
    arquivos na pasta downloads via `opener:allow-reveal-item-in-dir` (única
    permissão do plugin concedida — sem open-url/open-path genérico, spec
    R15 superfície mínima). Falha (plataforma sem suporte, path inválido) →
    fallback pro clipboard, nunca quebra o clique. */
async function openManualPath(path: string) {
  try {
    await revealItemInDir(path);
  } catch (e) {
    console.warn("[crate] revealItemInDir falhou, copiando caminho:", e);
    try { await navigator.clipboard?.writeText(path); } catch {}
  }
}

// ── Destino: chip "→ <playlist> ▾" com popover de pastas ─────────
function DestChip(props: {
  value: string | null;
  placeholder: string;
  folders: FolderPlaylist[];
  warn?: boolean;
  open: boolean;
  onToggle: () => void;
  onPick: (folder: string) => void;
}) {
  return (
    <div class="crate-dest">
      <button
        type="button"
        class={`crate-dest__btn${props.warn ? " crate-dest__btn--warn" : ""}`}
        onClick={(e) => { e.stopPropagation(); props.onToggle(); }}
      >
        → {props.value ?? props.placeholder} <Icon name={ICONS.chevronDown} size={11} />
      </button>
      <Show when={props.open}>
        <div class="crate-dest__menu" onClick={(e) => e.stopPropagation()}>
          <Show when={props.folders.length === 0}>
            <div class="crate-dest__opt" style={{ opacity: 0.6, cursor: "default" }}>
              nenhuma playlist ainda
            </div>
          </Show>
          <For each={props.folders}>
            {(f) => (
              <button type="button" class="crate-dest__opt" onClick={() => props.onPick(f.name)}>
                {f.name}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}

// ── Linha de resultado (um ResultGroup agregado) ──────────────────
function CrateRow(props: {
  group: ResultGroup;
  job: DownloadJob | null;
  dest: string | null;
  isSelected: boolean;
  isExpanded: boolean;
  folders: FolderPlaylist[];
  onSelect: () => void;
  onToggleExpand: () => void;
  onDownload: (sourceId: string, dest: string) => void;
  onPickDest: (dest: string) => void;
  onCancel: (jobId: string) => void;
  onTrySource: (jobId: string) => void;
  onGoToOwned: (trackId: string) => void;
}) {
  const [destOpen, setDestOpen] = createSignal(false);
  const state = createMemo<RowState>(() => deriveRowState(props.group, props.job));
  const sourceCount = () => props.group.alternates.length + 1;

  // Texto do status (coluna aux) — um único memo por estado evita
  // repetir os `props.job!.state.kind === X` em cada branch do JSX.
  const statusText = createMemo<string | null>(() => {
    const j = props.job;
    switch (state()) {
      case "queued": return "aguardando vaga";
      case "enqueued": {
        const pos = j && j.state.kind === "enqueued" ? j.state.queue_position : null;
        return pos != null ? `na fila do peer · posição ${pos}` : "na fila do peer";
      }
      case "stalled":
        return j && j.state.kind === "stalled" ? `sem progresso há ${formatAgo(j.state.since_secs)}` : null;
      case "processing": return "organizando…";
      case "indexing": return "indexando…";
      case "ready": return `em ${j?.dest_playlist ?? props.dest ?? "—"}`;
      case "rejected":
        return j && j.state.kind === "rejected" ? rejectReasonText(j.state.reason) : null;
      case "manual":
        return j && j.state.kind === "manual" ? `baixou, não achei o arquivo — está em ${j.state.path}` : null;
      case "failed":
        return j && j.state.kind === "failed" ? `falhou: ${j.state.reason}` : null;
      default: return null;
    }
  });

  const isAlreadyOwnedRejection = createMemo(() => {
    const j = props.job;
    return !!(j && j.state.kind === "rejected" && isAlreadyOwnedReason(j.state.reason));
  });

  return (
    <>
      <div
        class="crate-row"
        data-state={state()}
        data-selected={props.isSelected ? "true" : "false"}
        onClick={props.onSelect}
      >
        <div class="crate-row__fmt-status">
          <Show
            when={state() === "owned"}
            fallback={<span class="badge-fmt">{props.group.quality_label}</span>}
          >
            <span class="chip active">no acervo</span>
          </Show>
        </div>

        <div class="crate-row__meta">
          <div class="crate-row__title">{props.group.display_title}</div>
          <div class="crate-row__sub">
            {props.group.display_artist ?? "—"}
            {props.group.album_hint ? ` · ${props.group.album_hint}` : ""}
          </div>
        </div>

        <div class="crate-row__aux">
          <Show when={state() === "idle" || state() === "owned"}>
            <button
              type="button"
              class="crate-row__sources"
              onClick={(e) => { e.stopPropagation(); props.onToggleExpand(); }}
            >
              {sourceCount()} fontes {props.isExpanded ? "▴" : "▾"}
            </button>
          </Show>
          <Show when={state() === "idle"}>
            <DestChip
              value={props.dest}
              placeholder="escolher"
              warn={!props.dest}
              open={destOpen()}
              folders={props.folders}
              onToggle={() => setDestOpen((v) => !v)}
              onPick={(f) => { props.onPickDest(f); setDestOpen(false); }}
            />
          </Show>
          <Show when={statusText()}>
            <span class="crate-row__status">{statusText()}</span>
          </Show>
          <Show when={props.group.duration_secs != null}>
            <span class="row__time">{formatDuration(props.group.duration_secs!)}</span>
          </Show>
        </div>

        <div class="crate-row__action-cell">
          <Show when={state() === "idle"}>
            <button
              type="button"
              class="pl-action-btn crate-row__action"
              onClick={(e) => {
                e.stopPropagation();
                if (!props.dest) { setDestOpen(true); return; }
                props.onDownload(props.group.best.id, props.dest);
              }}
            >
              <Icon name={ICONS.download} size={13} /> Baixar
            </button>
          </Show>
          <Show when={state() === "owned"}>
            <button
              type="button"
              class="pl-action-btn crate-row__action"
              onClick={(e) => { e.stopPropagation(); props.onGoToOwned(props.group.owned!.track_id); }}
            >
              <Icon name={ICONS.play} size={13} /> Tocar
            </button>
          </Show>
          <Show when={state() === "ready"}>
            <button
              type="button"
              class="pl-action-btn crate-row__action"
              onClick={(e) => {
                e.stopPropagation();
                if (props.job && props.job.state.kind === "ready") playById(props.job.state.track_id);
              }}
            >
              <Icon name={ICONS.play} size={13} /> Tocar
            </button>
          </Show>
          <Show when={state() === "queued" || state() === "enqueued" || state() === "downloading"}>
            <button
              type="button"
              class="pl-action-btn crate-row__action"
              onClick={(e) => { e.stopPropagation(); if (props.job) props.onCancel(props.job.job_id); }}
            >
              Cancelar
            </button>
          </Show>
          <Show when={state() === "stalled" || state() === "failed" || (state() === "rejected" && !isAlreadyOwnedRejection())}>
            <button
              type="button"
              class="pl-action-btn crate-row__action"
              onClick={(e) => { e.stopPropagation(); if (props.job) props.onTrySource(props.job.job_id); }}
            >
              <Icon name={ICONS.refresh} size={13} /> Trocar fonte
            </button>
          </Show>
          <Show when={state() === "rejected" && isAlreadyOwnedRejection()}>
            <button
              type="button"
              class="pl-action-btn crate-row__action"
              onClick={(e) => {
                e.stopPropagation();
                if (props.job && props.job.state.kind === "rejected" && isAlreadyOwnedReason(props.job.state.reason)) {
                  props.onGoToOwned(props.job.state.reason.already_owned.track_id);
                }
              }}
            >
              Ir pra faixa
            </button>
          </Show>
          <Show when={state() === "manual"}>
            <button
              type="button"
              class="pl-action-btn crate-row__action"
              onClick={(e) => {
                e.stopPropagation();
                if (props.job && props.job.state.kind === "manual") {
                  openManualPath(props.job.state.path);
                }
              }}
              title="Abre a pasta no gerenciador de arquivos"
            >
              <Icon name={ICONS.folderOpen} size={13} /> Abrir pasta
            </button>
          </Show>
        </div>
      </div>

      <Show when={props.isExpanded}>
        <div class="crate-row__alt-list">
          <For each={[props.group.best, ...props.group.alternates]}>
            {(c: Candidate) => (
              <div class="crate-row__alt">
                <span class="crate-row__alt-name">{c.username}</span>
                <span class="crate-row__alt-path mono">{c.filename}</span>
                <span>{c.free_slot ? "livre" : `fila ${c.queue_length}`}</span>
                <Show when={c.warn}><span>⚠ {c.warn}</span></Show>
                <button
                  type="button"
                  onClick={() => {
                    // Sem dest resolvido, mesmo comportamento do [Baixar]
                    // (spec §4.5 caso 4): abre o seletor em vez de ficar
                    // silencioso (minor da review da Etapa D).
                    if (props.dest) props.onDownload(c.id, props.dest);
                    else setDestOpen(true);
                  }}
                >
                  Usar
                </button>
              </div>
            )}
          </For>
        </div>
      </Show>
    </>
  );
}

// ── Linha da fila (Job) ────────────────────────────────────────
function CrateJobRow(props: { job: DownloadJob; onCancel: () => void; onTrySource: () => void }) {
  const kind = () => props.job.state.kind;

  const statusText = createMemo<string>(() => {
    const j = props.job;
    switch (j.state.kind) {
      case "queued": return "aguardando vaga";
      case "enqueued":
        return j.state.queue_position != null ? `na fila do peer · posição ${j.state.queue_position}` : "na fila do peer";
      case "downloading":
        return `${Math.round(j.state.pct)}% · ${formatSpeed(j.state.bps)}`;
      case "stalled": return `sem progresso há ${formatAgo(j.state.since_secs)}`;
      case "processing": return "organizando…";
      case "indexing": return "indexando…";
      case "ready": return `em ${j.dest_playlist}`;
      case "rejected": return rejectReasonText(j.state.reason);
      case "manual": return `está em ${j.state.path}`;
      case "failed": return `falhou: ${j.state.reason}`;
      case "canceled": return "cancelado";
    }
  });

  return (
    <div class="crate-job" data-state={kind()}>
      <div>
        <div class="crate-job__title">{props.job.display}</div>
        <div class="crate-job__status">{statusText()}</div>
        <Show when={props.job.state.kind === "downloading"}>
          <div class="progress crate-job__progress">
            <div
              class="progress__fill"
              style={{ width: `${props.job.state.kind === "downloading" ? props.job.state.pct : 0}%` }}
            />
          </div>
        </Show>
      </div>
      <div>
        <Show when={kind() === "queued" || kind() === "enqueued" || kind() === "downloading"}>
          <button type="button" class="pl-action-btn crate-row__action" onClick={props.onCancel}>
            Cancelar
          </button>
        </Show>
        <Show when={kind() === "stalled" || kind() === "failed"}>
          <button type="button" class="pl-action-btn crate-row__action" onClick={props.onTrySource}>
            <Icon name={ICONS.refresh} size={13} /> Trocar fonte
          </button>
        </Show>
        <Show when={props.job.state.kind === "ready"}>
          <button
            type="button"
            class="pl-action-btn crate-row__action"
            onClick={() => { if (props.job.state.kind === "ready") playById(props.job.state.track_id); }}
          >
            <Icon name={ICONS.play} size={13} /> Tocar
          </button>
        </Show>
        <Show when={props.job.state.kind === "manual"}>
          <button
            type="button"
            class="pl-action-btn crate-row__action"
            onClick={() => { if (props.job.state.kind === "manual") openManualPath(props.job.state.path); }}
            title="Abre a pasta no gerenciador de arquivos"
          >
            <Icon name={ICONS.folderOpen} size={13} /> Abrir pasta
          </button>
        </Show>
      </div>
    </div>
  );
}

// ── View principal ─────────────────────────────────────────────
export default function Crate(props: { param?: string | null }) {
  const [tab, setTab] = createSignal<"search" | "queue">("search");
  const [query, setQuery] = createSignal(props.param ? decodeURIComponent(props.param) : "");
  const [searchId, setSearchId] = createSignal<string | null>(null);
  const [snapshot, setSnapshot] = createSignal<SearchSnapshot | null>(null);
  const [searching, setSearching] = createSignal(false);
  const [status, setStatus] = createSignal<SlskStatus | null>(null);
  const [cooldown, setCooldown] = createSignal<{ kind: "cooldown" | "cold"; seconds: number } | null>(null);
  const [dedupTrack, setDedupTrack] = createSignal<Track | null>(null);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  const [expandedKey, setExpandedKey] = createSignal<string | null>(null);
  const [folders, setFolders] = createSignal<FolderPlaylist[]>([]);
  // NUNCA semear com loadLastDest() (bug IM-D1, review da Etapa D): isso
  // promove o nível 3 da precedência (último destino usado) a nível 1
  // (override da toolbar), fazendo suggested_dest — artista já no acervo,
  // nível 2 — nunca vencer até o usuário clicar no ×. `null` = toolbar sem
  // override; loadLastDest() só entra como fallback dentro de resolvedDest.
  const [destOverride, setDestOverride] = createSignal<string | null>(null);
  const [toolbarDestOpen, setToolbarDestOpen] = createSignal(false);
  const [rowOverrides, setRowOverrides] = createSignal<Record<string, string>>({});
  const [groupJobs, setGroupJobs] = createSignal<Record<string, string>>({});

  let inputEl!: HTMLInputElement;
  let pollTimer: ReturnType<typeof setInterval> | undefined;

  const groups = () => snapshot()?.groups ?? [];

  function resolvedDest(g: ResultGroup): string | null {
    return destOverride() ?? rowOverrides()[g.group_key] ?? g.suggested_dest ?? loadLastDest();
  }

  function jobFor(groupKey: string): DownloadJob | null {
    const id = groupJobs()[groupKey];
    if (!id) return null;
    return jobs().find((j) => j.job_id === id) ?? null;
  }

  async function doSearch(force = false) {
    const q = query().trim();
    if (!q) return;
    const prevId = searchId();
    if (prevId) slskCancelSearch(prevId).catch(() => {});
    setCooldown(null);
    setSearching(true);
    setDedupTrack(null);
    try {
      const id = await slskSearch(q, force);
      setSearchId(id);
      setSnapshot(null);
      setSelectedIndex(0);
      setExpandedKey(null);
      setGroupJobs({});
      setRowOverrides({});
      slskDedupProbe(q).then((tracks) => setDedupTrack(tracks[0] ?? null)).catch(() => setDedupTrack(null));
      const snap = await slskResults(id);
      setSnapshot(snap);
      setSearching(snap.state === "running");
    } catch (e) {
      setSearching(false);
      const parsed = parseSlskSearchError(e);
      if (parsed.kind === "cooldown" || parsed.kind === "cold") {
        setCooldown({ kind: parsed.kind, seconds: parsed.seconds ?? 0 });
      }
    }
  }

  async function handleDownload(g: ResultGroup, sourceId: string, dest: string) {
    const id = searchId();
    if (!id) return;
    try {
      const jobId = await slskDownload(id, g.group_key, sourceId, dest);
      setGroupJobs((m) => ({ ...m, [g.group_key]: jobId }));
      saveLastDest(dest);
    } catch (e) {
      console.error("[crate] slskDownload falhou:", e);
    }
  }

  async function handleCancel(jobId: string) {
    try { await slskCancel(jobId); } catch (e) { console.error("[crate] slskCancel falhou:", e); }
  }

  async function handleTrySource(jobId: string) {
    try { await slskTryOtherSource(jobId); } catch (e) { console.error("[crate] slskTryOtherSource falhou:", e); }
  }

  function handleGlobalKey(e: KeyboardEvent) {
    const inInput = document.activeElement === inputEl;
    if (e.key === "Escape") {
      if (inInput) inputEl.blur();
      setExpandedKey(null);
      return;
    }
    if (inInput || tab() !== "search") return;
    const list = groups();
    if (e.key === "ArrowDown") { e.preventDefault(); setSelectedIndex((i) => Math.min(list.length - 1, i + 1)); return; }
    if (e.key === "ArrowUp") { e.preventDefault(); setSelectedIndex((i) => Math.max(0, i - 1)); return; }
    if (e.key === "ArrowRight") {
      const g = list[selectedIndex()];
      if (g) { e.preventDefault(); setExpandedKey(g.group_key); }
      return;
    }
    if (e.key === "Backspace") {
      const g = list[selectedIndex()];
      const job = g ? jobFor(g.group_key) : null;
      if (job) { e.preventDefault(); handleCancel(job.job_id); }
      return;
    }
    if (e.key === "Enter") {
      const g = list[selectedIndex()];
      if (!g) return;
      e.preventDefault();
      const job = jobFor(g.group_key);
      const st = deriveRowState(g, job);
      if (st === "owned" && g.owned) { playById(g.owned.track_id); return; }
      if (st === "ready" && job && job.state.kind === "ready") { playById(job.state.track_id); return; }
      if (st === "idle") {
        const dest = resolvedDest(g);
        if (dest) handleDownload(g, g.best.id, dest);
      }
    }
  }

  onMount(() => {
    bootCrateStore();
    libListFolders().then(setFolders).catch(() => {});
    slskStatus().then(setStatus).catch(() => {});

    pollTimer = setInterval(() => {
      const id = searchId();
      if (id) {
        slskResults(id).then((snap) => {
          setSnapshot(snap);
          setSearching(snap.state === "running");
        }).catch(() => {});
      }
      slskStatus().then(setStatus).catch(() => {});
    }, POLL_MS);

    window.addEventListener("keydown", handleGlobalKey);

    onCleanup(() => {
      if (pollTimer) clearInterval(pollTimer);
      window.removeEventListener("keydown", handleGlobalKey);
      const id = searchId();
      if (id) slskCancelSearch(id).catch(() => {});
    });

    if (query().trim()) void doSearch();
  });

  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>Crate</h1>
          <p class="view__head-hint">Busque na rede e traga pro acervo.</p>
        </div>
        <div class="view__stats">
          <span><b>{activeCount()}</b> baixando</span>
        </div>
      </header>

      <nav class="tabs" role="tablist">
        <button class={`tab${tab() === "search" ? " active" : ""}`} onClick={() => setTab("search")}>
          Buscar <Show when={groups().length > 0}><span class="tab__count">{groups().length}</span></Show>
        </button>
        <button class={`tab${tab() === "queue" ? " active" : ""}`} onClick={() => setTab("queue")}>
          Fila <Show when={jobs().length > 0}><span class="tab__count">{jobs().length}</span></Show>
        </button>
      </nav>

      <div class="view__body">
        <Show when={tab() === "search"}>
          <div class="coll-toolbar crate-toolbar">
            <div class="coll-search">
              <Icon name={ICONS.search} size={14} />
              <input
                ref={inputEl}
                value={query()}
                placeholder="Buscar na rede Soulseek…"
                onInput={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); doSearch(false); } }}
              />
            </div>
            <button type="button" class="pl-action-btn" disabled={searching()} onClick={() => doSearch(false)}>
              {searching() ? "Buscando…" : "Buscar"}
            </button>
            <span class="crate-net-status" data-on={status()?.network_connected ? "true" : "false"}>
              <span class="sig-stat__dot" /> {status()?.message ?? "verificando…"}
            </span>
            <DestChip
              value={destOverride()}
              placeholder="destino padrão"
              open={toolbarDestOpen()}
              folders={folders()}
              onToggle={() => setToolbarDestOpen((v) => !v)}
              onPick={(f) => { setDestOverride(f); saveLastDest(f); setToolbarDestOpen(false); }}
            />
            <Show when={destOverride()}>
              <button type="button" class="crate-dest__clear" onClick={() => setDestOverride(null)} title="Limpar destino fixo">
                ×
              </button>
            </Show>
          </div>

          <Show when={cooldown()}>
            {(c) => (
              <div class="crate-banner" data-tone="amber">
                <span>
                  A rede Soulseek parou de responder — pausado por {formatAgo(c().seconds)}. Isso é da rede, não do app.
                </span>
                <button type="button" onClick={() => doSearch(true)}>Buscar mesmo assim</button>
              </div>
            )}
          </Show>

          <Show when={dedupTrack()}>
            {(t) => (
              <div class="crate-banner" data-tone="mint">
                <span>Já tens no acervo: {t().artist_name ?? "—"} — {t().title}</span>
                <button type="button" onClick={() => playTrack(t(), "crate")}>▸ Tocar</button>
              </div>
            )}
          </Show>

          <div class="row-list">
            <For each={groups()}>
              {(g, i) => (
                <CrateRow
                  group={g}
                  job={jobFor(g.group_key)}
                  dest={resolvedDest(g)}
                  isSelected={i() === selectedIndex()}
                  isExpanded={expandedKey() === g.group_key}
                  folders={folders()}
                  onSelect={() => setSelectedIndex(i())}
                  onToggleExpand={() => setExpandedKey((k) => (k === g.group_key ? null : g.group_key))}
                  onDownload={(sourceId, dest) => handleDownload(g, sourceId, dest)}
                  onPickDest={(dest) => setRowOverrides((m) => ({ ...m, [g.group_key]: dest }))}
                  onCancel={handleCancel}
                  onTrySource={handleTrySource}
                  onGoToOwned={playById}
                />
              )}
            </For>
          </div>

          <Show when={!searching() && snapshot() && groups().length === 0}>
            <div class="empty-state">
              <p class="empty-state__title">
                {snapshot()?.state === "failed" ? "Busca falhou" : "Nada encontrado"}
              </p>
              <p class="empty-state__hint">{snapshot()?.note ?? "a rede não devolveu resultados pra essa busca."}</p>
            </div>
          </Show>
        </Show>

        <Show when={tab() === "queue"}>
          <div class="row-list">
            <For each={jobs()}>
              {(j) => (
                <CrateJobRow
                  job={j}
                  onCancel={() => handleCancel(j.job_id)}
                  onTrySource={() => handleTrySource(j.job_id)}
                />
              )}
            </For>
          </div>
          <Show when={jobs().length === 0}>
            <div class="empty-state">
              <p class="empty-state__title">Fila vazia</p>
              <p class="empty-state__hint">Baixe algo na aba Buscar pra ver o progresso aqui.</p>
            </div>
          </Show>
        </Show>
      </div>
    </article>
  );
}
