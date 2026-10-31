/* ============================================================
   components/QueueDrawer.tsx — Gaveta da fila (direita): a faixa
   tocando e o "a seguir", editável (arrastar, tirar, Alt+setas).

   Reativa a player.queue e player.queueIndex. Abre com a tecla Q ou
   o evento 'rustify:open-queue'. O evento alterna; com detail
   { open: boolean } força o estado (a ação "Open queue" da palette
   pede abrir, não alternar).

   Aberta é um diálogo: foco no fechar, Tab preso, Esc devolve o foco
   a quem abriu (ou ao botão da fila na barra). Fechada fica fora do
   Tab e do leitor de tela (inert + visibility no CSS). As linhas só
   montam na primeira abertura.

   Edição pela FAIXA, não pelo índice do início do gesto: a música
   pode trocar no meio do arraste ou da animação de saída (A28).
   Limpar e tirar avisam com Desfazer por 6 s (B4, store/toast).
   ============================================================ */

import { For, Show, createEffect, createSignal, on, onCleanup, onMount } from "solid-js";
import { Icon, ICONS } from "./Icon";
import { TrackRowList } from "./TrackRowList";
import type { Track } from "../tauri";
import {
  player, moveUpcomingTrack, removeUpcomingTrack, restoreUpcoming, clearUpcoming, restoreCleared,
} from "../store/player";
import { dropIndex, shiftFor } from "../lib/queueDrag";
import { playQueueUpcoming } from "./PlayerBar";
import { navigate } from "../router";
import { fmtListDur, plural } from "../lib/format";
import { isTypingContext } from "../lib/keyboard";
import { pushEscLayer } from "../lib/escLayers";
import { rememberFocus, trapTab, type FocusReturn } from "../lib/focusReturn";
import { showToast } from "../store/toast";
import { autoplayReasonText } from "../lib/radioWhy";

export const QUEUE_EVENT = "rustify:open-queue";

const [drawerOpen, setDrawerOpen] = createSignal(false);
/** Gaveta aberta (para o aria-expanded do botão da fila na barra). */
export const queueDrawerOpen = drawerOpen;

const faixas = (n: number) => plural(n, "faixa", "faixas");

/** Linha de resumo do cabeçalho. */
export function queueMeta(upcoming: readonly Track[], hasCurrent: boolean): string {
  if (upcoming.length === 0) return hasCurrent ? "só esta faixa" : "vazia";
  const ms = upcoming.reduce((acc, t) => acc + (t.duration_ms ?? 0), 0);
  return `${faixas(upcoming.length)} a seguir · ${fmtListDur(ms)}`;
}

/** O que acontece quando a fila acaba (PlayerBar, TrackEnded): repetir
    uma re-toca a atual, repetir tudo volta ao início, senão o rádio
    (doAutoplay) escolhe a próxima. */
export function queueEndNote(hasUpcoming: boolean, repeat: "off" | "all" | "one"): string {
  if (repeat === "one") return "A faixa atual se repete.";
  if (hasUpcoming) return repeat === "all" ? "Fim da lista. A fila recomeça do início." : "Fim da lista. O rádio continua depois dela.";
  return repeat === "all" ? "Depois desta, a fila recomeça." : "Depois desta, o rádio escolhe.";
}

/** B10: por que o rádio escolheu a faixa, numa linha curta; null para faixa
    que o rádio não escolheu. A semente costuma estar na própria fila (é a
    faixa que tocava quando o rádio pediu o lote): o título sai de lá. */
export function radioReason(track: Track, queue: readonly Track[]): string | null {
  const r = track.autoplay_reason;
  if (!r) return null;
  const seed = queue.find((t) => t.id === r.seed_id)?.title ?? null;
  return autoplayReasonText(r, seed);
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/** Duração do assentamento (FLIP) e da saída de uma linha. */
const SETTLE_MS = 240;
const LEAVE_MS = 180;

/**
 * FLIP: mede onde cada linha está, aplica a mudança na fila e anima cada
 * linha da posição antiga até a nova. O For do Solid reaproveita o mesmo nó
 * para o mesmo objeto de faixa, então a linha é a mesma antes e depois.
 * O rect inclui o transform corrente: a linha arrastada assenta de onde foi solta.
 * Duas passadas depois da mudança (lê todas as posições, depois anima):
 * intercalar leitura e escrita forçava um layout por linha.
 */
function flip(list: HTMLElement | undefined, mutate: () => void) {
  if (!list || reducedMotion()) { mutate(); return; }
  const rows = Array.from(list.querySelectorAll<HTMLElement>(".qedit"));
  const before = new Map(rows.map((el) => [el, el.getBoundingClientRect().top]));
  for (const el of rows) { el.style.transition = "none"; el.style.transform = ""; }
  mutate();
  const after = Array.from(list.querySelectorAll<HTMLElement>(".qedit")).map(
    (el) => [el, before.get(el), el.getBoundingClientRect().top] as const,
  );
  for (const [el, top0, top1] of after) {
    el.style.transition = "";
    if (top0 === undefined) continue;
    const dy = top0 - top1;
    if (Math.abs(dy) < 0.5) continue;
    el.animate(
      [{ transform: `translateY(${dy}px)` }, { transform: "translateY(0)" }],
      { duration: SETTLE_MS, easing: "cubic-bezier(0.16, 1, 0.3, 1)" },
    );
  }
}

export function QueueDrawer() {
  let listEl: HTMLDivElement | undefined;
  let asideEl: HTMLElement | undefined;
  let closeBtn: HTMLButtonElement | undefined;
  const open = drawerOpen;
  const setOpen = setDrawerOpen;
  // Linhas só montam na primeira abertura: fechada, a gaveta não paga a
  // fila inteira de nós a cada troca de faixa.
  const [everOpened, setEverOpened] = createSignal(false);
  const [announce, setAnnounce] = createSignal("");

  onMount(() => {
    setOpen(false);
    const onOpenEvt = (e: Event) => {
      const want = (e as CustomEvent<{ open?: boolean } | null>).detail?.open;
      setOpen((v) => (typeof want === "boolean" ? want : !v));
    };
    const onKey = (e: KeyboardEvent) => {
      if (isTypingContext(e)) return;
      if (
        e.key.toLowerCase() === "q" && !e.ctrlKey && !e.metaKey && !e.altKey
      ) { e.preventDefault(); setOpen((v) => !v); }
    };
    window.addEventListener(QUEUE_EVENT, onOpenEvt);
    window.addEventListener("keydown", onKey);
    onCleanup(() => {
      window.removeEventListener(QUEUE_EVENT, onOpenEvt);
      window.removeEventListener("keydown", onKey);
      setOpen(false);
    });
  });

  // Esc fecha a gaveta pela pilha única (lib/escLayers): o menu de contexto
  // aberto por cima fecha antes, e o App não sai do cinema no mesmo toque.
  createEffect(() => {
    if (!open()) return;
    onCleanup(pushEscLayer(() => setOpen(false)));
  });

  // Foco: ao abrir guarda quem tinha o foco e vai para o fechar; ao fechar
  // devolve (só se o foco ainda estava na gaveta). Fechada = inert.
  let focusRet: FocusReturn | null = null;
  createEffect(on(open, (isOpen) => {
    if (isOpen) {
      setEverOpened(true);
      focusRet = rememberFocus(() => document.getElementById("pb-queue"));
      asideEl?.removeAttribute("inert");
      requestAnimationFrame(() => { if (open()) closeBtn?.focus({ preventScroll: true }); });
    } else {
      focusRet?.restore({ within: asideEl });
      focusRet = null;
      asideEl?.setAttribute("inert", "");
    }
  }));

  const upcoming = () => player.queue.slice(player.queueIndex + 1);

  // ── Editar a fila: arrastar, tirar, Alt+setas ───────────────────
  const rowsOf = () => Array.from(listEl?.querySelectorAll<HTMLElement>(".qedit") ?? []);
  const focusGrip = (i: number) =>
    requestAnimationFrame(() => rowsOf()[i]?.querySelector<HTMLElement>(".qedit__grip")?.focus());

  function moveBy(track: Track, delta: number) {
    const list = upcoming();
    const from = list.indexOf(track);
    const anchor = list[from + delta];
    if (from < 0 || !anchor) return;
    flip(listEl, () => moveUpcomingTrack(track, anchor));
    const now = upcoming().indexOf(track);
    if (now >= 0) {
      focusGrip(now);
      setAnnounce(`Posição ${now + 1} de ${upcoming().length}`);
    }
  }

  // Linhas saindo (animação de 180 ms): Delete repetido ou clique duplo no
  // × acharia a mesma linha e tiraria a seguinte.
  const leaving = new WeakSet<HTMLElement>();

  function removeTrack(track: Track, row: HTMLElement | undefined) {
    if (row && leaving.has(row)) return;
    const done = () => {
      const focusWasHere = !row || row.contains(document.activeElement) || document.activeElement === document.body;
      let removed: ReturnType<typeof removeUpcomingTrack> = null;
      flip(listEl, () => { removed = removeUpcomingTrack(track); });
      const r = removed as ReturnType<typeof removeUpcomingTrack>;
      if (!r) return;
      // Foco só depois que a linha saiu: na linha que ocupou o lugar, ou
      // na de cima se era a última, ou no fechar se a lista esvaziou.
      if (focusWasHere) {
        const n = upcoming().length;
        if (n === 0) requestAnimationFrame(() => closeBtn?.focus());
        else focusGrip(Math.min(r.rel, n - 1));
      }
      showToast({
        message: `Tirou “${r.track.title || "faixa"}” da fila`,
        action: { label: "Desfazer", run: () => restoreUpcoming(r) },
      });
    };
    if (!row || reducedMotion()) { done(); return; }
    leaving.add(row);
    row.style.pointerEvents = "none";
    row.animate(
      [{ transform: "translateX(0)", opacity: 1 }, { transform: "translateX(24px)", opacity: 0 }],
      { duration: LEAVE_MS, easing: "cubic-bezier(0.4, 0, 1, 1)", fill: "forwards" },
    ).onfinish = () => {
      row.getAnimations().forEach((a) => a.cancel());
      row.style.pointerEvents = "";
      leaving.delete(row);
      done();
    };
  }

  function onGripKey(e: KeyboardEvent, track: Track) {
    const row = (e.currentTarget as HTMLElement).closest<HTMLElement>(".qedit") ?? undefined;
    if (e.altKey && e.key === "ArrowUp") { e.preventDefault(); moveBy(track, -1); }
    else if (e.altKey && e.key === "ArrowDown") { e.preventDefault(); moveBy(track, 1); }
    else if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault();
      // Segurar a tecla não tira a fila em rajada: um toque, uma faixa.
      if (e.repeat) return;
      removeTrack(track, row);
    }
  }

  function clearAll() {
    const removed = clearUpcoming();
    if (removed.length === 0) return;
    requestAnimationFrame(() => closeBtn?.focus());
    showToast({
      message: `Fila limpa · ${faixas(removed.length)}`,
      action: { label: "Desfazer", run: () => restoreCleared(removed) },
    });
  }

  /** Arraste pela alça: a linha segue o ponteiro 1:1 e as vizinhas abrem espaço.
      Ao soltar, a faixa vai para onde a faixa-alvo (âncora) estiver AGORA; se
      a música trocou e a arrastada virou a atual, o gesto é abortado. */
  function startDrag(e: PointerEvent, track: Track) {
    if (e.button !== 0) return;
    const grip = e.currentTarget as HTMLElement;
    const list0 = upcoming();
    const from = list0.indexOf(track);
    const rows = rowsOf();
    const row = rows[from];
    if (from < 0 || !row) return;
    e.preventDefault();
    try { grip.setPointerCapture(e.pointerId); } catch { /* ponteiro já solto */ }
    const rowH = row.getBoundingClientRect().height;
    const y0 = e.clientY;
    let to = from;
    let ended = false;
    listEl!.dataset.dragging = "true";
    row.classList.add("qedit--lifted");

    const onMove = (ev: PointerEvent) => {
      // A fila mudou por baixo (avanço de faixa, re-fetch do rádio): as
      // linhas medidas não são mais as de agora. Aborta limpo.
      if (upcoming()[from] !== track) { end(false); return; }
      const dy = ev.clientY - y0;
      row.style.transform = `translateY(${dy}px)`;
      const next = dropIndex(from, dy, rowH, rows.length);
      if (next === to) return;
      to = next;
      rows.forEach((el, k) => {
        if (k === from) return;
        const shift = shiftFor(k, from, to, rowH);
        el.style.transform = shift ? `translateY(${shift}px)` : "";
      });
    };
    const end = (commit: boolean, pointerId?: number) => {
      if (ended) return;
      ended = true;
      grip.removeEventListener("pointermove", onMove);
      grip.removeEventListener("pointerup", onUp);
      grip.removeEventListener("pointercancel", onCancel);
      grip.removeEventListener("lostpointercapture", onLost);
      window.removeEventListener("blur", onBlur);
      if (pointerId !== undefined && grip.hasPointerCapture?.(pointerId)) grip.releasePointerCapture(pointerId);
      row.classList.remove("qedit--lifted");
      if (listEl) delete listEl.dataset.dragging;
      // Linhas que já saíram do DOM ficam sem transform preso.
      for (const el of rows) if (!el.isConnected) { el.style.transform = ""; el.style.transition = ""; }
      const anchor = list0[to];
      flip(listEl, () => { if (commit && to !== from && anchor) moveUpcomingTrack(track, anchor); });
    };
    const onUp = (ev: PointerEvent) => end(true, ev.pointerId);
    const onCancel = (ev: PointerEvent) => end(false, ev.pointerId);
    // Captura perdida sem pointerup (linha remontada, janela trocou): aborta.
    // Depois de um pointerup normal o `ended` já está de pé e isto não faz nada.
    const onLost = () => end(false);
    const onBlur = () => end(false);
    grip.addEventListener("pointermove", onMove);
    grip.addEventListener("pointerup", onUp);
    grip.addEventListener("pointercancel", onCancel);
    grip.addEventListener("lostpointercapture", onLost);
    window.addEventListener("blur", onBlur);
  }

  function openNowPlaying() {
    setOpen(false);
    navigate("/now-playing");
  }

  return (
    <>
      <div class="queue-scrim" data-open={open() ? "true" : "false"} onClick={() => setOpen(false)} />
      <aside
        ref={(el) => { asideEl = el; el.setAttribute("inert", ""); }}
        class="queue-drawer"
        data-open={open() ? "true" : "false"}
        data-screen-label="Queue"
        role="dialog"
        aria-modal="true"
        aria-label="Fila"
        onKeyDown={(e) => { if (asideEl) trapTab(e, asideEl); }}
      >
        <div class="queue-drawer__head">
          <div>
            <h2 class="queue-drawer__title">Fila</h2>
            <div class="queue-drawer__meta">{queueMeta(upcoming(), !!player.currentTrack)}</div>
          </div>
          <button
            ref={closeBtn}
            class="queue-drawer__close"
            title="Fechar (Esc)"
            aria-label="Fechar a fila"
            onClick={() => setOpen(false)}
          >
            <Icon name={ICONS.close} size={12} />
          </button>
        </div>
        <span class="sr-only" role="status" aria-live="polite">{announce()}</span>

        <Show when={everOpened()}>
          <div class="queue-drawer__body">
            <Show when={player.currentTrack}>
              {(t) => (
                <>
                  <div class="queue-drawer__section-label"><span>Tocando agora</span></div>
                  {/* Clicar na que toca abre o Now Playing: tocar de novo
                      recomeçava a faixa e gravava mais um play no motor. */}
                  <div class="qedit qedit--now">
                    <div class="qedit__track">
                      <TrackRowList track={t()} onClick={openNowPlaying} size="compact" />
                      <Show when={radioReason(t(), player.queue)}>
                        {(why) => <p class="qedit__why">{why()}</p>}
                      </Show>
                    </div>
                  </div>
                </>
              )}
            </Show>

            <Show when={upcoming().length > 0}>
              <div class="queue-drawer__section-label">
                <span>A seguir · {upcoming().length}</span>
                <button
                  type="button"
                  class="queue-drawer__clear"
                  title="Limpar o que vem a seguir (a faixa atual continua)"
                  onClick={(e) => { e.stopPropagation(); clearAll(); }}
                >
                  Limpar
                </button>
              </div>
              <div class="qlist" ref={listEl}>
                <For each={upcoming()}>
                  {(track) => (
                    <div class="qedit">
                      <button
                        class="qedit__grip"
                        aria-label={`Mover ${track.title ?? "faixa"} na fila`}
                        title="Arrastar para reordenar (Alt+↑/↓; Delete tira)"
                        onPointerDown={(e) => startDrag(e, track)}
                        onKeyDown={(e) => onGripKey(e, track)}
                      >
                        <Icon name={ICONS.grip} size={14} />
                      </button>
                      <div class="qedit__track">
                        <TrackRowList track={track} onClick={() => playQueueUpcoming(track)} size="compact" />
                        <Show when={radioReason(track, player.queue)}>
                          {(why) => <p class="qedit__why">{why()}</p>}
                        </Show>
                      </div>
                      <button
                        class="qedit__remove"
                        aria-label={`Tirar ${track.title ?? "faixa"} da fila`}
                        title="Tirar da fila"
                        onClick={(e) => {
                          e.stopPropagation();
                          removeTrack(track, (e.currentTarget as HTMLElement).closest<HTMLElement>(".qedit") ?? undefined);
                        }}
                      >
                        <Icon name={ICONS.close} size={12} />
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <Show when={player.currentTrack}>
              <p class="queue-drawer__note">{queueEndNote(upcoming().length > 0, player.repeatMode)}</p>
            </Show>

            <Show when={upcoming().length === 0 && !player.currentTrack}>
              <div class="empty-state">
                <p class="empty-state__title">Fila vazia</p>
                <p class="empty-state__hint">Toque algo pra começar.</p>
              </div>
            </Show>
          </div>
        </Show>
      </aside>
    </>
  );
}
