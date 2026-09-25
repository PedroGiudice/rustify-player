/* ============================================================
   views/Crate.tsx — busca e download da rede Soulseek in-app.

   Fluxo (spec §4): digitar → escolher a faixa → um clique → a
   linha vira `▸ Tocar`. Busca NUNCA dispara on-input (⏎ ou botão
   apenas — guard-rail contra rajada na rede real, spec §6.1).

   Busca é poll de ciclo CURTO, atado a esta view (setInterval
   morto no onCleanup). A fila (jobs) é ciclo LONGO — vem do store
   global (store/crate.ts), que sobrevive a esta view desmontar
   (é o que alimenta o badge da sidebar).

   Camada visual = restyle v1.1, handoff
   docs/design-refs/design_handoff_crate/"Rustify Crate.html"
   (densidade compacta). Comportamento inalterado.
   ============================================================ */

import {
  createSignal, createMemo, createEffect, on, For, Show, onMount, onCleanup, batch, type JSX,
} from "solid-js";
import { route } from "../router";
import { createStore, reconcile } from "solid-js/store";
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

/** Id do seletor de destino da toolbar no `openDest` da view (as linhas
    usam o group_key, que sempre tem separador \u0001 — não colide). */
const TOOLBAR_DEST = "toolbar";

/** Poll de resultados — só enquanto a busca está `running` (crate-1). */
const POLL_MS = 800;
/** Status da rede muda devagar; consultar a cada poll de busca era
    desperdício (crate-1). */
const STATUS_POLL_MS = 5000;
/** Janela de uma busca no backend (`SEARCH_WINDOW`, coordinator.rs) — a
    barra de progresso da busca corre contra ela (spec §6.1). */
const SEARCH_WINDOW_MS = 25_000;

/** Circunferência do anel de cooldown (r=6) — casa com o
    stroke-dasharray:37.7 do handoff. */
const RING_LEN = 37.7;

// Estados de linha (idle/owned + os 10 estados não-canceled de JobState —
// "canceled" é tratado como idle: o usuário pode baixar de novo).
type RowState =
  | "idle" | "owned"
  | "queued" | "enqueued" | "downloading" | "stalled" | "processing" | "indexing"
  | "ready" | "rejected" | "manual" | "failed";

/** Estados não-terminais (mesma partição do store/crate.ts) — separa
    "Em voo" de "Terminadas" na aba Fila. */
const IN_FLIGHT = new Set<DownloadJob["state"]["kind"]>([
  "queued", "enqueued", "downloading", "stalled", "processing", "indexing",
]);

/** Estados em que a linha oferece [Cancelar] — o ⌫ do teclado cancela
    exatamente nos mesmos (crate-2: antes cancelava também stalled/
    processing, que a UI não deixa cancelar). */
const CANCELLABLE = new Set<DownloadJob["state"]["kind"]>(["queued", "enqueued", "downloading"]);

/** Há fonte ainda não tentada? Mesma regra do backend
    (`try_other_source_sync`: primeira alternativa fora de
    `tried_source_ids`). Sem ela, [Trocar fonte] seria um botão morto que
    só devolve "sem outras fontes" (crate-6). */
function hasUntriedSource(job: DownloadJob): boolean {
  return job.alternates.some((c) => !job.tried_source_ids.includes(c.id));
}

/** Respostas de erro do coordinator (strings fixas do backend, sem
    acento) → texto de tela. Desconhecido passa cru. */
const BACKEND_ERRORS: Record<string, string> = {
  "coordinator nao respondeu a tempo": "o serviço de downloads não respondeu a tempo",
  "coordinator indisponivel": "o serviço de downloads está indisponível",
  "busca desconhecida ou expirada": "a busca expirou, busque de novo",
  "grupo nao encontrado nessa busca": "a faixa não está mais nessa busca, busque de novo",
  "fonte nao encontrada nesse grupo": "essa fonte não está mais disponível, busque de novo",
  "destino de playlist invalido": "nome de playlist inválido",
  "job nao encontrado": "o download não existe mais",
  "sem outras fontes disponiveis": "não há outras fontes para tentar",
  "job em estado que nao aceita troca de fonte agora": "o download está num estado que não aceita troca de fonte agora",
};

function errorText(e: unknown): string {
  const raw =
    typeof e === "string"
      ? e
      : e && typeof e === "object" && "message" in e
        ? String((e as { message: unknown }).message)
        : String(e ?? "");
  return BACKEND_ERRORS[raw] ?? raw;
}

/** Aviso de erro em texto simples (crate-6) — reaproveita o banner âmbar
    do Crate, sem sistema de toast novo. */
function NoticeBanner(props: { text: string; onClose: () => void }) {
  return (
    <div class="crate-banner" data-tone="amber" role="alert">
      <Icon name={ICONS.alert} size={15} />
      <p>{props.text}</p>
      <span class="crate-banner__sp" />
      <button type="button" class="crate-banner__act" onClick={props.onClose}>
        Fechar
      </button>
    </div>
  );
}

/** Decodifica o param da rota sem explodir em `%` solto. */
function decodeParam(p: string): string {
  try { return decodeURIComponent(p); } catch { return p; }
}

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
  return `${Math.max(0, Math.round(bps / 1000))} kB/s`;
}

function formatAgo(secs: number): string {
  if (secs < 60) return `${secs}s`;
  return `${Math.round(secs / 60)} min`;
}

function formatEta(secs: number): string {
  if (secs < 60) return `~${Math.max(0, Math.round(secs))}s`;
  return `~${Math.round(secs / 60)}min`;
}

function formatSize(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

/** Rótulo de qualidade por candidato (o group.quality_label é o do
    `best`; cada peer pode ter outro bit depth/sample rate). */
function candidateQuality(c: Candidate, fallback: string): string {
  if (c.bit_depth != null && c.sample_rate != null) {
    return `FLAC ${c.bit_depth}/${Math.round(c.sample_rate / 1000)}`;
  }
  return fallback;
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

// ── Destino: chip "DESTINO → <playlist> ▾" com popover de pastas ──
function DestChip(props: {
  value: string | null;
  placeholder: string;
  folders: FolderPlaylist[];
  /** `toolbar` = caixa alta de 40px; `row` = pílula de 24px na linha. */
  variant: "toolbar" | "row";
  warn?: boolean;
  override?: boolean;
  open: boolean;
  onToggle: () => void;
  onPick: (folder: string) => void;
}) {
  return (
    <div class="crate-dest">
      <button
        type="button"
        class={
          (props.variant === "row" ? "crate-chip crate-dest__btn" : "crate-dest__btn")
          + (props.warn ? " crate-dest__btn--warn" : "")
        }
        data-override={props.override ? "true" : undefined}
        title={props.variant === "row" ? "Destino desta faixa" : "Destino de tudo que for baixado"}
        aria-haspopup="true"
        aria-expanded={props.open ? "true" : "false"}
        onClick={(e) => { e.stopPropagation(); props.onToggle(); }}
      >
        <Show when={props.variant === "toolbar"}>
          <span class="crate-dest__lbl">Destino</span>
        </Show>
        <span class="crate-dest__arrow">→</span>
        <span>{props.value ?? props.placeholder}</span>
        <Icon name={ICONS.chevronDown} size={12} />
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

/** Linha de estado (`.crate-r-state`) — full-width abaixo do conteúdo
    principal da row. Uma pill + texto(s); `null` no estado idle. */
function StateLine(props: { state: RowState; job: DownloadJob | null; owned: ResultGroup["owned"]; dest: string | null }): JSX.Element {
  const j = () => props.job;
  return (
    <Show when={props.state !== "idle"}>
      <div class="crate-r-state">
        <Show when={props.state === "owned"}>
          <span class="crate-pill crate-pill--own">
            <Icon name={ICONS.check} size={10} /> no acervo
          </span>
          <Show when={props.owned}>
            <span class="crate-st-dim">{props.owned!.artist} — {props.owned!.title}</span>
          </Show>
        </Show>

        <Show when={props.state === "queued"}>
          <span class="crate-pill crate-pill--warn">aguardando vaga</span>
        </Show>

        <Show when={props.state === "enqueued"}>
          <span class="crate-pill crate-pill--warn">na fila</span>
          {(() => {
            const job = j();
            const pos = job && job.state.kind === "enqueued" ? job.state.queue_position : null;
            return (
              <>
                <Show when={pos != null}>
                  <span class="crate-st-mono crate-st-txt--warn">fila do peer: {pos}</span>
                </Show>
                <span class="crate-st-dim">sem estimativa — o peer decide a ordem</span>
              </>
            );
          })()}
        </Show>

        <Show when={props.state === "downloading"}>
          {(() => {
            const job = j();
            if (!job || job.state.kind !== "downloading") return null;
            const st = job.state;
            return (
              <>
                <span class="crate-pill crate-pill--live">baixando</span>
                <div class="crate-prog"><i style={{ width: `${st.pct}%` }} /></div>
                <span class="crate-st-mono crate-st-txt--live">
                  {Math.round(st.pct)}% · {formatSpeed(st.bps)}
                  {st.eta_s != null ? ` · ${formatEta(st.eta_s)}` : ""}
                </span>
              </>
            );
          })()}
        </Show>

        <Show when={props.state === "stalled"}>
          <span class="crate-pill crate-pill--warn">travou</span>
          <Show when={j() && j()!.state.kind === "stalled"}>
            <span class="crate-st-txt--warn">
              sem progresso há {formatAgo((j()!.state as { since_secs: number }).since_secs)}
            </span>
          </Show>
        </Show>

        <Show when={props.state === "processing"}>
          <span class="crate-pill crate-pill--sub">organizando…</span>
        </Show>
        <Show when={props.state === "indexing"}>
          <span class="crate-pill crate-pill--sub">indexando…</span>
        </Show>

        <Show when={props.state === "ready"}>
          <span class="crate-pill crate-pill--ready">
            <Icon name={ICONS.check} size={10} /> pronta
          </span>
          <span class="crate-st-txt--ready">em {j()?.dest_playlist ?? props.dest ?? "—"}</span>
        </Show>

        <Show when={props.state === "rejected"}>
          <span class="crate-pill crate-pill--err">recusada</span>
          <Show when={j() && j()!.state.kind === "rejected"}>
            <span class="crate-st-txt--err">
              {rejectReasonText((j()!.state as { reason: RejectReason }).reason)}
            </span>
          </Show>
        </Show>

        <Show when={props.state === "manual"}>
          <span class="crate-pill crate-pill--warn">quase</span>
          <Show when={j() && j()!.state.kind === "manual"}>
            <span class="crate-st-txt--warn">
              baixou, não achei o arquivo — está em {(j()!.state as { path: string }).path}
            </span>
          </Show>
        </Show>

        <Show when={props.state === "failed"}>
          <span class="crate-pill crate-pill--err">falhou</span>
          <Show when={j() && j()!.state.kind === "failed"}>
            <span class="crate-st-txt--err">
              {(j()!.state as { reason: string }).reason}
            </span>
          </Show>
        </Show>
      </div>
    </Show>
  );
}

/** Painel de fontes (peers) de um grupo — header + uma linha por
    candidato, com o caminho remoto completo em mono. */
function SourcesPanel(props: {
  group: ResultGroup;
  onUse: (sourceId: string) => void;
}) {
  const byId = createMemo(
    () => new Map([props.group.best, ...props.group.alternates].map((c) => [c.id, c])),
  );
  // Ordem de CHEGADA, não de score: durante a busca o backend reordena os
  // candidatos a cada poll, e o 'Usar' sob o cursor passava a apontar pra
  // outro peer entre a mira e o clique (crate-v5). Peer novo entra no fim;
  // peer que sumiu sai. Linhas chaveadas pelo id (string), então o nó DOM
  // de cada peer também fica parado.
  const order = createMemo<string[]>((prev) => {
    const m = byId();
    const next = prev.filter((id) => m.has(id));
    for (const id of m.keys()) if (!next.includes(id)) next.push(id);
    return next.length === prev.length && next.every((id, i) => id === prev[i]) ? prev : next;
  }, []);

  return (
    <div class="crate-sources">
      <div class="crate-src-head">
        <div>Peer</div><div>Qualidade</div><div>Tamanho</div><div>Fila</div><div>Velocidade</div><div />
      </div>
      <For each={order()}>
        {(id) => (
          <Show when={byId().get(id)}>
            {(c: () => Candidate) => (
              <div class="crate-src" data-flag={c().warn ? "live" : undefined}>
                <div class="crate-src-peer">
                  <span class="nm">{c().username}</span>
                  <Show when={c().warn}>
                    <span class="crate-pill crate-pill--warn">⚠ {c().warn}</span>
                  </Show>
                </div>
                <span class="crate-badge">{candidateQuality(c(), props.group.quality_label)}</span>
                <div class="crate-src-val">{formatSize(c().size)}</div>
                <Show
                  when={c().free_slot}
                  fallback={<div class="crate-src-queued">fila {c().queue_length}</div>}
                >
                  <div class="crate-src-free">livre</div>
                </Show>
                <div class={`crate-src-val${c().upload_speed < 300_000 ? " crate-src-val--dim" : ""}`}>
                  {formatSpeed(c().upload_speed)}
                </div>
                <div class="crate-r-act">
                  <button type="button" class="crate-btn" onClick={(e) => { e.stopPropagation(); props.onUse(id); }}>
                    Usar
                  </button>
                </div>
                <div class="crate-src-path"><bdi>{c().filename}</bdi></div>
              </div>
            )}
          </Show>
        )}
      </For>
    </div>
  );
}

// ── Linha de resultado (um ResultGroup agregado) ──────────────────
function CrateRow(props: {
  group: ResultGroup;
  job: DownloadJob | null;
  dest: string | null;
  destOverridden: boolean;
  isSelected: boolean;
  isExpanded: boolean;
  folders: FolderPlaylist[];
  /** Estado do seletor vive na view (um aberto por vez, sobrevive ao
      poll — crate-1/crate-11), não num signal local da linha. */
  destOpen: boolean;
  onDestOpen: (open: boolean) => void;
  onSelect: () => void;
  onToggleExpand: () => void;
  onDownload: (sourceId: string, dest: string) => void;
  onPickDest: (dest: string) => void;
  onCancel: (jobId: string) => void;
  onTrySource: (jobId: string) => void;
  onGoToOwned: (trackId: string) => void;
}) {
  const setDestOpen = (open: boolean) => props.onDestOpen(open);
  const state = createMemo<RowState>(() => deriveRowState(props.group, props.job));
  const sourceCount = () => props.group.alternates.length + 1;

  const isAlreadyOwnedRejection = createMemo(() => {
    const j = props.job;
    return !!(j && j.state.kind === "rejected" && isAlreadyOwnedReason(j.state.reason));
  });

  return (
    <div class="crate-row-wrap" data-focus={props.isSelected ? "true" : "false"}>
      <div
        class="crate-row"
        data-state={state()}
        data-selected={props.isSelected ? "true" : "false"}
        onClick={props.onSelect}
      >
        <div class="crate-r-main">
          <div class="crate-r-title">{props.group.display_title}</div>
          <div class="crate-r-sub">
            {props.group.display_artist ?? "—"}
            {props.group.album_hint ? ` · ${props.group.album_hint}` : ""}
          </div>
        </div>

        <span class="crate-badge">{props.group.quality_label}</span>

        <button
          type="button"
          class="crate-chip crate-row__sources"
          aria-expanded={props.isExpanded ? "true" : "false"}
          onClick={(e) => { e.stopPropagation(); props.onToggleExpand(); }}
        >
          <span>{sourceCount()} fontes</span>
          <Icon name={ICONS.chevronDown} size={11} />
        </button>

        <Show
          when={!props.job}
          fallback={
            <span class="crate-chip crate-dest__btn">
              <span class="crate-dest__arrow">→</span>
              <span>{props.job?.dest_playlist ?? props.dest ?? "—"}</span>
            </span>
          }
        >
          <DestChip
            variant="row"
            value={props.dest}
            placeholder="escolher"
            warn={!props.dest}
            override={props.destOverridden}
            open={props.destOpen}
            folders={props.folders}
            onToggle={() => setDestOpen(!props.destOpen)}
            onPick={(f) => { props.onPickDest(f); setDestOpen(false); }}
          />
        </Show>

        <div class="crate-r-dur">
          <Show when={props.group.duration_secs != null}>
            {formatDuration(props.group.duration_secs!)}
          </Show>
        </div>

        <div class="crate-r-act">
          <Show when={state() === "idle"}>
            <button
              type="button"
              class="crate-btn crate-btn--primary"
              onClick={(e) => {
                e.stopPropagation();
                if (!props.dest) { setDestOpen(true); return; }
                props.onDownload(props.group.best.id, props.dest);
              }}
            >
              <Icon name={ICONS.download} size={12} /> Baixar
            </button>
          </Show>
          <Show when={state() === "owned"}>
            <button
              type="button"
              class="crate-btn"
              onClick={(e) => { e.stopPropagation(); props.onGoToOwned(props.group.owned!.track_id); }}
            >
              <Icon name={ICONS.play} size={12} /> Tocar
            </button>
          </Show>
          <Show when={state() === "ready"}>
            <button
              type="button"
              class="crate-btn"
              onClick={(e) => {
                e.stopPropagation();
                if (props.job && props.job.state.kind === "ready") playById(props.job.state.track_id);
              }}
            >
              <Icon name={ICONS.play} size={12} /> Tocar
            </button>
          </Show>
          <Show when={CANCELLABLE.has(state() as DownloadJob["state"]["kind"])}>
            <button
              type="button"
              class="crate-btn crate-btn--quiet"
              onClick={(e) => { e.stopPropagation(); if (props.job) props.onCancel(props.job.job_id); }}
            >
              <Icon name={ICONS.close} size={12} /> Cancelar
            </button>
          </Show>
          <Show
            when={
              (state() === "stalled" || state() === "failed" || (state() === "rejected" && !isAlreadyOwnedRejection()))
              && props.job != null && hasUntriedSource(props.job)
            }
          >
            <button
              type="button"
              class="crate-btn"
              onClick={(e) => { e.stopPropagation(); if (props.job) props.onTrySource(props.job.job_id); }}
            >
              <Icon name={ICONS.refresh} size={12} /> Trocar fonte
            </button>
          </Show>
          <Show when={state() === "rejected" && isAlreadyOwnedRejection()}>
            <button
              type="button"
              class="crate-btn"
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
              class="crate-btn"
              onClick={(e) => {
                e.stopPropagation();
                if (props.job && props.job.state.kind === "manual") {
                  openManualPath(props.job.state.path);
                }
              }}
              title="Abre a pasta no gerenciador de arquivos"
            >
              <Icon name={ICONS.folderOpen} size={12} /> Abrir pasta
            </button>
          </Show>
        </div>

        <StateLine state={state()} job={props.job} owned={props.group.owned} dest={props.dest} />
      </div>

      <Show when={props.isExpanded}>
        <SourcesPanel
          group={props.group}
          onUse={(sourceId) => {
            // Sem dest resolvido, mesmo comportamento do [Baixar]
            // (spec §4.5 caso 4): abre o seletor em vez de ficar
            // silencioso (minor da review da Etapa D).
            if (props.dest) props.onDownload(sourceId, props.dest);
            else setDestOpen(true);
          }}
        />
      </Show>
    </div>
  );
}

// ── Linha da fila (Job) — mesmo grid da row de resultado ─────────
function CrateJobRow(props: { job: DownloadJob; onCancel: () => void; onTrySource: () => void }) {
  const kind = () => props.job.state.kind;
  const state = () => (kind() === "canceled" ? "idle" : (kind() as RowState));

  return (
    <div class="crate-row-wrap">
      <div class="crate-job crate-row" data-state={kind()}>
        <div class="crate-r-main">
          <div class="crate-r-title">{props.job.display}</div>
          <div class="crate-r-sub">{props.job.username}</div>
        </div>

        {/* Rótulo da fonte atual; vazio só em job reconciliado de um
            slsk_jobs.json anterior ao campo — aí cai no tamanho. */}
        <span class="crate-badge">
          {props.job.quality_label || formatSize(props.job.size)}
        </span>

        <span class="crate-chip">
          <span>{props.job.alternates.length + 1} fontes</span>
        </span>

        <span class="crate-chip crate-dest__btn">
          <span class="crate-dest__arrow">→</span>
          <span>{props.job.dest_playlist}</span>
        </span>

        <div class="crate-r-dur" />

        <div class="crate-r-act">
          <Show when={kind() === "queued" || kind() === "enqueued" || kind() === "downloading"}>
            <button type="button" class="crate-btn crate-btn--quiet" onClick={props.onCancel}>
              <Icon name={ICONS.close} size={12} /> Cancelar
            </button>
          </Show>
          <Show when={(kind() === "stalled" || kind() === "failed") && hasUntriedSource(props.job)}>
            <button type="button" class="crate-btn" onClick={props.onTrySource}>
              <Icon name={ICONS.refresh} size={12} /> Trocar fonte
            </button>
          </Show>
          <Show when={props.job.state.kind === "ready"}>
            <button
              type="button"
              class="crate-btn"
              onClick={() => { if (props.job.state.kind === "ready") playById(props.job.state.track_id); }}
            >
              <Icon name={ICONS.play} size={12} /> Tocar
            </button>
          </Show>
        </div>

        <StateLine state={state()} job={props.job} owned={null} dest={props.job.dest_playlist} />
      </div>
    </div>
  );
}

/** Job em estado `manual` na Fila: card âmbar (o arquivo existe, o app
    só não soube movê-lo) — o handoff tira essa linha do grid. */
function CrateTerminalCard(props: { job: DownloadJob }) {
  const path = () => (props.job.state.kind === "manual" ? props.job.state.path : "");
  return (
    <div class="crate-row-wrap">
      <div class="crate-terminal">
        <Icon name={ICONS.alert} size={15} />
        <div class="crate-terminal__body">
          <div class="crate-terminal__t">Baixou, mas não achei o arquivo pra mover</div>
          <div class="crate-terminal__p">{path()} · {props.job.display}</div>
        </div>
        <button
          type="button"
          class="crate-banner__act"
          onClick={() => openManualPath(path())}
          title="Abre a pasta no gerenciador de arquivos"
        >
          <Icon name={ICONS.folderOpen} size={11} /> Abrir pasta
        </button>
      </div>
    </div>
  );
}

// ── View principal ─────────────────────────────────────────────
export default function Crate(props: { param?: string | null }) {
  const [tab, setTab] = createSignal<"search" | "queue">("search");
  const [query, setQuery] = createSignal(props.param ? decodeParam(props.param) : "");
  const [searchId, setSearchId] = createSignal<string | null>(null);
  const [snapshot, setSnapshot] = createSignal<SearchSnapshot | null>(null);
  // "Buscando" = pedido em andamento no IPC OU a busca atual ainda na
  // janela do backend. Derivado do snapshot (fonte da verdade), em vez de
  // um signal próprio que dessincronizava quando uma busca nova era
  // recusada com a anterior ainda em voo.
  const [pending, setPending] = createSignal(false);
  const searching = () => pending() || snapshot()?.state === "running";
  const [status, setStatus] = createSignal<SlskStatus | null>(null);
  // Dois canais distintos de "a rede te barrou":
  //  - min-interval (Err "cooldown:N") → countdown NO BOTÃO, sem banner;
  //  - rede fria (Err "cold:N") → banner âmbar + [Buscar mesmo assim].
  const [cooldownLeft, setCooldownLeft] = createSignal(0);
  const [cooldownTotal, setCooldownTotal] = createSignal(0);
  const [coldSeconds, setColdSeconds] = createSignal<number | null>(null);
  const [dedupTrack, setDedupTrack] = createSignal<Track | null>(null);
  // Erro de busca ou de ação (baixar/cancelar/trocar fonte) em texto
  // simples na tela — antes ia só pro console (crate-6).
  const [notice, setNotice] = createSignal<string | null>(null);
  // Seleção pela CHAVE da faixa, não pela posição: durante a busca as
  // linhas reordenam, e a seleção por índice pulava pra outra faixa entre
  // a escolha e o Enter. `null` = primeira linha.
  const [selectedKey, setSelectedKey] = createSignal<string | null>(null);
  const [expandedKey, setExpandedKey] = createSignal<string | null>(null);
  const [folders, setFolders] = createSignal<FolderPlaylist[]>([]);
  // NUNCA semear com loadLastDest() (bug IM-D1, review da Etapa D): isso
  // promove o nível 3 da precedência (último destino usado) a nível 1
  // (override da toolbar), fazendo suggested_dest — artista já no acervo,
  // nível 2 — nunca vencer até o usuário clicar no ×. `null` = toolbar sem
  // override; loadLastDest() só entra como fallback dentro de resolvedDest.
  const [destOverride, setDestOverride] = createSignal<string | null>(null);
  // Qual seletor de destino está aberto: TOOLBAR_DEST ou o group_key da
  // linha. Um signal só = um aberto por vez (crate-11).
  const [openDest, setOpenDest] = createSignal<string | null>(null);
  const [rowOverrides, setRowOverrides] = createSignal<Record<string, string>>({});
  const [groupJobs, setGroupJobs] = createSignal<Record<string, string>>({});

  // Grupos num store reconciliado por `group_key`: cada slsk_results chega
  // como objeto novo (o backend clona o snapshot), e o <For> por referência
  // recriava todas as linhas a cada poll — seletor de destino fechando
  // sozinho, foco perdido, hover piscando (crate-1). Com o reconcile, a
  // mesma faixa mantém a mesma linha e só os campos alterados notificam.
  const [results, setResults] = createStore<{ groups: ResultGroup[] }>({ groups: [] });

  let inputEl!: HTMLInputElement;
  let listEl: HTMLDivElement | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let statusTimer: ReturnType<typeof setInterval> | undefined;
  let cooldownTimer: ReturnType<typeof setInterval> | undefined;
  /** Número da chamada de doSearch mais recente (só ela baixa o pending). */
  let searchSeq = 0;

  const groups = () => results.groups;
  const responsesSeen = () => snapshot()?.responses_seen ?? 0;
  const searchPct = () => Math.min(100, ((snapshot()?.elapsed_ms ?? 0) / SEARCH_WINDOW_MS) * 100);
  const selectedIndex = createMemo(() => {
    const k = selectedKey();
    const i = k == null ? -1 : groups().findIndex((g) => g.group_key === k);
    return i >= 0 ? i : 0;
  });

  function applySnapshot(snap: SearchSnapshot | null) {
    batch(() => {
      setSnapshot(snap);
      setResults("groups", reconcile(snap?.groups ?? [], { key: "group_key" }));
    });
  }
  const libraryCount = () => folders().reduce((n, f) => n + f.track_count, 0);
  const inFlightJobs = () => jobs().filter((j) => IN_FLIGHT.has(j.state.kind));
  const finishedJobs = () => jobs().filter((j) => !IN_FLIGHT.has(j.state.kind));

  /** Precedência (spec §4.5 + handoff v1.1): a escolha feita NA LINHA vem
      primeiro — o chip da linha "herda o destino global até ser trocado na
      própria linha". Depois toolbar > artista no acervo > último usado.
      Antes a toolbar vencia a linha em silêncio, com o chip pintado de
      override mas mostrando (e baixando para) a pasta da toolbar (crate-3). */
  function resolvedDest(g: ResultGroup): string | null {
    return rowOverrides()[g.group_key] ?? destOverride() ?? g.suggested_dest ?? loadLastDest();
  }

  function jobFor(groupKey: string): DownloadJob | null {
    const id = groupJobs()[groupKey];
    if (!id) return null;
    return jobs().find((j) => j.job_id === id) ?? null;
  }

  // Seletor de destino aberto = popover: fecha com clique fora de qualquer
  // `.crate-dest` e com Esc (crate-11, pendência v1.1 do CLAUDE.md).
  // Listeners só existem enquanto há um aberto. O Esc respeita
  // defaultPrevented (a ⌘K por cima trata o próprio Esc) e devolve o foco
  // ao chip quando ele estava dentro do menu que vai sumir.
  createEffect(() => {
    if (openDest() == null) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest?.(".crate-dest")) setOpenDest(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      e.preventDefault();
      const owner = (document.activeElement as HTMLElement | null)?.closest?.(".crate-dest");
      setOpenDest(null);
      owner?.querySelector<HTMLElement>(".crate-dest__btn")?.focus();
    };
    document.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      document.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    });
  });

  /** Countdown do min-interval. `force` NÃO passa por aqui — forçar não
      reseta nem zera o intervalo mínimo, só ignora o guard no backend. */
  function startCooldown(seconds: number) {
    if (cooldownTimer) clearInterval(cooldownTimer);
    setCooldownTotal(Math.max(1, seconds));
    setCooldownLeft(seconds);
    cooldownTimer = setInterval(() => {
      setCooldownLeft((n) => {
        const next = n - 1;
        if (next <= 0 && cooldownTimer) { clearInterval(cooldownTimer); cooldownTimer = undefined; }
        return Math.max(0, next);
      });
    }, 1000);
  }

  async function doSearch(force = false) {
    const q = query().trim();
    if (!q) return;
    const seq = ++searchSeq;
    const prevId = searchId();
    setColdSeconds(null);
    setNotice(null);
    setPending(true);
    setDedupTrack(null);
    try {
      const id = await slskSearch(q, force);
      // A anterior só é cancelada depois que o backend ACEITOU a nova:
      // cancelar antes fazia uma busca recusada pelo pacer (cooldown)
      // matar a que estava em voo, congelando os resultados (crate-8).
      if (prevId && prevId !== id) slskCancelSearch(prevId).catch(() => {});
      setSearchId(id);
      applySnapshot(null);
      setSelectedKey(null);
      setExpandedKey(null);
      setOpenDest((k) => (k === TOOLBAR_DEST ? k : null));
      setGroupJobs({});
      setRowOverrides({});
      slskDedupProbe(q).then((tracks) => setDedupTrack(tracks[0] ?? null)).catch(() => setDedupTrack(null));
      const snap = await slskResults(id);
      if (searchId() !== id) return;
      applySnapshot(snap);
    } catch (e) {
      const parsed = parseSlskSearchError(e);
      if (parsed.kind === "cooldown") startCooldown(parsed.seconds ?? 0);
      else if (parsed.kind === "cold") setColdSeconds(parsed.seconds ?? 0);
      // Os demais eram engolidos: o clique em Buscar não mostrava nada
      // (crate-6). O pacer segue intacto — isto só conta o que houve.
      else if (parsed.kind === "busy") {
        setNotice("Limite de 40 buscas por hora atingido. Espere alguns minutos antes de buscar de novo.");
      } else if (parsed.kind === "offline") {
        setNotice("O slskd não está respondendo. Confira se ele está rodando.");
      } else {
        setNotice(`Não deu pra buscar: ${errorText(e)}.`);
      }
    } finally {
      if (seq === searchSeq) setPending(false);
    }
  }

  async function handleDownload(g: ResultGroup, sourceId: string, dest: string) {
    const id = searchId();
    if (!id) return;
    setNotice(null);
    try {
      const jobId = await slskDownload(id, g.group_key, sourceId, dest);
      setGroupJobs((m) => ({ ...m, [g.group_key]: jobId }));
      saveLastDest(dest);
    } catch (e) {
      console.error("[crate] slskDownload falhou:", e);
      setNotice(`Não deu pra baixar "${g.display_title}": ${errorText(e)}.`);
    }
  }

  async function handleCancel(jobId: string) {
    setNotice(null);
    try {
      await slskCancel(jobId);
    } catch (e) {
      console.error("[crate] slskCancel falhou:", e);
      setNotice(`Não deu pra cancelar o download: ${errorText(e)}.`);
    }
  }

  async function handleTrySource(jobId: string) {
    setNotice(null);
    try {
      await slskTryOtherSource(jobId);
    } catch (e) {
      console.error("[crate] slskTryOtherSource falhou:", e);
      setNotice(`Não deu pra trocar a fonte: ${errorText(e)}.`);
    }
  }

  function scrollSelectedIntoView() {
    listEl
      ?.querySelector<HTMLElement>('.crate-row-wrap[data-focus="true"]')
      ?.scrollIntoView?.({ block: "nearest" });
  }

  function moveSelection(delta: number) {
    const list = groups();
    if (list.length === 0) return;
    const next = Math.max(0, Math.min(list.length - 1, selectedIndex() + delta));
    setSelectedKey(list[next].group_key);
    scrollSelectedIntoView();
  }

  /** Teclado da lista (spec §4.3). Escopado ao elemento da lista — não ao
      window (crate-2): antes, Enter/⌫ em QUALQUER controle (inclusive o
      input da ⌘K por cima) baixava/cancelava a linha selecionada. Teclas
      vindas de um controle dentro da lista (botões da linha, opções do
      seletor) ficam com o próprio controle. */
  function handleListKey(e: KeyboardEvent) {
    if (e.defaultPrevented) return;
    const t = e.target as HTMLElement | null;
    if (t && t !== e.currentTarget && t.closest("input, textarea, select, button, a, [contenteditable]")) return;
    const list = groups();
    const g = list[selectedIndex()];
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveSelection(1);
        return;
      case "ArrowUp":
        e.preventDefault();
        if (selectedIndex() === 0) inputEl.focus();
        else moveSelection(-1);
        return;
      case "ArrowRight":
        if (g) { e.preventDefault(); setExpandedKey(g.group_key); }
        return;
      case "Escape":
        if (openDest() != null) return; // o Esc fecha o seletor aberto, só isso
        setExpandedKey(null);
        return;
      case "Backspace": {
        const job = g ? jobFor(g.group_key) : null;
        if (job && CANCELLABLE.has(job.state.kind)) { e.preventDefault(); handleCancel(job.job_id); }
        return;
      }
      case "Enter": {
        if (!g) return;
        e.preventDefault();
        const job = jobFor(g.group_key);
        const st = deriveRowState(g, job);
        if (st === "owned" && g.owned) { playById(g.owned.track_id); return; }
        if (st === "ready" && job && job.state.kind === "ready") { playById(job.state.track_id); return; }
        if (st === "idle") {
          const dest = resolvedDest(g);
          if (dest) { handleDownload(g, g.best.id, dest); return; }
          // Sem destino: mesmo comportamento do clique em [Baixar] (spec
          // §4.5 caso 4) — abre o seletor, com o foco na 1ª pasta (crate-4).
          setOpenDest(g.group_key);
          listEl
            ?.querySelector<HTMLElement>('.crate-row-wrap[data-focus="true"] .crate-dest__opt')
            ?.focus();
        }
        return;
      }
    }
  }

  // ⌘K "Procurar na rede" com o Crate já aberto: /crate/a → /crate/b não
  // remonta a view (o Dynamic do RouterView só troca de componente quando
  // muda o path), então o param novo precisa refazer a busca aqui
  // (crate-v1). `navigate()` re-emite a rota ao re-navegar para o mesmo
  // hash, e isso também refaz — é um pedido explícito de busca.
  createEffect(on(route, (r) => {
    if (r.path !== "/crate" || !r.param) return;
    setTab("search");
    setQuery(decodeParam(r.param));
    void doSearch();
  }, { defer: true }));

  onMount(() => {
    bootCrateStore();
    libListFolders().then(setFolders).catch(() => {});
    const refreshStatus = () => { slskStatus().then(setStatus).catch(() => {}); };
    refreshStatus();
    statusTimer = setInterval(refreshStatus, STATUS_POLL_MS);

    // Só polla enquanto a busca ainda pode mudar: `running`, ou antes do
    // primeiro snapshot chegar. Estado terminal (done/empty/failed/
    // canceled) não muda mais no backend — seguir pollando só recriava
    // trabalho a cada 800 ms com a view aberta (crate-1).
    pollTimer = setInterval(() => {
      const id = searchId();
      const snap = snapshot();
      if (!id || (snap && snap.state !== "running")) return;
      slskResults(id).then((next) => {
        if (searchId() !== id) return; // resposta atrasada de uma busca já trocada
        applySnapshot(next);
      }).catch(() => {});
    }, POLL_MS);

    onCleanup(() => {
      if (pollTimer) clearInterval(pollTimer);
      if (statusTimer) clearInterval(statusTimer);
      if (cooldownTimer) clearInterval(cooldownTimer);
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
          <Show when={libraryCount() > 0}>
            <span><b>{libraryCount().toLocaleString("pt-BR")}</b> no acervo</span>
          </Show>
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

      <div class="view__body crate-body">
        <Show when={tab() === "search"}>
          <div class="coll-toolbar crate-toolbar">
            <div class="coll-search crate-search">
              <Icon name={ICONS.search} size={16} />
              <input
                ref={inputEl}
                value={query()}
                spellcheck={false}
                placeholder="Buscar na rede Soulseek…"
                // Uma busca em voo por vez (spec §6.1, "campo desabilita"):
                // somente leitura mantém o foco e o ↓ para a lista.
                readOnly={searching()}
                aria-busy={searching() ? "true" : "false"}
                onInput={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    // Enter a mais durante a busca cancelava a busca em voo
                    // e recomeçava do zero, gastando o limite horário (crate-8).
                    if (!searching()) doSearch(false);
                    return;
                  }
                  // ↓ entra na lista (paridade com a ⌘K, spec §4.3) — antes
                  // era preciso descobrir um Esc pra sair do campo (crate-4).
                  if (e.key === "ArrowDown" && groups().length > 0 && listEl) {
                    e.preventDefault();
                    listEl.focus();
                    scrollSelectedIntoView();
                    return;
                  }
                  if (e.key === "Escape" && openDest() == null) {
                    e.currentTarget.blur();
                    setExpandedKey(null);
                  }
                }}
              />
              <div class="crate-search__kbd">
                <kbd class="crate-kbd">Enter</kbd>
                <kbd class="crate-kbd">↑↓</kbd>
                <kbd class="crate-kbd">→</kbd>
              </div>
            </div>

            <button
              type="button"
              class="crate-btn-search"
              data-cooldown={cooldownLeft() > 0 ? "true" : "false"}
              disabled={searching() || cooldownLeft() > 0}
              onClick={() => doSearch(false)}
            >
              <Show when={cooldownLeft() > 0}>
                <svg class="crate-cooldown-ring" viewBox="0 0 15 15" aria-hidden="true">
                  <circle class="trk" cx="7.5" cy="7.5" r="6" />
                  <circle
                    class="val" cx="7.5" cy="7.5" r="6"
                    stroke-dashoffset={RING_LEN * (1 - cooldownLeft() / Math.max(1, cooldownTotal()))}
                  />
                </svg>
              </Show>
              <span>
                {cooldownLeft() > 0 ? `${cooldownLeft()}s` : searching() ? "Buscando…" : "Buscar"}
              </span>
            </button>

            <span class="crate-net-status" data-on={status()?.network_connected ? "true" : "false"}>
              <span class="crate-net-status__dot" />
              {status() ? (status()!.network_connected ? "rede ok" : "fora da rede") : "verificando…"}
            </span>

            <DestChip
              variant="toolbar"
              value={destOverride()}
              placeholder="destino padrão"
              open={openDest() === TOOLBAR_DEST}
              folders={folders()}
              onToggle={() => setOpenDest((k) => (k === TOOLBAR_DEST ? null : TOOLBAR_DEST))}
              onPick={(f) => { setDestOverride(f); saveLastDest(f); setOpenDest(null); }}
            />
            <Show when={destOverride()}>
              <button type="button" class="crate-dest__clear" onClick={() => setDestOverride(null)} title="Limpar destino fixo">
                ×
              </button>
            </Show>
          </div>

          <Show when={coldSeconds() != null || dedupTrack() || notice()}>
            <div class="crate-banners">
              <Show when={notice()}>
                {(text) => <NoticeBanner text={text()} onClose={() => setNotice(null)} />}
              </Show>

              <Show when={coldSeconds() != null}>
                <div class="crate-banner" data-tone="amber">
                  <Icon name={ICONS.alert} size={15} />
                  <p>
                    A rede Soulseek parou de responder (3 buscas em branco).
                    <span class="crate-banner__sub">
                      Pausado por {formatAgo(coldSeconds()!)} — isso é da rede, não do app.
                    </span>
                  </p>
                  <span class="crate-banner__sp" />
                  <button type="button" class="crate-banner__act" onClick={() => doSearch(true)}>
                    Buscar mesmo assim
                  </button>
                </div>
              </Show>

              <Show when={dedupTrack()}>
                {(t) => (
                  <div class="crate-banner" data-tone="mint">
                    <Icon name={ICONS.check} size={15} />
                    <p>
                      Já tem no acervo: <strong>{t().artist_name ?? "—"} — {t().title}</strong>
                      <Show when={t().album_title}>
                        {" "}<span class="crate-banner__dim">({t().album_title})</span>
                      </Show>
                    </p>
                    <span class="crate-banner__sp" />
                    <button type="button" class="crate-banner__act" onClick={() => playTrack(t(), "crate")}>
                      <Icon name={ICONS.play} size={11} /> Tocar
                    </button>
                  </div>
                )}
              </Show>
            </div>
          </Show>

          <Show when={searchId()}>
            <div class="crate-list-head">
              {/* Durante a busca: respostas que já chegaram + barra contra a
                  janela de 25 s (spec §6.1). Antes era 'Resultados · 0
                  faixas', que parece resultado final (crate-8). */}
              <Show
                when={searching()}
                fallback={<h2>Resultados · {groups().length}&nbsp;faixas</h2>}
              >
                <div class="crate-list-head__lead">
                  <h2>
                    Buscando · {responsesSeen()}&nbsp;{responsesSeen() === 1 ? "resposta" : "respostas"}
                  </h2>
                  <div
                    class="crate-prog"
                    role="progressbar"
                    aria-label="Janela da busca"
                    aria-valuemin="0"
                    aria-valuemax="100"
                    aria-valuenow={Math.round(searchPct())}
                  >
                    <i style={{ width: `${searchPct()}%` }} />
                  </div>
                </div>
              </Show>
              <div class="crate-keys">
                <kbd class="crate-kbd">↑↓</kbd> navegar
                <kbd class="crate-kbd">→</kbd> fontes
                <kbd class="crate-kbd">Enter</kbd> baixar
              </div>
            </div>
          </Show>

          <Show when={groups().length > 0}>
            <div
              class="crate-list"
              ref={listEl}
              tabindex="0"
              role="group"
              aria-label="Resultados da busca"
              onKeyDown={handleListKey}
            >
              <div class="crate-list-inner">
                <For each={groups()}>
                  {(g, i) => (
                    <CrateRow
                      group={g}
                      job={jobFor(g.group_key)}
                      dest={resolvedDest(g)}
                      destOverridden={rowOverrides()[g.group_key] != null}
                      isSelected={i() === selectedIndex()}
                      isExpanded={expandedKey() === g.group_key}
                      folders={folders()}
                      destOpen={openDest() === g.group_key}
                      onDestOpen={(open) => setOpenDest(open ? g.group_key : null)}
                      onSelect={() => { setSelectedKey(g.group_key); listEl?.focus({ preventScroll: true }); }}
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
            </div>
          </Show>

          <Show when={!searching() && snapshot() && groups().length === 0}>
            <div class="crate-empty-wrap">
              <div class="crate-empty">
                <Icon name={ICONS.packageOpen} size={26} />
                <h3>{snapshot()?.state === "failed" ? "Busca falhou" : "Nada encontrado"}</h3>
                <p>{snapshot()?.note ?? "a rede não devolveu resultados pra essa busca."}</p>
              </div>
            </div>
          </Show>

          <Show when={!searchId() && !searching()}>
            <div class="crate-empty-wrap">
              <div class="crate-empty">
                <Icon name={ICONS.packageOpen} size={26} />
                <h3>Nada buscado ainda</h3>
                <p>A busca só dispara no Enter — o Crate nunca busca enquanto você digita.</p>
                <div class="crate-empty__hintline">
                  <kbd class="crate-kbd">⌘K</kbd> → digite → <kbd class="crate-kbd">Procurar na rede</kbd>
                </div>
              </div>
            </div>
          </Show>
        </Show>

        <Show when={tab() === "queue"}>
          <Show when={notice()}>
            {(text) => (
              <div class="crate-banners">
                <NoticeBanner text={text()} onClose={() => setNotice(null)} />
              </div>
            )}
          </Show>

          <Show when={inFlightJobs().length > 0}>
            <div class="crate-q-sec"><h2>Em voo · {inFlightJobs().length}</h2></div>
            <div class="crate-list" style={{ "padding-top": "0" }}>
              <div class="crate-list-inner">
                <For each={inFlightJobs()}>
                  {(j) => (
                    <CrateJobRow
                      job={j}
                      onCancel={() => handleCancel(j.job_id)}
                      onTrySource={() => handleTrySource(j.job_id)}
                    />
                  )}
                </For>
              </div>
            </div>
          </Show>

          <Show when={finishedJobs().length > 0}>
            <div class="crate-q-sec"><h2>Terminadas · {finishedJobs().length}</h2></div>
            <div class="crate-list" style={{ "padding-top": "0" }}>
              <div class="crate-list-inner">
                <For each={finishedJobs()}>
                  {(j) => (
                    <Show
                      when={j.state.kind !== "manual"}
                      fallback={<CrateTerminalCard job={j} />}
                    >
                      <CrateJobRow
                        job={j}
                        onCancel={() => handleCancel(j.job_id)}
                        onTrySource={() => handleTrySource(j.job_id)}
                      />
                    </Show>
                  )}
                </For>
              </div>
            </div>
          </Show>

          <Show when={jobs().length === 0}>
            <div class="crate-empty-wrap">
              <div class="crate-empty">
                <Icon name={ICONS.packageOpen} size={26} />
                <h3>Fila vazia</h3>
                <p>Baixe algo na aba Buscar pra ver o progresso aqui.</p>
              </div>
            </div>
          </Show>
        </Show>
      </div>
    </article>
  );
}
