/* ============================================================
   sheet.ts — estado do bottom-sheet (o primitivo que faltava).

   Por que NÃO é uma rota de hash: o Now Playing é a rota `/np`
   (nav.ts) e uma rota `/sheet` fecharia o NP por baixo. A sheet
   vive numa SENTINELA de history — uma entrada marcada que o botão
   voltar do Android consome antes de sair da tela.

   A regra que não pode ser quebrada: quem fecha a sheet tem de
   CONSUMIR a sentinela (history.back), nunca só limpar o signal.
   Limpar o signal deixaria a entrada órfã e o próximo "voltar" do
   usuário seria engolido — a tela não voltaria. Pelo mesmo motivo,
   navegar a partir da sheet passa por closeSheetThen: navegar antes
   de consumir empilha por cima da sentinela e o voltar devolve o
   usuário à sheet.
   ============================================================ */

import { createSignal } from "solid-js";
import type { Track } from "./types";

export type SheetSpec =
  | { kind: "track"; track: Track; context?: { list: Track[]; index: number } }
  | { kind: "info"; track: Track };

const [sheet, setSheet] = createSignal<SheetSpec | null>(null);
export { sheet };

const SENTINEL = "rustifySheet";

/** Sentinela empilhada? Evita empilhar duas e evita back() indevido. */
let sentinelUp = false;
/** Ação a rodar depois que a sentinela for consumida (navegação). */
let afterClose: (() => void) | null = null;

export function openSheet(spec: SheetSpec) {
  setSheet(spec);
  if (sentinelUp) return; // trocar o conteúdo não empilha outra entrada
  try {
    history.pushState({ [SENTINEL]: true }, "");
    sentinelUp = true;
  } catch {
    /* sem history utilizável a sheet ainda abre; só o voltar não fecha */
  }
}

export function closeSheet() {
  if (!sheet()) return;
  if (sentinelUp) {
    // O popstate é quem limpa o signal — assim o caminho do botão voltar do
    // Android e o do toque no scrim são exatamente o mesmo código.
    history.back();
    return;
  }
  setSheet(null);
}

/** Fecha e roda `fn` só depois de a sentinela sair do histórico. */
export function closeSheetThen(fn: () => void) {
  if (!sheet()) {
    fn();
    return;
  }
  if (sentinelUp) {
    afterClose = fn;
    history.back();
    return;
  }
  setSheet(null);
  fn();
}

/** Registra o listener de popstate. Chamar uma vez, na montagem do app. */
export function initSheetHistory(): () => void {
  const onPop = () => {
    if (!sentinelUp) return;
    sentinelUp = false;
    setSheet(null);
    const fn = afterClose;
    afterClose = null;
    fn?.();
  };
  window.addEventListener("popstate", onPop);
  return () => window.removeEventListener("popstate", onPop);
}
