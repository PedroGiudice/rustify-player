/* ============================================================
   components/EmptyState.tsx — bloco de estado de uma tela ou lista:
   vazio, erro ou carregando.

   Uma peça só para as três situações, para que "não há nada" e "não
   consegui ler" nunca tenham a mesma cara (A7, varredura de 31/10). O
   erro é um alerta e sempre oferece saída; o carregando é um status
   ocupado; o vazio diz o que fazer.

   Uso:
     <EmptyState tone="erro" title="Não consegui ler o acervo agora."
                 actions={[{ label: "Tentar de novo", onClick: refetch }]} />
   ============================================================ */

import { For, Show, type JSX } from "solid-js";
import { Icon, ICONS } from "./Icon";

export type EmptyTone = "vazio" | "erro" | "carregando";

export interface EmptyAction {
  label: string;
  onClick: () => void;
  /** Ação principal (botão cheio). Uma por bloco. */
  primary?: boolean;
  /** Ícone Lucide (nome completo, ex. "lucide:refresh-cw"). */
  icon?: string;
}

export interface EmptyStateProps {
  tone?: EmptyTone;
  title: string;
  text?: JSX.Element;
  actions?: EmptyAction[];
  /** Ícone do vazio (o erro usa sempre o triângulo; o carregando, nenhum). */
  icon?: string;
  /** Sem a moldura tracejada e com menos respiro: dentro de uma seção. */
  compact?: boolean;
}

export function EmptyState(props: EmptyStateProps) {
  const tone = () => props.tone ?? "vazio";
  const icon = () => (tone() === "erro" ? ICONS.alert : tone() === "carregando" ? undefined : props.icon);
  return (
    <div
      class="empty-block"
      classList={{ "empty-block--compact": !!props.compact }}
      data-tone={tone()}
      role={tone() === "erro" ? "alert" : tone() === "carregando" ? "status" : undefined}
      aria-busy={tone() === "carregando" ? "true" : undefined}
    >
      <Show when={icon()}>{(name) => <Icon name={name()} size={22} class="empty-block__icon" />}</Show>
      <h3 class="empty-block__title">{props.title}</h3>
      <Show when={props.text}>
        <p class="empty-block__text">{props.text}</p>
      </Show>
      <Show when={tone() !== "carregando" && (props.actions?.length ?? 0) > 0}>
        <div class="empty-block__actions">
          <For each={props.actions}>
            {(a) => (
              <button
                type="button"
                class="pl-action-btn"
                classList={{ "pl-action-btn--primary": !!a.primary }}
                onClick={() => a.onClick()}
              >
                <Show when={a.icon}>{(n) => <Icon name={n()} size={13} />}</Show>
                <span>{a.label}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
