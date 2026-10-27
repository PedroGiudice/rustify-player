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

// ── Chegadas (B8): faixas que ficaram prontas desde a última abertura do Crate ──
// O badge de `activeCount` some quando o job termina; este contador fica até o
// dono abrir o Crate, para a barra lateral avisar que algo novo entrou no
// acervo. Jobs já prontos no snapshot do boot não contam (são de antes).
let knownReady = new Set<string>();
let hydrated = false;
const [arrivals, setArrivals] = createSignal<ReadonlySet<string>>(new Set());

/** Ids de job que viraram `ready` agora e não estavam prontos antes. */
export function newlyReady(known: ReadonlySet<string>, next: DownloadJob[]): string[] {
  return next.filter((j) => j.state.kind === "ready" && !known.has(j.job_id)).map((j) => j.job_id);
}

function trackArrivals(next: DownloadJob[]): void {
  const fresh = newlyReady(knownReady, next);
  knownReady = new Set(next.filter((j) => j.state.kind === "ready").map((j) => j.job_id));
  if (!hydrated) { hydrated = true; return; }
  if (fresh.length) setArrivals((a) => new Set([...a, ...fresh]));
}

/** Faixas novas no acervo desde a última vez que o Crate foi aberto. */
export const newArrivalsCount = (): number => arrivals().size;
/** Mesmo contador, nome usado pela barra lateral. */
export const newArrivals = newArrivalsCount;

/** O Crate está aberto: o dono já está vendo as chegadas. */
export function markArrivalsSeen(): void {
  if (arrivals().size) setArrivals(new Set<string>());
}

function setJobsSignal(next: DownloadJob[]): void {
  trackArrivals(next);
  setBoard("list", reconcile(next, { key: "job_id" }));
}

export const jobs = (): DownloadJob[] => board.list;

export function activeCount(): number {
  return board.list.filter((j) => NON_TERMINAL_KINDS.has(j.state.kind)).length;
}

let booted = false;

/** Re-hidrata via slskJobs() e assina slsk-jobs. Idempotente — chamadas
    subsequentes são no-op (o app inteiro compartilha um único board). */
export async function bootCrateStore(): Promise<void> {
  if (booted) return;
  booted = true;
  try {
    setJobsSignal(await slskJobs());
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
  knownReady = new Set();
  hydrated = false;
  setArrivals(new Set<string>());
}
