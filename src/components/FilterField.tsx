/* ============================================================
   components/FilterField.tsx — campo de filtro das grades da biblioteca
   (Álbuns e Artistas, B3). Mesma pele do filtro da Playlists
   (.coll-search). Esc limpa o campo.
   ============================================================ */

import { Show } from "solid-js";
import { Icon, ICONS } from "./Icon";

export function FilterField(props: {
  value: string;
  onInput: (v: string) => void;
  placeholder: string;
  label: string;
  /** "12 de 340": quantos sobraram, só com filtro ativo. */
  status?: string;
}) {
  return (
    <div class="coll-toolbar lib-filter">
      <label class="coll-search">
        <Icon name={ICONS.search} size={13} />
        <input
          type="search"
          aria-label={props.label}
          placeholder={props.placeholder}
          value={props.value}
          spellcheck={false}
          onInput={(e) => props.onInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && props.value) {
              e.preventDefault();
              e.stopPropagation();
              props.onInput("");
            }
          }}
        />
      </label>
      <Show when={props.status}>
        <span class="lib-filter__status" role="status">{props.status}</span>
      </Show>
    </div>
  );
}
