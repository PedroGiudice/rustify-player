// src/components/MoveToPlaylistDialog.tsx — "Mover para playlist…" (CMR-298).
// Singleton montado no App; abre por openMoveDialog (menu de contexto da
// faixa, cabeçalho de Álbum e Artista). Reaproveita a casca da ⌘K
// (.palette-scrim/.palette) e os botões do Crate (.crate-btn).
//
// Fases: escolher destino -> (lote) confirmar -> movendo -> resultado.
// O backend leva vetores, like/vibe e plays para o id novo; aqui só se
// mostra o andamento e o resultado.
import { For, Match, Show, Switch, createMemo, createResource, createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { libListPlaylists, libMoveTracks, type MoveReport } from "../tauri";
import { moveRequest, closeMoveDialog, type MoveRequest } from "../store/moveDialog";
import { pushEscLayer } from "../lib/escLayers";
import {
  MOVE_CHUNK, chunk, confirmText, filterPlaylists, mergeReports, newFolderCandidate, plural,
  summaryText,
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

function MoveDialogBody(props: { req: MoveRequest }) {
  const [names] = createResource(() => libListPlaylists());
  const [query, setQuery] = createSignal("");
  const [phase, setPhase] = createSignal<Phase>("pick");
  const [dest, setDest] = createSignal("");
  const [progress, setProgress] = createSignal(0);
  const [report, setReport] = createSignal<MoveReport | null>(null);
  let inputEl: HTMLInputElement | undefined;

  const total = () => props.req.tracks.length;
  // Pasta atual de cada faixa (genre = pasta de 1º nível): marcada na lista.
  const current = createMemo(() => new Set(props.req.tracks.map((t) => t.genre_name).filter(Boolean) as string[]));
  const filtered = createMemo(() => filterPlaylists(names() ?? [], query()));
  const candidate = createMemo(() => newFolderCandidate(names() ?? [], query()));
  const onlyCurrent = (n: string) => current().size === 1 && current().has(n);

  const close = () => { if (phase() !== "running") closeMoveDialog(); };
  onMount(() => {
    const pop = pushEscLayer(close);
    onCleanup(pop);
    requestAnimationFrame(() => inputEl?.focus());
  });

  const pick = (name: string) => {
    if (onlyCurrent(name)) return;
    setDest(name);
    if (total() === 1) void run(name);
    else setPhase("confirm");
  };

  async function run(target: string) {
    setPhase("running");
    setProgress(0);
    const reports: MoveReport[] = [];
    for (const part of chunk(props.req.tracks, MOVE_CHUNK)) {
      const ids = part.map((t) => t.id);
      try {
        reports.push(await libMoveTracks(ids, target));
      } catch (e) {
        const why = String(e);
        reports.push({
          dest_playlist: target, moved: 0, already_there: 0, failed: part.length, pending: 0,
          items: part.map((t) => ({
            track_id: t.id, new_track_id: null, new_path: null, new_lrc_path: null,
            title: t.title, status: "failed" as const, detail: why,
          })),
        });
      }
      setProgress((n) => n + part.length);
    }
    // A fila e as views se atualizam pelo evento lib-tracks-moved
    // (applyMovedReport, assinado no App), que o backend emite por lote.
    const merged = mergeReports(target, reports);
    setReport(merged);
    // Seleção múltipla: sai da seleção só o que o relatório deu como movido
    // ou já no destino. Falhas e pendentes continuam marcados; uma faixa
    // movida pelo menu de faixa única não apaga as outras marcadas.
    deselectIds(merged.items.filter((i) => i.status === "moved" || i.status === "already_there").map((i) => i.track_id));
    setPhase("done");
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    // Nome exato existente > primeira da lista filtrada > pasta nova.
    const q = query().trim().toLowerCase();
    const exact = (names() ?? []).find((n) => n.toLowerCase() === q);
    const first = filtered().find((n) => !onlyCurrent(n));
    const c = candidate();
    if (exact) pick(exact);
    else if (first) pick(first);
    else if (c) pick(c);
  };

  const failures = () => (report()?.items ?? []).filter((i) => i.status === "failed");
  const warnings = () => (report()?.items ?? []).filter((i) => i.status === "moved" && i.detail);
  const titleOf = (id: string, fallback: string | null) =>
    fallback ?? props.req.tracks.find((t) => t.id === id)?.title ?? id;

  return (
    <Portal mount={document.body}>
      <div
        class="palette-scrim palette-scrim--mount"
        data-open="true"
        onPointerDown={(e) => { if (e.target === e.currentTarget) close(); }}
      >
        <div class="palette move-dlg" role="dialog" aria-modal="true" aria-label="Mover para playlist">
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
                  <Show when={candidate()}>
                    {(c) => (
                      <button type="button" class="palette__item move-dlg__item" onClick={() => pick(c())}>
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
                  <Show when={!names.loading && filtered().length === 0 && !candidate()}>
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
                <p class="move-dlg__line">{confirmText(total(), props.req.label, dest())}</p>
                <p class="move-dlg__hint">Likes, plays e letras acompanham as faixas.</p>
                <div class="move-dlg__acts">
                  <button type="button" class="crate-btn" onClick={() => setPhase("pick")}>Voltar</button>
                  <button type="button" class="crate-btn crate-btn--primary" onClick={() => void run(dest())}>Mover</button>
                </div>
              </div>
            </Match>

            <Match when={phase() === "running"}>
              <div class="move-dlg__body" aria-live="polite">
                <p class="move-dlg__line">Movendo {progress()} de {total()} para {dest()}</p>
                <div class="move-dlg__bar"><div style={{ transform: `scaleX(${progress() / total()})` }} /></div>
              </div>
            </Match>

            <Match when={phase() === "done"}>
              <div class="move-dlg__body" aria-live="polite">
                <p class="move-dlg__line">
                  <Icon name={(report()?.failed ?? 0) > 0 || (report()?.pending ?? 0) > 0 ? ICONS.alert : ICONS.check} size={14} />
                  <span>{report() ? summaryText(report()!) : ""}</span>
                  <span class="move-dlg__dest">em {dest()}</span>
                </p>
                <Show when={(report()?.pending ?? 0) > 0}>
                  <p class="move-dlg__hint">
                    O indexador ainda está trabalhando nessas faixas; a biblioteca se atualiza sozinha quando terminar.
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
                  <button type="button" class="crate-btn crate-btn--primary" onClick={closeMoveDialog}>Fechar</button>
                </div>
              </div>
            </Match>
          </Switch>
        </div>
      </div>
    </Portal>
  );
}
