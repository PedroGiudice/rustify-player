/* ============================================================
   lib/tidalFila.ts — funções puras da seção Tidal do Crate: link
   curto, rótulo/estilo do estado do job, e o destino persistido
   (kv-crate-tidal-dest). A chamada de rede (list/enqueue) vive em
   tauri.ts; aqui só o que é testável sem IPC.
   ============================================================ */

import type { TidalJob } from "../tauri";

/** Link curto para a linha da fila: tudo depois de "tidal.com/" (mesmo
    recorte da página web em `tidal_fila.py`, `fila_html`). Sem match,
    devolve o link inteiro. */
export function shortTidalLink(url: string): string {
  const i = url.indexOf("tidal.com/");
  return i === -1 ? url : url.slice(i + "tidal.com/".length);
}

/** Rótulo em PT-BR do estado do job (mesmo dicionário da página web). */
export function tidalStatusLabel(status: TidalJob["status"]): string {
  switch (status) {
    case "fila": return "na fila";
    case "baixando": return "baixando";
    case "ok": return "na cmr-auto";
    case "parcial": return "parcial";
    case "falhou": return "falhou";
    case "recusada": return "recusada";
  }
}

/** Classe de tom do chip (`.crate-pill--*`, extractor-lab.css) por estado:
    "fila" fica neutro (sub), "baixando" em andamento (live), "ok" pronto
    (ready), "parcial"/"falhou" precisam de atenção (warn/err); "recusada" =
    nada chegou, tudo lossy por dentro (err: o CEO procurava a faixa no acervo). */
export function tidalStatusTone(status: TidalJob["status"]): "sub" | "live" | "ready" | "warn" | "err" {
  switch (status) {
    case "fila": return "sub";
    case "baixando": return "live";
    case "ok": return "ready";
    case "parcial": return "warn";
    case "falhou": return "err";
    case "recusada": return "err";
  }
}

const DEST_KEY = "kv-crate-tidal-dest";

export function loadLastTidalDest(): string | null {
  try {
    return localStorage.getItem(DEST_KEY);
  } catch {
    return null;
  }
}

export function saveLastTidalDest(dest: string): void {
  try {
    localStorage.setItem(DEST_KEY, dest);
  } catch {}
}
