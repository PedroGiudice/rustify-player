/* ============================================================
   store/crate.ts — Board de downloads do Crate (fila global).

   Ciclo LONGO, atravessa views (spec §3.5, M6): a fila precisa
   alimentar o badge da sidebar mesmo com a view Crate desmontada,
   diferente da busca (ciclo curto, poll na própria view). Por isso
   o boot é feito uma vez a partir de main.tsx — não em Crate.tsx.

   bootCrateStore() é idempotente (flag `booted`): chamar de novo
   (ex.: Crate.tsx também chama por segurança, ou em testes) é
   no-op depois da primeira vez.
   ============================================================ */

import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { slskJobs, onSlskJobs, type DownloadJob } from "../tauri";

// Estados não-terminais (board.rs IN_FLIGHT + Queued — Queued ainda não
// tem transfer no slskd mas conta como "em progresso" pro usuário/badge).
// `waiting` (Bandcamp esperando compra ou link do e-mail) não ocupa vaga de
// transferência no backend, mas para o usuário ainda está em andamento.
const NON_TERMINAL_KINDS = new Set<DownloadJob["state"]["kind"]>([
  "queued",
  "enqueued",
  "downloading",
  "stalled",
  "processing",
  "indexing",
  "waiting",
]);

// Store reconciliado por `job_id`: cada slsk-jobs traz o board inteiro em
// objetos novos (spec §3.5); com um signal simples, o <For> da Fila
// descartava e recriava todas as linhas a cada evento (crate-1). Com o
// reconcile, o mesmo job mantém a identidade e só os campos que mudaram
// notificam.
const [board, setBoard] = createStore<{ list: DownloadJob[] }>({ list: [] });

function setJobsSignal(next: DownloadJob[]): void {
  setBoard("list", reconcile(next, { key: "job_id" }));
}

export const jobs = (): DownloadJob[] => board.list;

export function activeCount(): number {
  return board.list.filter((j) => NON_TERMINAL_KINDS.has(j.state.kind)).length;
}

// ── Chegadas não vistas (B8 da avaliação Impeccable de 26/10) ──
// Faixa que fica `ready` com o dono fora do Crate acende um ponto no item
// da barra lateral ("n faixas novas no acervo") até ele abrir o Crate. Só
// conta o que chegou NESTA sessão: o board reidratado no boot entra como
// visto (senão todo download antigo acenderia o ponto a cada abertura).
// Cada job `ready` é uma faixa (o estado carrega um único track_id).
const [seenReady, setSeenReady] = createSignal<ReadonlySet<string>>(new Set());

const readyIds = (): string[] =>
  board.list.filter((j) => j.state.kind === "ready").map((j) => j.job_id);

export function newArrivals(): number {
  const seen = seenReady();
  return readyIds().filter((id) => !seen.has(id)).length;
}

/** Marca como vistas todas as faixas prontas do board. Chamado enquanto a
    rota é /crate (Sidebar.tsx). */
export function markArrivalsSeen(): void {
  const seen = seenReady();
  const fresh = readyIds().filter((id) => !seen.has(id));
  if (fresh.length === 0) return;
  setSeenReady(new Set([...seen, ...fresh]));
}

let booted = false;

/** Re-hidrata via slskJobs() e assina slsk-jobs. Idempotente — chamadas
    subsequentes são no-op (o app inteiro compartilha um único board). */
export async function bootCrateStore(): Promise<void> {
  if (booted) return;
  booted = true;
  try {
    setJobsSignal(await slskJobs());
    markArrivalsSeen();
  } catch (e) {
    console.error("[crate] slskJobs falhou no boot:", e);
  }
  try {
    await onSlskJobs((next) => setJobsSignal(next));
  } catch (e) {
    console.error("[crate] onSlskJobs falhou ao assinar:", e);
  }
}

// ── Destino persistido (kv-crate-dest) ──────────────────────────
// Precedência de destino (spec §4.5): override da toolbar > artista já no
// acervo (suggested_dest) > ESTE valor > seletor obrigatório. Resolvido
// na view (Crate.tsx); aqui só a persistência crua.
const DEST_KEY = "kv-crate-dest";

export function loadLastDest(): string | null {
  try {
    return localStorage.getItem(DEST_KEY);
  } catch {
    return null;
  }
}

export function saveLastDest(dest: string): void {
  try {
    localStorage.setItem(DEST_KEY, dest);
  } catch {}
}

/** Só para testes — reseta o singleton (booted + jobs) entre casos.
    Produção nunca chama isto: o board vive por toda a sessão do app. */
export function __resetForTests(): void {
  booted = false;
  setJobsSignal([]);
  setSeenReady(new Set<string>());
}
