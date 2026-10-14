/* ============================================================
   lib/dedup.ts — "já tem no acervo?" por título, a regra do Crate.
   Saiu de views/Crate.tsx para a aba Tidal reaproveitar sem importar
   a view (Crate.tsx reexporta `dedupMatch`).
   ============================================================ */

import type { Track } from "../tauri";

/** Minúsculas, sem acento, só letras/dígitos separados por espaço. */
export function normWords(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Qual faixa do acervo o banner "Já tem no acervo" pode afirmar. O probe
    (busca local) casa cada termo por substring em título, artista OU
    álbum, então buscar por artista/álbum sempre achava alguma faixa, e o
    banner afirmava posse de uma faixa que o usuário não buscou (crate-v4).
    Só vale a faixa cujo título (sem "(feat. …)", "[…]" e " - sufixo")
    aparece inteiro, como palavras, no termo buscado. */
export function dedupMatch(query: string, tracks: Track[]): Track | null {
  const q = ` ${normWords(query)} `;
  return (
    tracks.find((t) => {
      const core = normWords(t.title.replace(/\([^)]*\)|\[[^\]]*\]/g, " ").replace(/\s[-–—]\s.*$/, " "));
      return core.length > 0 && q.includes(` ${core} `);
    }) ?? null
  );
}
