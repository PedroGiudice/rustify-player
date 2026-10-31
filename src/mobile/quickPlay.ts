/* ============================================================
   quickPlay.ts — "tocar alguma coisa" sem escolher faixa (A64).

   O desktop ganhou "Continuar" e "Aleatório" no Now Playing vazio
   (A20 de 26/10, src/lib/quickPlay.ts); aqui o mesmo para o Now
   Playing e o mini do S24:
     - Continuar <última>: a faixa mais recente do anel de recentes,
       sozinha na fila; a continuidade (rádio) segue depois dela, como
       o playAlone do desktop;
     - Tudo em aleatório: o "Shuffle all" da Home.
   ============================================================ */

import { playTrackFrom, recents, shuffleAll, tracks } from "./store";
import type { Track } from "./types";

export interface QuickAction {
  /** Texto do botão (e nome acessível, salvo `aria`). */
  label: string;
  aria?: string;
  primary?: boolean;
  run: () => void;
}

/** Última faixa que contou como play, se houver. */
export const lastPlayed = (): Track | null => recents()[0] ?? null;

export function resumeLast(): void {
  const t = lastPlayed();
  if (t) void playTrackFrom([t], 0);
}

export function quickActions(): QuickAction[] {
  const out: QuickAction[] = [];
  const last = lastPlayed();
  if (last) out.push({ label: `Continuar ${last.title}`, primary: true, run: resumeLast });
  if (tracks().length) out.push({ label: "Tudo em aleatório", run: () => void shuffleAll() });
  return out;
}
