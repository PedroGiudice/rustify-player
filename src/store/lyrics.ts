/* ============================================================
   store/lyrics.ts — letra da faixa atual e o estado da busca (A14).

   Antes a letra morava só no Now Playing e a falha virava lista vazia:
   o botão de letra da barra não sabia distinguir "sem letra", "escondida"
   e "falhou". Aqui a busca roda uma vez por troca de faixa e diz qual dos
   quatro estados vale:
     carregando — IPC em voo (a letra anterior não vale mais);
     ok         — há linhas;
     sem        — a faixa não tem letra;
     erro       — a busca falhou; reloadLyrics() tenta de novo.
   ============================================================ */

import { createEffect, createRoot, createSignal, on } from "solid-js";
import { libGetLyrics, type LyricLine } from "../tauri";
import { player } from "./player";

export type LyricsStatus = "carregando" | "ok" | "sem" | "erro";
export interface LyricsState { trackId: string | null; status: LyricsStatus; lines: LyricLine[] }

const EMPTY: LyricsState = { trackId: null, status: "sem", lines: [] };
const [lyricsState, setLyricsState] = createSignal<LyricsState>(EMPTY);
export { lyricsState };

let seq = 0;

function load(id: string | null) {
  const mine = ++seq;
  if (!id) { setLyricsState(EMPTY); return; }
  setLyricsState({ trackId: id, status: "carregando", lines: [] });
  libGetLyrics(id).then(
    (ls) => {
      if (mine !== seq) return;
      const lines = Array.isArray(ls) ? ls : [];
      setLyricsState({ trackId: id, status: lines.length ? "ok" : "sem", lines });
    },
    () => {
      if (mine !== seq) return;
      setLyricsState({ trackId: id, status: "erro", lines: [] });
    },
  );
}

/** Refaz a busca da faixa atual (depois de um erro). */
export function reloadLyrics() {
  load(player.currentTrack?.id ?? null);
}

// Dono próprio: o efeito vive o app inteiro e não depende de quem o importa.
// Não persiste nada, então rodar no import não sobrescreve estado salvo.
createRoot(() => {
  createEffect(on(() => player.currentTrack?.id ?? null, load));
});
