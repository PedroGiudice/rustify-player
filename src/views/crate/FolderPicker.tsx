/* ============================================================
   views/crate/FolderPicker.tsx — o seletor de pasta do Crate inteiro
   (B7, 31/10/2026). Antes eram três: chip com popover no Buscar,
   <select> com "outra pasta..." na Tidal e a lista do Mover, cada um
   com a sua memória e a sua lista de pastas.

   Um chip abre o mesmo gesto do Mover: campo que filtra a lista,
   Enter escolhe a primeira, "Nova pasta “X”" só com o nome já limpo
   (sanitizePlaylistName, a regra do backend). Escolher só define o
   destino; nada baixa nem move até o Baixar. Fecha com clique fora
   e com Esc (pilha única de lib/escLayers), devolvendo o foco ao chip.
   A memória (kv-crate-dest) e a lista (pastas locais + as que a fila
   da VM conhece) ficam com quem usa o seletor.
   ============================================================ */

import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Icon, ICONS } from "../../components/Icon";
import { pushEscLayer } from "../../lib/escLayers";
import { filterPlaylists, newFolderCandidate } from "../../lib/moveToPlaylist";

export interface FolderPickerProps {
  value: string | null;
  placeholder: string;
  folders: string[];
  /** `toolbar` = caixa de 40 px com o rótulo "Destino"; `row` = pílula de 24 px. */
  variant: "toolbar" | "row";
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  onPick: (folder: string) => void;
  warn?: boolean;
  override?: boolean;
  disabled?: boolean;
  title?: string;
}

/** Pastas locais e da VM numa lista só, sem repetir, em ordem alfabética. */
export function mergeFolders(...lists: (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lists) for (const n of l) if (n && !seen.has(n)) { seen.add(n); out.push(n); }
  return out.sort((a, b) => a.localeCompare(b, "pt-BR"));
}

export function FolderPicker(props: FolderPickerProps) {
  let rootEl: HTMLDivElement | undefined;
  let btnEl: HTMLButtonElement | undefined;

  return (
    <div class="crate-dest" ref={rootEl}>
      <button
        ref={btnEl}
        type="button"
        class={
          (props.variant === "row" ? "crate-chip crate-dest__btn" : "crate-dest__btn")
          + (props.warn ? " crate-dest__btn--warn" : "")
        }
        data-override={props.override ? "true" : undefined}
        title={props.title ?? (props.variant === "row" ? "Destino desta faixa" : "Destino de tudo que for baixado")}
        aria-haspopup="true"
        aria-expanded={props.open ? "true" : "false"}
        disabled={props.disabled}
        onClick={(e) => { e.stopPropagation(); props.onToggle(); }}
      >
        <Show when={props.variant === "toolbar"}>
          <span class="crate-dest__lbl">Salvar em</span>
        </Show>
        <span>{props.value ?? props.placeholder}</span>
        <Icon name={ICONS.chevronDown} size={12} />
      </button>
      <Show when={props.open}>
        <FolderMenu
          root={() => rootEl}
          button={() => btnEl}
          folders={props.folders}
          value={props.value}
          onPick={props.onPick}
          onClose={props.onClose}
        />
      </Show>
    </div>
  );
}

function FolderMenu(props: {
  root: () => HTMLDivElement | undefined;
  button: () => HTMLButtonElement | undefined;
  folders: string[];
  value: string | null;
  onPick: (folder: string) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = createSignal("");
  const filtered = createMemo(() => filterPlaylists(props.folders, query()));
  const candidate = createMemo(() => (query().trim() ? newFolderCandidate(props.folders, query()) : null));
  let inputEl: HTMLInputElement | undefined;
  let menuEl: HTMLDivElement | undefined;

  const close = () => {
    const inside = !!menuEl && menuEl.contains(document.activeElement);
    props.onClose();
    if (inside) props.button()?.focus();
  };

  onMount(() => {
    // Quem abriu pelo teclado pode já ter posto o foco numa pasta (Enter na
    // linha sem destino): nesse caso o campo não rouba o foco.
    queueMicrotask(() => {
      if (!menuEl?.contains(document.activeElement)) inputEl?.focus({ preventScroll: true });
    });
    const onDown = (e: MouseEvent) => {
      if (!props.root()?.contains(e.target as Node)) props.onClose();
    };
    document.addEventListener("mousedown", onDown, true);
    onCleanup(() => document.removeEventListener("mousedown", onDown, true));
    onCleanup(pushEscLayer(close));
  });

  function onInputKey(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      const q = query().trim().toLowerCase();
      const exact = props.folders.find((n) => n.toLowerCase() === q);
      const first = filtered()[0];
      const c = candidate();
      if (exact) props.onPick(exact);
      else if (first) props.onPick(first);
      else if (c) props.onPick(c);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      menuEl?.querySelector<HTMLElement>(".crate-dest__opt")?.focus();
    }
  }

  function onListKey(e: KeyboardEvent) {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const opts = [...(menuEl?.querySelectorAll<HTMLElement>(".crate-dest__opt") ?? [])];
    const i = opts.indexOf(document.activeElement as HTMLElement);
    if (i < 0) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.key === "ArrowUp" && i === 0) { inputEl?.focus(); return; }
    opts[Math.max(0, Math.min(opts.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
  }

  return (
    <div class="crate-dest__menu" ref={menuEl} onClick={(e) => e.stopPropagation()} onKeyDown={onListKey}>
      <input
        ref={inputEl}
        class="crate-dest__filter"
        value={query()}
        spellcheck={false}
        autocomplete="off"
        placeholder={props.folders.length ? "Filtrar ou criar pasta" : "Nome da pasta nova"}
        aria-label="Filtrar pastas ou digitar uma nova"
        onInput={(e) => setQuery(e.currentTarget.value)}
        onKeyDown={onInputKey}
      />
      <div class="crate-dest__opts" role="listbox" aria-label="Pastas em ~/Music">
        <For each={filtered()}>
          {(f) => (
            <button
              type="button"
              role="option"
              class="crate-dest__opt"
              aria-selected={f === props.value ? "true" : "false"}
              onClick={() => props.onPick(f)}
            >
              {f}
            </button>
          )}
        </For>
        {/* Pasta nova por último: o Enter escolhe uma existente que case. */}
        <Show when={candidate()}>
          {(c) => (
            <button type="button" role="option" class="crate-dest__opt crate-dest__opt--new" onClick={() => props.onPick(c())}>
              <Icon name={ICONS.folderPlus} size={12} />
              <span>Nova pasta “{c()}”</span>
            </button>
          )}
        </Show>
        <Show when={filtered().length === 0 && !candidate()}>
          <div class="crate-dest__none">
            {query().trim()
              ? "Nome inválido: depois de limpar os caracteres proibidos, não pode ficar vazio nem começar com . ou _."
              : "Nenhuma pasta em ~/Music ainda. Digite um nome para criar."}
          </div>
        </Show>
      </div>
    </div>
  );
}
