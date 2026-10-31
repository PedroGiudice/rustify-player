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

/** Job da Tidal ainda em andamento (conta no "baixando" e no selo). */
export function isTidalActive(status: TidalJob["status"]): boolean {
  return status === "fila" || status === "baixando";
}

/** Quantas faixas o job pôs no acervo, lido do resumo da fila
    (`resumo_do_log` em tidal_fila.py: "...; N na cmr-auto" é o que chegou;
    sem ele, "N novas"). Sem número no resumo: as faixas do pedido de
    seleção, ou 1. */
export function tidalArrivedCount(job: Pick<TidalJob, "resumo" | "n_faixas">): number {
  const env = /(\d+) na cmr-auto/.exec(job.resumo);
  if (env) return parseInt(env[1], 10);
  const novas = /(\d+) novas/.exec(job.resumo);
  if (novas) return parseInt(novas[1], 10);
  return job.n_faixas && job.n_faixas > 0 ? job.n_faixas : 1;
}
