/* ============================================================
   views/Crate.tsx — busca e download in-app: Soulseek e SoundCloud.

   Fluxo (spec §4): digitar → escolher a faixa → um clique → a
   linha vira `▸ Tocar`. Busca NUNCA dispara on-input (⏎ ou botão
   apenas — guard-rail contra rajada na rede real, spec §6.1).

   Busca é poll de ciclo CURTO, atado a esta view (setInterval
   morto no onCleanup). A fila (jobs) é ciclo LONGO — vem do store
   global (store/crate.ts), que sobrevive a esta view desmontar
   (é o que alimenta o badge da sidebar).

   SoundCloud (fase 1, spec 2026-10-12 §5): a mesma busca devolve a
   seção SoundCloud em cima (chega em ~1 s) e a do Soulseek embaixo.
   Baixar numa linha do SoundCloud abre o card de confirmação na
   própria linha (sem modal): artista, título, ano e playlist que o
   CEO confirma, mais o formato real sondado com o token.

   Camada visual = restyle v1.1, handoff
   docs/design-refs/design_handoff_crate/"Rustify Crate.html"
   (densidade compacta). Comportamento inalterado.
   ============================================================ */

import {
  createSignal, createMemo, createEffect, on, For, Show, onMount, onCleanup, batch, type JSX,
} from "solid-js";
import { route } from "../router";
import { pushEscLayer } from "../lib/escLayers";
import { modCombo } from "../lib/keyboard";
import { createStore, reconcile } from "solid-js/store";
import {
  slskStatus, slskSearch, slskResults, slskCancelSearch, slskDedupProbe,
  slskDownload, slskTryOtherSource, slskCancel,
  parseSlskSearchError, libListFolders, libGetTracksByIds, formatDuration,
  crateScSearch, crateScResolve, crateScProbe, crateScArtwork, crateDownload, crateSourcesStatus,
  crateTidalJobs, crateTidalEnqueue,
  type SlskStatus, type SearchSnapshot, type ResultGroup, type Candidate,
  type DownloadJob, type FolderPlaylist, type Track, type RejectReason, type Source,
  type ScResult, type ScProbe, type SourcesStatus, type ConfirmedMeta, type FormatIn,
  type TidalJob,
} from "../tauri";
import { guessFromSoundCloud, cleanTitle, type MetaGuess } from "../lib/trackMetaGuess";
import {
  shortTidalLink, tidalStatusLabel, tidalStatusTone, loadLastTidalDest, saveLastTidalDest,
} from "../lib/tidalFila";
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

/** Status das fontes (token do SoundCloud, ffmpeg): spec §5.4. */
const SOURCES_POLL_MS = 30_000;

/** Poll da fila da Tidal — roda na VM, não reage a input local; 10 s
    (brief da seção Tidal) é folgado o bastante pra não martelar a rede. */
const TIDAL_POLL_MS = 10_000;

/** Link colado do SoundCloud vai para o resolve, não para a busca.
    Inclui o curto `on.soundcloud.com/<id>` do app do celular (o backend
    segue o redirect antes do /resolve). */
const SC_LINK = /^https?:\/\/(www\.|m\.|on\.)?soundcloud\.com\//i;
/** Link do Bandcamp: sondagem só na fase 2. */
const BC_LINK = /^https?:\/\/([a-z0-9-]+\.)*bandcamp\.com(\/|$)/i;

/** Circunferência do anel de cooldown (r=6) — casa com o
    stroke-dasharray:37.7 do handoff. */
const RING_LEN = 37.7;

// Estados de linha (idle/owned + os 10 estados não-canceled de JobState —
// "canceled" é tratado como idle: o usuário pode baixar de novo).
type RowState =
  | "idle" | "owned"
  | "queued" | "enqueued" | "downloading" | "stalled" | "processing" | "indexing"
  | "ready" | "rejected" | "manual" | "failed" | "waiting";

/** Estados não-terminais (mesma partição do store/crate.ts) — separa
    "Em voo" de "Terminadas" na aba Fila. */
const IN_FLIGHT = new Set<DownloadJob["state"]["kind"]>([
  "queued", "enqueued", "downloading", "stalled", "processing", "indexing", "waiting",
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

/** Respostas de erro do coordinator (strings fixas do backend) → texto
    de tela. Desconhecido passa cru. */
const BACKEND_ERRORS: Record<string, string> = {
  "coordinator não respondeu a tempo": "o serviço de downloads não respondeu a tempo",
  "coordinator indisponível": "o serviço de downloads está indisponível",
  "busca desconhecida ou expirada": "a busca expirou, busque de novo",
  "grupo não encontrado nessa busca": "a faixa não está mais nessa busca, busque de novo",
  "fonte não encontrada nesse grupo": "essa fonte não está mais disponível, busque de novo",
  "destino de playlist inválido": "nome de playlist inválido",
  "job não encontrado": "o download não existe mais",
  "sem outras fontes disponíveis": "não há outras fontes para tentar",
  "job em estado que não aceita troca de fonte agora": "o download está num estado que não aceita troca de fonte agora",
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

/** Minúsculas, sem acento, só letras/dígitos separados por espaço. */
function normWords(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Qual faixa do acervo o banner "Já tem no acervo" pode afirmar. O probe
    (busca local) casa cada termo por substring em título, artista OU
    álbum, então buscar por artista/álbum sempre achava alguma faixa, e o
    banner afirmava posse de uma faixa que o usuário não buscou (crate-v4).
    Só vale a faixa cujo título (sem "(feat. …)", "[…]" e " - sufixo")
    aparece inteiro, como palavras, no termo buscado. */
export function dedupMatch(query: string, tracks: Track[]): Track | null {
  const q = ` ${normWords(query)} `;
  return (
    tracks.find((t) => {
      const core = normWords(t.title.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/\s[-–—]\s.*$/, " "));
      return core.length > 0 && q.includes(` ${core} `);
    }) ?? null
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
  if (typeof reason === "object" && reason !== null && "low_bitrate" in reason) {
    return `MP3 ${reason.low_bitrate.kbps}: abaixo de 320`;
  }
  if (reason === "no_download") return "sem download nativo";
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

/** Subtítulo da fila: peer do Soulseek ou link da fonte sem o esquema
    (espelha `Source::label` do board.rs). */
function sourceSubtitle(src: Source): string {
  switch (src.kind) {
    case "soulseek":
      return src.username;
    case "sound_cloud":
      return src.permalink_url.replace(/^https?:\/\/(www\.)?/i, "");
    case "bandcamp":
      return src.url.replace(/^https?:\/\/(www\.)?/i, "");
  }
}

/** Nome da origem no badge da linha. */
function sourceName(src: Source): string {
  switch (src.kind) {
    case "soulseek":
      return "Soulseek";
    case "sound_cloud":
      return "SoundCloud";
    case "bandcamp":
      return "Bandcamp";
  }
}

/** Formato de origem detectado pelo worker (FormatIn do board.rs). */
const FORMAT_IN_LABEL: Record<FormatIn, string> = {
  flac: "FLAC",
  wav24: "WAV 24 bit",
  wav16: "WAV 16 bit",
  aiff: "AIFF",
  mp3_320: "MP3 320",
};

/** Badge de formato na Fila. Soulseek: rótulo da fonte (ou o tamanho, em
    job antigo sem rótulo). Origem externa: o `format_in` que o worker
    preenche; antes disso não há o que mostrar (o backend cria esses jobs
    com `quality_label` vazio e não há tamanho). */
function jobFormatLabel(job: DownloadJob): string | null {
  if (job.source.kind === "soulseek") return job.quality_label || formatSize(job.source.size);
  return job.format_in ? FORMAT_IN_LABEL[job.format_in] : null;
}

/** Job de origem externa (SoundCloud, Bandcamp) que pode ser refeito. Lá
    não há [Trocar fonte] (não existem alternativas), e o job_id fixo por
    faixa deixaria a linha presa em `failed` para sempre, inclusive entre
    sessões. O backend recria job terminal com `attempt` novo. Bitrate
    baixo, formato do original sem download (spec §3.2) e posse não
    mudam ao refazer: ficam de fora. */
function canRetryExternal(job: DownloadJob): boolean {
  if (job.source.kind === "soulseek") return false;
  const st = job.state;
  if (st.kind === "failed") return true;
  if (st.kind !== "rejected") return false;
  const r = st.reason;
  if (r === "no_download") return false;
  return !isAlreadyOwnedReason(r) && !(typeof r === "object" && r !== null && "low_bitrate" in r);
}

/** Badge da origem (à esquerda do formato). */
function OriginBadge(props: { name: string }) {
  return <span class="crate-origin">{props.name}</span>;
}

/** Tamanho no card de confirmação: MB binário com vírgula ("7,1 MB"). */
function formatMb(bytes: number): string {
  return `${(bytes / 1_048_576).toLocaleString("pt-BR", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

/** Ano de lançamento do SoundCloud (release_date vence created_at). */
function scYear(r: ScResult): number | null {
  const m = /^(\d{4})/.exec(r.release_date ?? r.created_at ?? "");
  return m ? parseInt(m[1], 10) : null;
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

/** Link externo (página do SoundCloud, gate de terceiros, compra no
    Bandcamp). O app não abre URL: a capability do opener concede só o
    reveal-item-in-dir (CLAUDE.md, "não alargar"), e um <a target=_blank>
    cai no `open_url` do plugin, negado — o clique morria sem fazer nada.
    O botão copia o link para colar no navegador; sem clipboard, a URL
    aparece selecionável no lugar do botão. Abrir direto no Chrome
    depende de o CEO liberar `opener:allow-open-url` com escopo. */
function CopyLinkButton(props: { url: string; label: string; hint: string; quiet?: boolean }) {
  const [st, setSt] = createSignal<"idle" | "ok" | "err">("idle");
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  async function copy(e: MouseEvent) {
    e.stopPropagation();
    try {
      if (!navigator.clipboard) throw new Error("sem clipboard");
      await navigator.clipboard.writeText(props.url);
      setSt("ok");
      clearTimeout(timer);
      timer = setTimeout(() => setSt("idle"), 2500);
    } catch (err) {
      console.warn("[crate] não deu pra copiar o link:", err);
      setSt("err");
    }
  }
  return (
    <Show
      when={st() !== "err"}
      fallback={<span class="crate-link-url" title="Copie e cole no navegador">{props.url}</span>}
    >
      <button
        type="button"
        class={`crate-btn${props.quiet ? " crate-btn--quiet" : ""}`}
        title={`${props.hint} · ${props.url}`}
        onClick={copy}
      >
        <Icon name={st() === "ok" ? ICONS.check : ICONS.externalLink} size={12} />
        {st() === "ok" ? "Link copiado" : props.label}
      </button>
    </Show>
  );
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
            // Origem externa: aceito pela fonte, aguardando início (spec
            // §2.2). Não há peer nem fila de peer fora do Soulseek.
            if (job && job.source.kind !== "soulseek") {
              return <span class="crate-st-dim">aguardando início</span>;
            }
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

        <Show when={props.state === "waiting"}>
          <span class="crate-pill crate-pill--warn">aguardando</span>
          <Show when={j() && j()!.state.kind === "waiting"}>
            <span class="crate-st-txt--warn">
              {(j()!.state as { reason: "purchase" | "email_link" }).reason === "purchase"
                ? "Aguardando compra no Bandcamp"
                : "Link enviado para o seu e-mail"}
            </span>
            <span class="crate-st-dim crate-st-mono">
              há {formatAgo((j()!.state as { since_secs: number }).since_secs)}
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
  /** Job desta linha, se houver — o painel precisa saber quem está
      servindo e quem já foi tentado (crate-16). */
  job: DownloadJob | null;
  onUse: (sourceId: string) => void;
}) {
  // Com download em voo, 'Usar' criava um SEGUNDO download paralelo da
  // mesma faixa (job novo por peer) e o primeiro sumia da aba Buscar
  // (crate-16). Enquanto houver job em voo, 'Usar' fica desabilitado; a
  // troca é pelo [Trocar fonte] ou cancelando antes.
  const inFlight = () => props.job != null && IN_FLIGHT.has(props.job.state.kind);
  const isCurrent = (c: Candidate) => {
    const src = props.job?.source;
    return src?.kind === "soulseek" && c.username === src.username && c.filename === src.remote_filename;
  };
  const inUse = (c: Candidate) => inFlight() && isCurrent(c);
  /** Fonte já usada por este job e que não está servindo agora. A fonte
      original de um job que trocou de fonte não entra: o board não guarda
      o id dela (só as alternativas tentadas). */
  const wasTried = (c: Candidate) => {
    const j = props.job;
    if (!j || j.state.kind === "ready" || j.state.kind === "canceled" || inUse(c)) return false;
    return j.tried_source_ids.includes(c.id) || isCurrent(c);
  };
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
                  <Show when={inUse(c())}>
                    <span class="crate-pill crate-pill--live">em uso</span>
                  </Show>
                  <Show when={wasTried(c())}>
                    <span class="crate-pill crate-pill--sub">tentada</span>
                  </Show>
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
                  <button
                    type="button"
                    class="crate-btn"
                    disabled={inFlight()}
                    title={inFlight() ? "Esta faixa já está baixando. Use [Trocar fonte] ou cancele antes." : undefined}
                    onClick={(e) => { e.stopPropagation(); if (!inFlight()) props.onUse(id); }}
                  >
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
  /** id da linha, alvo do aria-activedescendant da lista. */
  rowId: string;
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
      {/* A lista mantém o foco e aponta a selecionada por
          aria-activedescendant: a linha precisa de id e de nome (título +
          artista) para o leitor de tela dizer qual o Enter vai acionar. */}
      <div
        class="crate-row"
        id={props.rowId}
        role="group"
        aria-labelledby={`${props.rowId}-t ${props.rowId}-s`}
        data-state={state()}
        data-selected={props.isSelected ? "true" : "false"}
        onClick={props.onSelect}
      >
        <div class="crate-r-main">
          <div class="crate-r-title" id={`${props.rowId}-t`}>{props.group.display_title}</div>
          <div class="crate-r-sub" id={`${props.rowId}-s`}>
            {props.group.display_artist ?? "—"}
            {props.group.album_hint ? ` · ${props.group.album_hint}` : ""}
          </div>
          <OriginBadge name="Soulseek" />
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
          job={props.job}
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
function CrateJobRow(props: {
  job: DownloadJob;
  onCancel: () => void;
  onTrySource: () => void;
  onRetry: () => void;
}) {
  const kind = () => props.job.state.kind;
  const state = () => (kind() === "canceled" ? "idle" : (kind() as RowState));

  return (
    <div class="crate-row-wrap">
      <div class="crate-job crate-row" data-state={kind()}>
        <div class="crate-r-main">
          <div class="crate-r-title">{props.job.display}</div>
          <div class="crate-r-sub">{sourceSubtitle(props.job.source)}</div>
          <OriginBadge name={sourceName(props.job.source)} />
        </div>

        <Show when={jobFormatLabel(props.job)} fallback={<span />}>
          {(label) => <span class="crate-badge">{label()}</span>}
        </Show>

        {/* Troca de fonte só existe no Soulseek; nas outras origens a
            coluna fica vazia. */}
        <Show when={props.job.source.kind === "soulseek"} fallback={<span />}>
          <span class="crate-chip">
            <span>{props.job.alternates.length + 1} fontes</span>
          </span>
        </Show>

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
          <Show when={canRetryExternal(props.job)}>
            <button type="button" class="crate-btn" onClick={props.onRetry}>
              <Icon name={ICONS.refresh} size={12} /> Tentar de novo
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
          {/* "Verificar agora" e "Continuar" chegam com o Bandcamp (fase 2). */}
          <Show when={props.job.state.kind === "waiting" ? props.job.state.url : null}>
            {(url) => (
              <CopyLinkButton url={url()} label="Copiar link" hint="Copia o link para abrir no navegador" />
            )}
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

// ── Tidal: linha de job da fila remota ────────────────────────────

function TidalJobRow(props: { job: TidalJob }) {
  const tone = () => tidalStatusTone(props.job.status);
  const horario = () => props.job.fim ?? props.job.inicio ?? props.job.added;
  return (
    <div class="crate-row-wrap">
      <div class="crate-tidal-row">
        <span class={`crate-pill crate-pill--${tone()}`}>{tidalStatusLabel(props.job.status)}</span>
        <span class="crate-chip crate-dest__btn">
          <span class="crate-dest__arrow">→</span>
          <span>{props.job.playlist}</span>
        </span>
        <div class="crate-tidal-row__main">
          <CopyLinkButton url={props.job.url} label={shortTidalLink(props.job.url)} hint="Copia o link da Tidal" quiet />
          <Show when={props.job.resumo}>
            <p class="crate-tidal-row__resumo">{props.job.resumo}</p>
          </Show>
        </div>
        <span class="crate-r-dur crate-tidal-row__time">{horario()}</span>
      </div>
    </div>
  );
}

// ── SoundCloud: linha de resultado e card de confirmação ─────────

/** Chip de disponibilidade do original (spec §5.1). */
const AVAIL_LABEL: Record<ScResult["availability"]["kind"], string> = {
  native: "Original",
  quota_exhausted: "Cota esgotada",
  external_gate: "Download externo",
  none: "Sem download",
};

/** O que o card mostra e edita. `meta` nasce do guessFromSoundCloud. */
interface CardState {
  r: ScResult;
  meta: MetaGuess;
  probe: ScProbe | null;
  probeErr: string | null;
  cover: string | null;
  dest: string | null;
  dedup: Track | null;
}

function ScRow(props: {
  r: ScResult;
  job: DownloadJob | null;
  cardOpen: boolean;
  onDownload: () => void;
  onCancel: (jobId: string) => void;
  onRetry: (job: DownloadJob) => void;
  children?: JSX.Element;
}) {
  const kind = () => props.r.availability.kind;
  const state = createMemo<RowState>(() =>
    props.job && props.job.state.kind !== "canceled" ? (props.job.state.kind as RowState) : "idle",
  );
  const year = () => scYear(props.r);
  return (
    <div class="crate-row-wrap" data-sc-id={props.r.id}>
      <div class="crate-row crate-row--sc" data-state={state()} data-avail={kind()}>
        <div class="crate-r-main">
          <div class="crate-r-title">{cleanTitle(props.r.title) || props.r.title}</div>
          <div class="crate-r-sub">{props.r.user_name}</div>
          <OriginBadge name="SoundCloud" />
        </div>

        <span class="crate-avail" data-kind={kind()}>{AVAIL_LABEL[kind()]}</span>

        <div class="crate-r-meta">
          {props.r.playback_count.toLocaleString("pt-BR")} reproduções
        </div>

        <div class="crate-r-meta">
          <Show when={year() != null}>{year()}</Show>
        </div>

        <div class="crate-r-dur">{formatDuration(props.r.duration_ms / 1000)}</div>

        <div class="crate-r-act">
          <Show when={kind() === "native" && state() === "idle" && !props.cardOpen}>
            <button
              type="button"
              class="crate-btn crate-btn--primary"
              onClick={(e) => { e.stopPropagation(); props.onDownload(); }}
            >
              <Icon name={ICONS.download} size={12} /> Baixar
            </button>
          </Show>
          <Show when={props.r.availability.kind === "external_gate" ? props.r.availability.url : null}>
            {(url) => (
              <CopyLinkButton
                url={url()}
                label="Copiar link"
                hint="Download por página de terceiros, fica fora do app: copia o link para abrir no navegador"
              />
            )}
          </Show>
          <Show when={kind() === "none" || kind() === "quota_exhausted"}>
            <CopyLinkButton
              url={props.r.permalink_url}
              label="Copiar página"
              hint="Copia o link da faixa para abrir no navegador"
              quiet
            />
          </Show>
          <Show when={state() === "ready"}>
            <button
              type="button"
              class="crate-btn"
              onClick={() => { if (props.job && props.job.state.kind === "ready") playById(props.job.state.track_id); }}
            >
              <Icon name={ICONS.play} size={12} /> Tocar
            </button>
          </Show>
          <Show when={CANCELLABLE.has(state() as DownloadJob["state"]["kind"])}>
            <button
              type="button"
              class="crate-btn crate-btn--quiet"
              onClick={() => { if (props.job) props.onCancel(props.job.job_id); }}
            >
              <Icon name={ICONS.close} size={12} /> Cancelar
            </button>
          </Show>
          <Show when={props.job && canRetryExternal(props.job) ? props.job : null}>
            {(job) => (
              <button
                type="button"
                class="crate-btn"
                title="Baixa de novo com o metadado já confirmado"
                onClick={(e) => { e.stopPropagation(); props.onRetry(job()); }}
              >
                <Icon name={ICONS.refresh} size={12} /> Tentar de novo
              </button>
            )}
          </Show>
        </div>

        <StateLine state={state()} job={props.job} owned={null} dest={props.job?.dest_playlist ?? null} />
      </div>
      {props.children}
    </div>
  );
}

function ConfirmCard(props: {
  c: CardState;
  folders: FolderPlaylist[];
  destOpen: boolean;
  submitting: boolean;
  onDestToggle: () => void;
  onPickDest: (dest: string) => void;
  onField: (field: "artist" | "title", value: string) => void;
  onYear: (year: number | null) => void;
  onSubmit: () => void;
  onCancel: () => void;
  onShowStatus: () => void;
}) {
  const canSubmit = () =>
    !props.submitting
    && !!props.c.probe?.allowed
    && props.c.meta.artist.trim() !== ""
    && props.c.meta.title.trim() !== ""
    && !!props.c.dest;
  const fmtTone = () => {
    if (props.c.probeErr) return "err";
    if (!props.c.probe) return "wait";
    return props.c.probe.allowed ? "ok" : "err";
  };
  const submit = () => { if (canSubmit()) props.onSubmit(); };

  // O Baixar da linha, que tinha o foco, some quando o card abre: sem
  // isto o foco caía no body e o Enter (Baixar) não chegava ao form.
  // Vai para o primeiro campo obrigatório vazio, senão para o Artista.
  let artistEl: HTMLInputElement | undefined;
  let titleEl: HTMLInputElement | undefined;
  onMount(() => {
    queueMicrotask(() => {
      const target = props.c.meta.artist.trim() === "" || props.c.meta.title.trim() !== "" ? artistEl : titleEl;
      target?.focus();
    });
  });

  return (
    <form
      class="crate-card"
      role="form"
      aria-label="Confirmar faixa"
      onSubmit={(e) => { e.preventDefault(); submit(); }}
      onKeyDown={(e) => {
        // Enter num campo = Baixar, inclusive no teclado virtual e no
        // campo de ano (o submit implícito do form não cobre todos).
        const t = e.target as HTMLElement;
        if (e.key === "Enter" && t.tagName === "INPUT") { e.preventDefault(); submit(); }
      }}
    >
      <div class="crate-card__cover">
        <Show when={props.c.cover} fallback={<Icon name={ICONS.music} size={20} />}>
          {(src) => <img src={src()} alt="" />}
        </Show>
      </div>

      <div class="crate-card__body">
        <div class="crate-card__fields">
          <label class="crate-card__field">
            <span>Artista</span>
            <input
              ref={artistEl}
              value={props.c.meta.artist}
              spellcheck={false}
              placeholder="obrigatório"
              onInput={(e) => props.onField("artist", e.currentTarget.value)}
            />
          </label>
          <label class="crate-card__field crate-card__field--wide">
            <span>Título</span>
            <input
              ref={titleEl}
              value={props.c.meta.title}
              spellcheck={false}
              placeholder="obrigatório"
              onInput={(e) => props.onField("title", e.currentTarget.value)}
            />
          </label>
          <label class="crate-card__field crate-card__field--year">
            <span>Ano</span>
            <input
              type="number"
              inputmode="numeric"
              min="1900"
              max="2100"
              value={props.c.meta.year ?? ""}
              onInput={(e) => {
                const n = parseInt(e.currentTarget.value, 10);
                props.onYear(Number.isFinite(n) ? n : null);
              }}
            />
          </label>
          <div class="crate-card__field">
            <span>Playlist</span>
            <DestChip
              variant="row"
              value={props.c.dest}
              placeholder="escolher"
              warn={!props.c.dest}
              open={props.destOpen}
              folders={props.folders}
              onToggle={props.onDestToggle}
              onPick={props.onPickDest}
            />
          </div>
        </div>

        <div class="crate-fmt" data-tone={fmtTone()}>
          <Show when={!props.c.probe && !props.c.probeErr}>sondando formato…</Show>
          <Show when={props.c.probeErr === "no_token"}>
            sem token do SoundCloud
            <button type="button" class="crate-fmt__link" onClick={props.onShowStatus}>
              ver status das fontes
            </button>
          </Show>
          <Show when={props.c.probeErr && props.c.probeErr !== "no_token"}>
            não deu pra sondar o formato: {props.c.probeErr}
          </Show>
          <Show when={props.c.probe}>
            {(p) => (
              <Show
                when={p().allowed}
                fallback={
                  <>
                    {p().format_label} · não entra
                    <Show when={p().reason}>
                      {" "}<span class="crate-fmt__why">({p().reason})</span>
                    </Show>
                  </>
                }
              >
                {p().format_label}{p().size != null ? ` · ${formatMb(p().size!)}` : ""}
              </Show>
            )}
          </Show>
        </div>

        <Show when={props.c.dedup}>
          {(t) => (
            <div class="crate-card__dedup">
              <Icon name={ICONS.check} size={12} />
              <span>Já no acervo: {t().artist_name ?? "—"} — {t().title}</span>
              <button type="button" class="crate-btn crate-btn--quiet" onClick={() => playTrack(t(), "crate")}>
                <Icon name={ICONS.play} size={12} /> Tocar
              </button>
            </div>
          )}
        </Show>

        <div class="crate-card__acts">
          <button type="submit" class="crate-btn crate-btn--primary" disabled={!canSubmit()}>
            <Icon name={ICONS.download} size={12} /> Baixar
          </button>
          <button type="button" class="crate-btn crate-btn--quiet" onClick={props.onCancel}>
            Cancelar
          </button>
        </div>
      </div>
    </form>
  );
}

// ── View principal ─────────────────────────────────────────────
export default function Crate(props: { param?: string | null }) {
  const [tab, setTab] = createSignal<"search" | "queue" | "tidal">("search");
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

  // SoundCloud (spec §5): busca própria, paralela à do Soulseek, e um card
  // de confirmação aberto por vez.
  const [scResults, setScResults] = createSignal<ScResult[]>([]);
  const [scState, setScState] = createSignal<"idle" | "loading" | "done" | "empty" | "error">("idle");
  const [scError, setScError] = createSignal<string | null>(null);
  const [card, setCard] = createStore<{ c: CardState | null }>({ c: null });
  const [cardSubmitting, setCardSubmitting] = createSignal(false);
  const [sourcesStatus, setSourcesStatus] = createSignal<SourcesStatus | null>(null);

  // Tidal (seção do Crate, backend = fila remota na VM): estado da fila é
  // ciclo próprio (poll de 10s), independente da busca Soulseek/SoundCloud.
  const [tidalJobs, setTidalJobs] = createSignal<TidalJob[]>([]);
  const [tidalPastas, setTidalPastas] = createSignal<string[]>([]);
  const [tidalLoad, setTidalLoad] = createSignal<"loading" | "loaded" | "error">("loading");
  const [tidalLoadError, setTidalLoadError] = createSignal<string | null>(null);
  const [tidalUrl, setTidalUrl] = createSignal("");
  const [tidalDest, setTidalDest] = createSignal(loadLastTidalDest() ?? "");
  const [tidalCustomDest, setTidalCustomDest] = createSignal(false);
  const [tidalCustomName, setTidalCustomName] = createSignal("");
  const [tidalSubmitting, setTidalSubmitting] = createSignal(false);
  const [tidalFormError, setTidalFormError] = createSignal<string | null>(null);

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
  let sourcesTimer: ReturnType<typeof setInterval> | undefined;
  let tidalTimer: ReturnType<typeof setInterval> | undefined;
  /** Número da chamada de doSearch mais recente (só ela baixa o pending). */
  let searchSeq = 0;
  /** Idem para a busca do SoundCloud e para o card (resposta atrasada de
      uma busca ou de um card anterior é descartada). */
  let scSeq = 0;
  let cardSeq = 0;
  /** Última busca de texto mandada ao SoundCloud: o "Buscar mesmo assim"
      com a busca editada refaz também essa seção. */
  let lastScQuery: string | null = null;

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

  /** Job da faixa do SoundCloud, pela origem: o job_id é determinístico
      por track_id, então o board diz se a faixa já está baixando ou
      pronta, inclusive de uma sessão anterior. */
  function scJobFor(trackId: number): DownloadJob | null {
    return (
      jobs().find(
        (j) => j.source.kind === "sound_cloud" && j.source.track_id === trackId && j.state.kind !== "canceled",
      ) ?? null
    );
  }

  /** Busca (ou resolve de link colado) no SoundCloud. Não passa pelo
      pacer do Soulseek: o backend tem o pacer próprio do SoundCloud. */
  async function scSearch(q: string, isLink: boolean) {
    const seq = ++scSeq;
    lastScQuery = isLink ? null : q;
    closeCard();
    setScError(null);
    setScResults([]);
    setScState("loading");
    try {
      const res = isLink ? [await crateScResolve(q)] : await crateScSearch(q);
      if (seq !== scSeq) return;
      setScResults(res);
      setScState(res.length > 0 ? "done" : "empty");
    } catch (e) {
      if (seq !== scSeq) return;
      setScError(errorText(e));
      setScState("error");
    }
  }

  function closeCard() {
    const id = card.c?.r.id;
    // Foco dentro do card que vai sumir volta para a linha (o Baixar
    // reaparece quando a faixa segue idle; senão, a primeira ação dela).
    // Card fechado por uma busca nova não rouba o foco do campo.
    const hadFocus = !!(document.activeElement as HTMLElement | null)?.closest?.(".crate-card");
    cardSeq++;
    setCardSubmitting(false);
    setOpenDest((k) => (k != null && k.startsWith("sc:") ? null : k));
    setCard("c", null);
    if (hadFocus && id != null) {
      queueMicrotask(() => {
        document
          .querySelector<HTMLElement>(`.crate-row-wrap[data-sc-id="${id}"] .crate-r-act button`)
          ?.focus();
      });
    }
  }

  /** Abre o card na linha: pré-preenche pelo guessFromSoundCloud e
      dispara sondagem, capa e dedup (spec §5.2). Destino na mesma
      precedência do Soulseek (CLAUDE.md, spec §4.5): override da
      toolbar > artista no acervo > último usado. */
  function openCard(r: ScResult) {
    const seq = ++cardSeq;
    const meta = guessFromSoundCloud(r);
    setCardSubmitting(false);
    setCard("c", {
      r,
      meta,
      probe: null,
      probeErr: null,
      cover: null,
      dest: destOverride() ?? r.suggested_dest ?? loadLastDest(),
      dedup: null,
    });
    const live = () => seq === cardSeq && card.c != null;
    crateScProbe(r.id, r.duration_ms)
      .then((p) => { if (live()) setCard("c", "probe", p); })
      .catch((e) => { if (live()) setCard("c", "probeErr", errorText(e) || "erro desconhecido"); });
    if (r.artwork_url) {
      crateScArtwork(r.artwork_url)
        .then((url) => { if (live()) setCard("c", "cover", url); })
        .catch(() => {}); // capa é melhor esforço
    }
  }

  // Aviso de duplicata do card com os campos CONFIRMADOS (spec §5.2): na
  // abertura consulta na hora; a cada correção de artista ou título,
  // depois de 300 ms sem digitar. Resposta de um texto ou card que já
  // mudou é descartada.
  const DEDUP_DEBOUNCE_MS = 300;
  const dedupQuery = createMemo(() => {
    const c = card.c;
    return c ? { id: c.r.id, q: `${c.meta.artist} ${c.meta.title}`.trim() } : null;
  }, null, { equals: (a, b) => a?.id === b?.id && a?.q === b?.q });
  let dedupSeq = 0;
  createEffect(on(dedupQuery, (cur, prev) => {
    const seq = ++dedupSeq;
    if (!cur || !cur.q) return;
    const run = () => {
      slskDedupProbe(cur.q)
        .then((tracks) => { if (seq === dedupSeq && card.c) setCard("c", "dedup", dedupMatch(cur.q, tracks)); })
        .catch(() => {});
    };
    if (!prev || prev.id !== cur.id) { run(); return; }
    const t = setTimeout(run, DEDUP_DEBOUNCE_MS);
    onCleanup(() => clearTimeout(t));
  }));

  async function submitCard() {
    const c = card.c;
    if (!c || !c.dest || cardSubmitting()) return;
    const seq = cardSeq;
    const title = c.meta.title.trim();
    const meta: ConfirmedMeta = {
      artist: c.meta.artist.trim(),
      title,
      // Single: o álbum é o próprio título (spec §3.3, item 5).
      album: title,
      year: c.meta.year,
      label: null,
    };
    const dest = c.dest;
    setCardSubmitting(true);
    setNotice(null);
    try {
      await crateDownload(
        { kind: "sound_cloud", track_id: c.r.id, permalink_url: c.r.permalink_url },
        meta,
        dest,
        c.r.artwork_url,
      );
      saveLastDest(dest);
      if (seq === cardSeq) closeCard();
    } catch (e) {
      console.error("[crate] crateDownload falhou:", e);
      setNotice(`Não deu pra baixar "${title}": ${errorText(e)}.`);
      if (seq === cardSeq) setCardSubmitting(false);
    }
  }

  function showSourcesStatus() {
    const el = document.getElementById("crate-sources");
    el?.scrollIntoView?.({ block: "nearest" });
    el?.focus();
  }

  const scStatusLabel = () => {
    const st = sourcesStatus();
    if (!st) return "verificando…";
    return st.soundcloud === "token_ok" ? "token ok" : st.soundcloud === "no_token" ? "sem token" : "API indisponível";
  };

  // ── Tidal ──────────────────────────────────────────────────────
  function refreshTidal() {
    crateTidalJobs().then((snap) => {
      batch(() => {
        setTidalJobs(snap.jobs);
        setTidalPastas(snap.pastas);
        setTidalLoad("loaded");
        setTidalLoadError(null);
      });
    }).catch((e) => {
      batch(() => {
        setTidalLoad("error");
        setTidalLoadError(errorText(e));
      });
    });
  }

  /** Pasta efetiva: campo de texto quando "outra pasta..." está selecionado,
      senão o valor do <select> (que já nasce do último usado). */
  const resolvedTidalDest = () => (tidalCustomDest() ? tidalCustomName().trim() : tidalDest());

  async function submitTidal(e: Event) {
    e.preventDefault();
    const url = tidalUrl().trim();
    const dest = resolvedTidalDest();
    if (!url || !dest || tidalSubmitting()) return;
    setTidalSubmitting(true);
    setTidalFormError(null);
    try {
      await crateTidalEnqueue(url, dest);
      batch(() => {
        setTidalUrl("");
        if (tidalCustomDest()) {
          saveLastTidalDest(dest);
          setTidalDest(dest);
          setTidalCustomDest(false);
          setTidalCustomName("");
        } else {
          saveLastTidalDest(dest);
        }
      });
      refreshTidal();
    } catch (err) {
      setTidalFormError(errorText(err));
    } finally {
      setTidalSubmitting(false);
    }
  }

  // Seletor de destino aberto = popover: fecha com clique fora de qualquer
  // `.crate-dest` e com Esc (crate-11, pendência v1.1 do CLAUDE.md).
  // Listeners só existem enquanto há um aberto. O Esc vem da pilha única
  // (lib/escLayers): a ⌘K por cima trata o próprio Esc antes, o Tweaks
  // aberto por baixo espera o próximo. Devolve o foco ao chip quando ele
  // estava dentro do menu que vai sumir.
  createEffect(() => {
    if (openDest() == null) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (!t?.closest?.(".crate-dest")) setOpenDest(null);
    };
    const onEsc = () => {
      const owner = (document.activeElement as HTMLElement | null)?.closest?.(".crate-dest");
      setOpenDest(null);
      owner?.querySelector<HTMLElement>(".crate-dest__btn")?.focus();
    };
    document.addEventListener("mousedown", onDown, true);
    onCleanup(pushEscLayer(onEsc));
    onCleanup(() => document.removeEventListener("mousedown", onDown, true));
  });

  // Card aberto = camada de Esc (cancela). Depende só de QUAL card está
  // aberto (reempilhar a cada tecla passaria o card por cima do seletor
  // de playlist aberto dentro dele) e de a aba Buscar estar à vista: na
  // Fila o card fica escondido, e o Esc seria consumido sem efeito
  // visível. O card sobrevive à troca de aba com o que já foi editado.
  const cardOpenId = createMemo(() => card.c?.r.id ?? null);
  createEffect(on([cardOpenId, tab], ([id, t]) => {
    if (id == null || t !== "search") return;
    onCleanup(pushEscLayer(closeCard));
  }));

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
    if (BC_LINK.test(q)) {
      setNotice("Links do Bandcamp chegam na próxima versão.");
      return;
    }
    if (SC_LINK.test(q)) {
      // Link do SoundCloud: resolve direto, sem busca no Soulseek.
      setNotice(null);
      setDedupTrack(null);
      const prev = searchId();
      if (prev) slskCancelSearch(prev).catch(() => {});
      setSearchId(null);
      applySnapshot(null);
      void scSearch(q, true);
      return;
    }
    // O SoundCloud é independente do pacer do Soulseek (tem o pacer
    // próprio no backend) e sai em paralelo, sem esperar a resposta do
    // slsk_search (com o slskd fora do ar ela só volta no timeout). A
    // exceção é o cooldown que o front JÁ conhece: com ele correndo, o
    // SoundCloud espera o aceite do pacer (crate-8), para uma recusa
    // previsível não trocar só a seção dele. Recusa que o front não
    // previa (a primeira de um cooldown, por exemplo ⌘K duas vezes em
    // menos de 4 s, ou o limite de 40/h) deixa as seções em buscas
    // diferentes: o SoundCloud já foi para a nova e o Soulseek fica na
    // anterior, com o aviso da recusa. "Buscar mesmo assim" (force) é da
    // rede fria do Soulseek: a seção do SoundCloud dessa busca já veio,
    // a não ser que a busca tenha sido editada antes do clique.
    if (cooldownLeft() === 0 && (!force || q !== lastScQuery)) void scSearch(q, false);
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
      if (lastScQuery !== q) void scSearch(q, false);
      setSearchId(id);
      applySnapshot(null);
      setSelectedKey(null);
      setExpandedKey(null);
      setOpenDest((k) => (k === TOOLBAR_DEST ? k : null));
      setGroupJobs({});
      setRowOverrides({});
      slskDedupProbe(q).then((tracks) => setDedupTrack(dedupMatch(q, tracks))).catch(() => setDedupTrack(null));
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

  /** Refaz um job de origem externa que terminou em falha, com a mesma
      origem, o metadado já confirmado, o destino e a capa. */
  async function handleRetry(job: DownloadJob) {
    setNotice(null);
    try {
      await crateDownload(job.source, job.meta, job.dest_playlist, job.artwork_url);
    } catch (e) {
      console.error("[crate] crateDownload (tentar de novo) falhou:", e);
      setNotice(`Não deu pra tentar de novo "${job.display}": ${errorText(e)}.`);
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
    const refreshSources = () => { crateSourcesStatus().then(setSourcesStatus).catch(() => {}); };
    refreshSources();
    sourcesTimer = setInterval(refreshSources, SOURCES_POLL_MS);

    refreshTidal();
    tidalTimer = setInterval(refreshTidal, TIDAL_POLL_MS);

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
      if (sourcesTimer) clearInterval(sourcesTimer);
      if (tidalTimer) clearInterval(tidalTimer);
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
        <button
          role="tab"
          aria-selected={tab() === "search"}
          class={`tab${tab() === "search" ? " active" : ""}`}
          onClick={() => setTab("search")}
        >
          Buscar <Show when={groups().length > 0}><span class="tab__count">{groups().length}</span></Show>
        </button>
        <button
          role="tab"
          aria-selected={tab() === "queue"}
          class={`tab${tab() === "queue" ? " active" : ""}`}
          onClick={() => setTab("queue")}
        >
          Fila <Show when={jobs().length > 0}><span class="tab__count">{jobs().length}</span></Show>
        </button>
        <button
          role="tab"
          aria-selected={tab() === "tidal"}
          class={`tab${tab() === "tidal" ? " active" : ""}`}
          onClick={() => setTab("tidal")}
        >
          Tidal <Show when={tidalJobs().length > 0}><span class="tab__count">{tidalJobs().length}</span></Show>
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
                placeholder="Buscar no Soulseek e SoundCloud, ou colar link do Bandcamp"
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
                    // Consumido: o Tweaks aberto por baixo espera o próximo Esc.
                    e.preventDefault();
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

            {/* Status das fontes novas (spec §5.4), um indicador por
                dependência; o do SoundCloud é o alvo do "ver status" do
                card quando falta o token. */}
            <span
              id="crate-sources"
              class="crate-net-status crate-src-status"
              tabindex="-1"
              data-on={sourcesStatus()?.soundcloud === "token_ok" ? "true" : "false"}
            >
              <span class="crate-net-status__dot" />
              SoundCloud: {scStatusLabel()}
            </span>
            <span class="crate-net-status crate-src-status" data-on={sourcesStatus()?.ffmpeg ? "true" : "false"}>
              <span class="crate-net-status__dot" />
              ffmpeg: {sourcesStatus() ? (sourcesStatus()!.ffmpeg ? "ok" : "ausente") : "…"}
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

          <Show when={scState() !== "idle"}>
            <section class="crate-section" role="group" aria-label="SoundCloud">
              <div class="crate-section__head">
                <h2>
                  SoundCloud
                  <Show when={scState() === "done"}> · {scResults().length}</Show>
                  <Show when={scState() === "loading"}> · Buscando…</Show>
                </h2>
                <Show when={scState() === "empty"}>
                  <span class="crate-section__note">nada no SoundCloud</span>
                </Show>
                <Show when={scState() === "error"}>
                  <span class="crate-section__note" data-tone="err">
                    SoundCloud indisponível ({scError()})
                  </span>
                </Show>
              </div>
              <Show when={scResults().length > 0}>
                <div class="crate-list">
                  <div class="crate-list-inner">
                    <For each={scResults()}>
                      {(r) => (
                        <ScRow
                          r={r}
                          job={scJobFor(r.id)}
                          cardOpen={card.c?.r.id === r.id}
                          onDownload={() => openCard(r)}
                          onCancel={handleCancel}
                          onRetry={(j) => void handleRetry(j)}
                        >
                          <Show when={card.c && card.c.r.id === r.id ? card.c : null}>
                            {(c) => (
                              <ConfirmCard
                                c={c()}
                                folders={folders()}
                                destOpen={openDest() === `sc:${r.id}`}
                                submitting={cardSubmitting()}
                                onDestToggle={() => setOpenDest((k) => (k === `sc:${r.id}` ? null : `sc:${r.id}`))}
                                onPickDest={(f) => { setCard("c", "dest", f); setOpenDest(null); }}
                                onField={(field, value) => setCard("c", "meta", field, value)}
                                onYear={(y) => setCard("c", "meta", "year", y)}
                                onSubmit={() => void submitCard()}
                                onCancel={closeCard}
                                onShowStatus={showSourcesStatus}
                              />
                            )}
                          </Show>
                        </ScRow>
                      )}
                    </For>
                  </div>
                </div>
              </Show>
            </section>
          </Show>

          <Show when={searchId()}>
            <div class="crate-list-head">
              {/* Durante a busca: respostas que já chegaram + barra contra a
                  janela de 25 s (spec §6.1). Antes era 'Resultados · 0
                  faixas', que parece resultado final (crate-8). */}
              <Show
                when={searching()}
                fallback={<h2>Soulseek · {groups().length}&nbsp;faixas</h2>}
              >
                <div class="crate-list-head__lead">
                  <h2>
                    Soulseek · Buscando · {responsesSeen()}&nbsp;{responsesSeen() === 1 ? "resposta" : "respostas"}
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
              aria-activedescendant={`crate-row-${selectedIndex()}`}
              onKeyDown={handleListKey}
            >
              <div class="crate-list-inner">
                <For each={groups()}>
                  {(g, i) => (
                    <CrateRow
                      rowId={`crate-row-${i()}`}
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

          <Show when={!searchId() && !searching() && scState() === "idle"}>
            <div class="crate-empty-wrap">
              <div class="crate-empty">
                <Icon name={ICONS.packageOpen} size={26} />
                <h3>Nada buscado ainda</h3>
                <p>A busca só dispara no Enter — o Crate nunca busca enquanto você digita.</p>
                <div class="crate-empty__hintline">
                  <kbd class="crate-kbd">{modCombo("K")}</kbd> → digite → <kbd class="crate-kbd">Procurar na rede</kbd>
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
                      onRetry={() => void handleRetry(j)}
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
                        onRetry={() => void handleRetry(j)}
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

        <Show when={tab() === "tidal"}>
          <div class="crate-tidal">
            <form class="crate-tidal-form" onSubmit={(e) => void submitTidal(e)}>
              <div class="crate-tidal-form__row">
                <input
                  type="url"
                  class="crate-tidal-input"
                  placeholder="Cole o link da Tidal (mix, playlist, álbum ou faixa)"
                  value={tidalUrl()}
                  disabled={sourcesStatus()?.tidal === "no_token"}
                  onInput={(e) => setTidalUrl(e.currentTarget.value)}
                />
                <select
                  class="crate-tidal-select"
                  value={tidalCustomDest() ? "__nova__" : tidalDest()}
                  disabled={sourcesStatus()?.tidal === "no_token"}
                  onChange={(e) => {
                    const v = e.currentTarget.value;
                    if (v === "__nova__") { setTidalCustomDest(true); return; }
                    setTidalCustomDest(false);
                    setTidalDest(v);
                  }}
                >
                  {/* O destino lembrado (localStorage) pode não estar mais
                      entre as pastas que a VM conhece agora — entra como
                      opção própria pra não sumir do seletor sem aviso. */}
                  <Show when={tidalDest() && !tidalPastas().includes(tidalDest())}>
                    <option value={tidalDest()}>{tidalDest()}</option>
                  </Show>
                  <For each={tidalPastas()}>{(p) => <option value={p}>{p}</option>}</For>
                  <option value="__nova__">outra pasta...</option>
                </select>
                <Show when={tidalCustomDest()}>
                  <input
                    type="text"
                    class="crate-tidal-input crate-tidal-input--dest"
                    placeholder="nome da pasta nova"
                    value={tidalCustomName()}
                    onInput={(e) => setTidalCustomName(e.currentTarget.value)}
                  />
                </Show>
                <button
                  type="submit"
                  class="crate-btn crate-btn--primary"
                  disabled={
                    tidalSubmitting() || !tidalUrl().trim() || !resolvedTidalDest()
                    || sourcesStatus()?.tidal === "no_token"
                  }
                >
                  {tidalSubmitting() ? "Enviando…" : "Baixar"}
                </button>
              </div>
              <Show when={tidalFormError()}>
                {(err) => <p class="crate-tidal-form__err">{err()}</p>}
              </Show>
            </form>

            <Show when={sourcesStatus()?.tidal === "no_token"}>
              <div class="crate-banner" data-tone="amber">
                <Icon name={ICONS.alert} size={15} />
                <p>
                  Sem token da fila: configure <code>~/.secrets/telemetria-token.txt</code>{" "}
                  (ou <code>RUSTIFY_TIDAL_FILA_TOKEN_FILE</code> para outro caminho).
                </p>
              </div>
            </Show>

            <Show when={tidalLoad() === "error"}>
              <div class="crate-banner" data-tone="amber">
                <Icon name={ICONS.alert} size={15} />
                <p>{tidalLoadError() ?? "fila indisponível (VM fora?)"}</p>
                <span class="crate-banner__sp" />
                <button type="button" class="crate-banner__act" onClick={refreshTidal}>
                  Tentar de novo
                </button>
              </div>
            </Show>

            <Show when={tidalLoad() === "loading" && tidalJobs().length === 0}>
              <div class="crate-empty-wrap">
                <div class="crate-empty">
                  <Icon name={ICONS.download} size={26} />
                  <h3>Carregando…</h3>
                </div>
              </div>
            </Show>

            <Show when={tidalLoad() === "loaded" && tidalJobs().length === 0}>
              <div class="crate-empty-wrap">
                <div class="crate-empty">
                  <Icon name={ICONS.download} size={26} />
                  <h3>Nenhum download da Tidal ainda</h3>
                  <p>Cole um link acima e escolha a pasta.</p>
                </div>
              </div>
            </Show>

            <Show when={tidalJobs().length > 0}>
              <div class="crate-list crate-tidal-list">
                <div class="crate-list-inner">
                  <For each={[...tidalJobs()].reverse()}>
                    {(j) => <TidalJobRow job={j} />}
                  </For>
                </div>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </article>
  );
}
