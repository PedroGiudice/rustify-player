// src/components/SelectionBar.tsx — barra de ação da seleção múltipla de
// faixas, acima da PlayerBar. Também dona dos gestos globais da seleção:
// Ctrl+A (todas da lista em foco), Esc (limpa) e o reset na troca de rota.
import { Show, createEffect, createMemo, on, onCleanup, onMount } from "solid-js";
import { route } from "../router";
import { escLayerCount, pushEscLayer } from "../lib/escLayers";
import { isTypingContext } from "../lib/keyboard";
import { moveLabel, selLabel } from "../lib/selection";
import { enqueueEndMany, enqueueNextMany } from "../store/player";
import { openMoveDialog } from "../store/moveDialog";
import {
  clearSelection, hasFocusList, resetSelection, selectAllInFocus, selectedTracks, selectionCount,
} from "../store/selection";
import { Icon, ICONS } from "./Icon";

// Superfícies que têm o foco do usuário por cima da lista.
const OVERLAY_SEL = '[role="dialog"], [role="menu"], .tweaks, .queue-drawer';
const OVERLAY_OPEN_SEL = '.palette-scrim[data-open="true"], .queue-drawer[data-open="true"], .tweaks.is-visible, [role="menu"]';

/** Ctrl+A é da lista só quando nada está por cima dela. */
function overlayAbove(e: KeyboardEvent, ownLayers: number): boolean {
  const t = e.target as HTMLElement | null;
  if (t?.closest?.(OVERLAY_SEL)) return true;
  if (escLayerCount() > ownLayers) return true;
  return document.querySelector(OVERLAY_OPEN_SEL) !== null;
}

export function SelectionBar() {
  const active = createMemo(() => selectionCount() > 0);

  // Trocar de rota encerra a seleção e esquece a lista em foco.
  createEffect(on(() => route().path + "/" + (route().param ?? ""), () => resetSelection(), { defer: true }));

  // Esc limpa: camada na pilha única, só enquanto há seleção.
  createEffect(() => {
    if (!active()) return;
    onCleanup(pushEscLayer(clearSelection));
  });

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "a") return;
      if (isTypingContext(e) || !hasFocusList()) return;
      if (overlayAbove(e, active() ? 1 : 0)) return;
      e.preventDefault();
      selectAllInFocus();
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  const doMove = () => openMoveDialog(selectedTracks());
  const doNext = () => { enqueueNextMany(selectedTracks()); clearSelection(); };
  const doEnd = () => { enqueueEndMany(selectedTracks()); clearSelection(); };

  return (
    <Show when={active()}>
      <div class="sel-bar-wrap">
        <div class="sel-bar" role="toolbar" aria-label="Ações da seleção">
          <span class="sel-bar__count" aria-live="polite">{selLabel(selectionCount())}</span>
          <span class="sel-bar__sep" />
          <button type="button" class="sel-bar__btn sel-bar__btn--primary" onClick={doMove}>
            <Icon name={ICONS.moveTo} size={14} /><span>{moveLabel(selectionCount())}</span>
          </button>
          <button type="button" class="sel-bar__btn" onClick={doNext}>
            <Icon name={ICONS.next} size={14} /><span>Tocar a seguir</span>
          </button>
          <button type="button" class="sel-bar__btn" onClick={doEnd}>
            <Icon name={ICONS.queue} size={14} /><span>Adicionar à fila</span>
          </button>
          <span class="sel-bar__sep" />
          <button type="button" class="sel-bar__btn" onClick={clearSelection}>
            <Icon name={ICONS.close} size={14} /><span>Limpar</span>
          </button>
        </div>
      </div>
    </Show>
  );
}
