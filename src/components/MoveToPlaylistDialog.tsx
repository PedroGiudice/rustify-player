// src/components/MoveToPlaylistDialog.tsx — "Mover para playlist…" (CMR-298).
// Singleton montado no App; abre por openMoveDialog (menu de contexto da
// faixa, cabeçalho de Álbum e Artista). Reaproveita a casca da ⌘K
// (.palette-scrim/.palette) e os botões do Crate (.crate-btn).
//
// Fases: escolher destino -> confirmar (lote, ou pasta nova sempre) ->
// movendo -> resultado (com Desfazer). O backend leva vetores, like/vibe e
// plays para o id novo; aqui só se mostra o andamento e o resultado.
//
// Teclado (A34): o primário de cada fase recebe o foco, o Tab fica preso no
// diálogo e o foco volta a quem o abriu. Desfazer (B4) move de volta pelo
// mesmo lib_move_tracks, nunca com `mv` cru.
import {
  For, Match, Show, Switch, createEffect, createMemo, createResource, createSignal, on, onCleanup, onMount,
} from "solid-js";
import { Portal } from "solid-js/web";
import { libListPlaylists, libMoveTracks, type MoveReport } from "../tauri";
import { moveRequest, closeMoveDialog, type MoveRequest } from "../store/moveDialog";
import { pushEscLayer } from "../lib/escLayers";
import { rememberFocus, trapTab } from "../lib/focusReturn";
import {
  MOVE_CHUNK, chunk, confirmText, createConfirmText, existingFolderMatch, filterPlaylists, mergeReports,
  newFolderCandidate, plural, summaryText, undoPlan, undoSummaryText,
} from "../lib/moveToPlaylist";
import { deselectIds } from "../store/selection";
import { Icon, ICONS } from "./Icon";

export function MoveToPlaylistDialog() {
  return (
    <Show when={moveRequest()}>
      {(req) => <MoveDialogBody req={req()} />}
    </Show>
  );
}

type Phase = "pick" | "confirm" | "running" | "done";

/** Sem avanço por este tempo, o "movendo" ganha um Fechar (a mudança segue). */
export const STALL_MS = 30_000;

interface Job { ids: string[]; target: string }

function MoveDialogBody(props: { req: MoveRequest }) {
  const [names] = createResource(() => libListPlaylists());
  const [query, setQuery] = createSignal("");
  const [phase, setPhase] = createSignal<Phase>("pick");
  const [dest, setDest] = createSignal("");
  const [isNew, setIsNew] = createSignal(false);
  const [mode, setMode] = createSignal<"move" | "undo">("move");
  const [progress, setProgress] = createSignal(0);
  const [runTotal, setRunTotal] = createSignal(0);
  const [report, setReport] = createSignal<MoveReport | null>(null);
  const [undoOrphans, setUndoOrphans] = createSignal(0);
  const [escTried, setEscTried] = createSignal(false);
  const [stalled, setStalled] = createSignal(false);
  let inputEl: HTMLInputElement | undefined;
  let dlgEl: HTMLDivElement | undefined;

  const total = () => props.req.tracks.length;
  // Pasta atual de cada faixa (genre = pasta de 1º nível): marcada na lista.
  const current = createMemo(() => new Set(props.req.tracks.map((t) => t.genre_name).filter(Boolean) as string[]));
  const filtered = createMemo(() => filterPlaylists(names() ?? [], query()));
  const candidate = createMemo(() => newFolderCandidate(names() ?? [], query()));
  const collision = createMemo(() => existingFolderMatch(names() ?? [], query()));
  const onlyCurrent = (n: string) => current().size === 1 && current().has(n);

  const close = () => {
    // Movendo, o Esc não interrompe (o lote já está no indexador): diz isso
    // em vez de não fazer nada calado.
    if (phase() === "running" && !stalled()) { setEscTried(true); return; }
    closeMoveDialog();
  };

  onMount(() => {
    const focusRet = rememberFocus();
    const pop = pushEscLayer(close);
    onCleanup(() => { pop(); focusRet.restore({ within: dlgEl }); });
  });

  // Foco no primário de cada fase: o campo, "Mover", o próprio corpo enquanto
  // move (o primário some), "Fechar" no resultado.
  createEffect(on(phase, () => {
    requestAnimationFrame(() => {
      if (phase() === "pick") inputEl?.focus();
      else dlgEl?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    });
  }));

  // Relógio de avanço do "movendo": 30 s sem progresso libera o Fechar.
  createEffect(() => {
    if (phase() !== "running") { setStalled(false); return; }
    progress();
    setStalled(false);
    const t = setTimeout(() => setStalled(true), STALL_MS);
    onCleanup(() => clearTimeout(t));
  });

  const pick = (name: string, fresh = false) => {
    if (onlyCurrent(name)) return;
    setDest(name);
    setIsNew(fresh);
    if (total() === 1 && !fresh) void runMove(name);
    else setPhase("confirm");
  };

  async function runJobs(jobs: Job[]): Promise<MoveReport> {
    setPhase("running");
    setEscTried(false);
    setProgress(0);
    setRunTotal(jobs.reduce((n, j) => n + j.ids.length, 0));
    const reports: MoveReport[] = [];
    for (const job of jobs) {
      for (const ids of chunk(job.ids, MOVE_CHUNK)) {
        try {
          reports.push(await libMoveTracks(ids, job.target));
        } catch (e) {
          console.error("[move] lib_move_tracks falhou:", e);
          reports.push({
            dest_playlist: job.target, moved: 0, already_there: 0, failed: ids.length, pending: 0,
            items: ids.map((id) => ({
              track_id: id, new_track_id: null, new_path: null, new_lrc_path: null,
              title: null, status: "failed" as const, detail: "o indexador não respondeu ao pedido.",
            })),
          });
        }
        setProgress((n) => n + ids.length);
      }
    }
    // A fila e as views se atualizam pelo evento lib-tracks-moved
    // (applyMovedReport, assinado no App), que o backend emite por lote.
    return mergeReports(jobs[0]?.target ?? "", reports);
  }

  async function runMove(target: string) {
    setMode("move");
    const merged = await runJobs([{ ids: props.req.tracks.map((t) => t.id), target }]);
    setReport(merged);
    // Seleção múltipla: sai da seleção só o que o relatório deu como movido
    // ou já no destino. Falhas e pendentes continuam marcados; uma faixa
    // movida pelo menu de faixa única não apaga as outras marcadas.
    deselectIds(merged.items.filter((i) => i.status === "moved" || i.status === "already_there").map((i) => i.track_id));
    setPhase("done");
  }

  // Ids novos das faixas movidas -> faixa original (título no relatório do Desfazer).
  const movedTitle = createMemo(() => {
    const m = new Map<string, string>();
    for (const it of report()?.items ?? []) {
      const t = props.req.tracks.find((x) => x.id === it.track_id);
      if (it.new_track_id && t?.title) m.set(it.new_track_id, t.title);
    }
    return m;
  });

  async function runUndo() {
    const r = report();
    if (!r) return;
    const plan = undoPlan(r, props.req.tracks);
    if (plan.groups.length === 0) return;
    setMode("undo");
    setUndoOrphans(plan.orphans.length);
    setDest(plan.groups.length === 1 ? plan.groups[0].dest : "");
    const merged = await runJobs(plan.groups.map((g) => ({ ids: g.ids, target: g.dest })));
    setReport(merged);
    setPhase("done");
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    // Nome exato existente > primeira da lista filtrada > pasta nova (confirma).
    const q = query().trim().toLowerCase();
    const exact = (names() ?? []).find((n) => n.toLowerCase() === q);
    const first = filtered().find((n) => !onlyCurrent(n));
    const c = candidate();
    if (exact) pick(exact);
    else if (first) pick(first);
    else if (c) pick(c, true);
  };

  const failures = () => (report()?.items ?? []).filter((i) => i.status === "failed");
  const warnings = () => (report()?.items ?? []).filter((i) => i.status === "moved" && i.detail);
  const titleOf = (id: string, fallback: string | null) =>
    fallback ?? props.req.tracks.find((t) => t.id === id)?.title ?? movedTitle().get(id) ?? id;
  const canUndo = () => mode() === "move" && (report()?.moved ?? 0) > 0
    && undoPlan(report()!, props.req.tracks).groups.length > 0;
  const runningLine = () => mode() === "undo"
    ? `Desfazendo: ${progress()} de ${runTotal()}`
    : `Movendo ${progress()} de ${runTotal()} para ${dest()}`;

  return (
    <Portal mount={document.body}>
      <div
        class="palette-scrim palette-scrim--mount"
        data-open="true"
        onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}
      >
        <div
          ref={dlgEl}
          class="palette move-dlg"
          role="dialog"
          aria-modal="true"
          aria-label="Mover para playlist"
          tabIndex={-1}
          onKeyDown={(e) => { if (dlgEl) trapTab(e, dlgEl); }}
        >
          <Switch>
            <Match when={phase() === "pick"}>
              <div class="palette__input-row">
                <span class="palette__icon"><Icon name={ICONS.moveTo} /></span>
                <input
                  ref={inputEl}
                  class="palette__input"
                  placeholder="Escolher playlist ou digitar uma nova pasta"
                  value={query()}
                  onInput={(e) => setQuery(e.currentTarget.value)}
                  onKeyDown={onKeyDown}
                  aria-label="Playlist de destino"
                />
                <span class="palette__esc">esc</span>
              </div>
              <div class="palette__list" role="listbox">
                <div class="palette__section">
                  {props.req.label ? `${props.req.label} · ` : ""}{plural(total(), "faixa", "faixas")}
                </div>
                <Show when={!names.error} fallback={
                  <div class="move-dlg__msg move-dlg__msg--err">Não foi possível ler as pastas de ~/Music.</div>
                }>
                  <Show when={names.loading}>
                    <div class="move-dlg__msg">Carregando as pastas…</div>
                  </Show>
                  <Show when={candidate()}>
                    {(c) => (
                      <button type="button" class="palette__item move-dlg__item" onClick={() => pick(c(), true)}>
                        <span class="palette__item-icon"><Icon name={ICONS.folderPlus} /></span>
                        <span class="palette__item-text">
                          <span class="palette__item-title">Nova pasta “{c()}”</span>
                          <span class="palette__item-sub">
                            {c() === query().trim() ? `~/Music/${c()}` : `será criada como ~/Music/${c()}`}
                          </span>
                        </span>
                      </button>
                    )}
                  </Show>
                  <Show when={collision() && !filtered().includes(collision()!) ? collision() : null}>
                    {(name) => (
                      <div class="move-dlg__collide">
                        <span>Já existe a playlist “{name()}”.</span>
                        <button
                          type="button"
                          class="crate-btn"
                          disabled={onlyCurrent(name())}
                          onClick={() => pick(name())}
                        >
                          Usar essa
                        </button>
                      </div>
                    )}
                  </Show>
                  <For each={filtered()}>
                    {(n) => (
                      <button
                        type="button"
                        class="palette__item move-dlg__item"
                        disabled={onlyCurrent(n)}
                        onClick={() => pick(n)}
                      >
                        <span class="palette__item-icon"><Icon name={ICONS.folder} /></span>
                        <span class="palette__item-text">
                          <span class="palette__item-title">{n}</span>
                        </span>
                        <Show when={current().has(n)}>
                          <span class="palette__item-hint">atual</span>
                        </Show>
                      </button>
                    )}
                  </For>
                  <Show when={!names.loading && filtered().length === 0 && !candidate() && !collision()}>
                    <div class="move-dlg__msg">
                      {query().trim()
                        ? "Nome inválido: depois de limpar os caracteres proibidos, não pode ficar vazio nem começar com . ou _."
                        : "Nenhuma playlist em ~/Music. Digite um nome para criar a pasta."}
                    </div>
                  </Show>
                </Show>
              </div>
            </Match>

            <Match when={phase() === "confirm"}>
              <div class="move-dlg__body">
                <p class="move-dlg__line">
                  {isNew() ? createConfirmText(total(), dest()) : confirmText(total(), props.req.label, dest())}
                </p>
                <p class="move-dlg__hint">Likes, plays e letras acompanham as faixas.</p>
                <div class="move-dlg__acts">
                  <button type="button" class="crate-btn" onClick={() => setPhase("pick")}>Voltar</button>
                  <button
                    type="button"
                    class="crate-btn crate-btn--primary"
                    data-autofocus
                    onClick={() => void runMove(dest())}
                  >
                    {isNew() ? "Criar e mover" : "Mover"}
                  </button>
                </div>
              </div>
            </Match>

            <Match when={phase() === "running"}>
              <div class="move-dlg__body" tabIndex={-1} data-autofocus>
                <p class="move-dlg__line" aria-live="polite">{runningLine()}</p>
                <div class="move-dlg__bar">
                  <div style={{ transform: `scaleX(${runTotal() ? progress() / runTotal() : 0})` }} />
                </div>
                <Show when={stalled()} fallback={
                  <Show when={escTried()}>
                    <p class="move-dlg__hint">O Esc não interrompe: {progress()} de {runTotal()} já foram.</p>
                  </Show>
                }>
                  <p class="move-dlg__hint">
                    Sem avanço há 30 s. Pode fechar: o indexador termina sozinho e a biblioteca se atualiza.
                  </p>
                  <div class="move-dlg__acts">
                    <button type="button" class="crate-btn" onClick={closeMoveDialog}>Fechar</button>
                  </div>
                </Show>
              </div>
            </Match>

            <Match when={phase() === "done"}>
              <div class="move-dlg__body" aria-live="polite">
                <p class="move-dlg__line">
                  <Icon name={(report()?.failed ?? 0) > 0 || (report()?.pending ?? 0) > 0 ? ICONS.alert : ICONS.check} size={14} />
                  <span>{report() ? (mode() === "undo" ? undoSummaryText(report()!) : summaryText(report()!)) : ""}</span>
                  <span class="move-dlg__dest">
                    {mode() === "undo" ? (dest() ? `para ${dest()}` : "para as pastas de origem") : `em ${dest()}`}
                  </span>
                </p>
                <Show when={(report()?.pending ?? 0) > 0}>
                  <p class="move-dlg__hint">
                    O indexador ainda está trabalhando nessas faixas; a biblioteca se atualiza sozinha quando terminar.
                  </p>
                </Show>
                <Show when={mode() === "undo" && undoOrphans() > 0}>
                  <p class="move-dlg__hint">
                    {plural(undoOrphans(), "faixa ficou", "faixas ficaram")} no destino: a pasta de origem não é conhecida.
                  </p>
                </Show>
                <Show when={failures().length > 0 || warnings().length > 0}>
                  <ul class="move-dlg__list">
                    <For each={failures()}>
                      {(i) => (
                        <li data-tone="err">
                          <b>{titleOf(i.track_id, i.title)}</b> {i.detail}
                        </li>
                      )}
                    </For>
                    <For each={warnings()}>
                      {(i) => (
                        <li>
                          <b>{titleOf(i.track_id, i.title)}</b> movida; {i.detail}
                        </li>
                      )}
                    </For>
                  </ul>
                </Show>
                <div class="move-dlg__acts">
                  <Show when={canUndo()}>
                    <button type="button" class="crate-btn" onClick={() => void runUndo()}>Desfazer</button>
                  </Show>
                  <button type="button" class="crate-btn crate-btn--primary" data-autofocus onClick={closeMoveDialog}>
                    Fechar
                  </button>
                </div>
              </div>
            </Match>
          </Switch>
        </div>
      </div>
    </Portal>
  );
}
