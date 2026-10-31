// src/lib/loaded.ts — resultado de leitura do acervo que guarda a falha.
//
// Todo `catch` das views da biblioteca devolvia `[]`: com o Qdrant
// engasgado a tela dizia "Nenhuma faixa" como se o acervo tivesse sumido
// (A7, varredura de 31/10). `settle` troca a exceção por um valor, e
// `listState` separa os quatro estados que a tela precisa distinguir.
// Valor e não exceção de propósito: um resource em erro lança ao ser
// lido, e a leitura dentro do JSX derrubaria a tela no ErrorBoundary.

import type { Resource } from "solid-js";

export type Loaded<T> = { ok: true; data: T } | { ok: false; error: string };

export type ListState = "carregando" | "erro" | "vazio" | "pronto";

function message(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

export async function settle<T>(work: Promise<T> | (() => Promise<T>)): Promise<Loaded<T>> {
  try {
    const data = await (typeof work === "function" ? work() : work);
    return { ok: true, data };
  } catch (e) {
    return { ok: false, error: message(e) };
  }
}

export function listState<T>(r: Loaded<T[]> | undefined): ListState {
  if (r === undefined) return "carregando";
  if (!r.ok) return "erro";
  return r.data.length === 0 ? "vazio" : "pronto";
}

/** Último valor de um resource SEM acionar o Suspense da rota. `r()` e até
    `r.latest` (na primeira carga) registram no Suspense mais próximo, e o
    RouterView trocava a tela inteira por "Loading…" a cada troca de aba ou
    recarga depois de mover. `r.state` é só um sinal: antes de resolver
    devolve undefined (a tela mostra o próprio carregando); na recarga
    mantém o valor anterior. */
export function peek<T>(r: Resource<T>): T | undefined {
  const s = r.state;
  return s === "ready" || s === "refreshing" ? r.latest : undefined;
}

/** Os dados de um resultado, ou lista vazia enquanto carrega ou se falhou. */
export function dataOf<T>(r: Loaded<T[]> | undefined): T[] {
  return r && r.ok ? r.data : [];
}
