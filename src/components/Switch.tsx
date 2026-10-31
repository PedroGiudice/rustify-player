/* ============================================================
   components/Switch.tsx — interruptor liga/desliga (pílula .tog).

   A31 (31/10): o .tog era um <button> sem nome ("botão" no leitor),
   com aria-pressed e, desligado, cinza sobre o painel (1,89:1). Aqui é
   role="switch" + aria-checked, com nome por aria-labelledby (o rótulo
   visível da linha) ou aria-label. O visual vive no extractor-lab.css
   (.tog): desligado tem borda --fg-6 e bolinha --fg-5; a área de toque
   cresce para 24 px por ::before.
   ============================================================ */

import type { JSX } from "solid-js";

export function Switch(props: {
  checked: boolean;
  onChange: () => void;
  /** id do rótulo visível da linha (preferido). */
  labelledBy?: string;
  /** Nome quando não há rótulo visível. */
  label?: string;
  title?: string;
  variant?: "blue";
  disabled?: boolean;
  style?: JSX.CSSProperties;
}) {
  return (
    <button
      type="button"
      role="switch"
      class={props.variant === "blue" ? "tog tog--blue" : "tog"}
      aria-checked={props.checked ? "true" : "false"}
      aria-labelledby={props.labelledBy}
      aria-label={props.labelledBy ? undefined : props.label}
      title={props.title}
      disabled={props.disabled}
      style={props.style}
      onClick={() => props.onChange()}
    />
  );
}
