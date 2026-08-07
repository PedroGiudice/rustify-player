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
import { slskJobs, onSlskJobs, type DownloadJob } from "../tauri";

// Estados não-terminais (board.rs IN_FLIGHT + Queued — Queued ainda não
// tem transfer no slskd mas conta como "em progresso" pro usuário/badge).
const NON_TERMINAL_KINDS = new Set<DownloadJob["state"]["kind"]>([
  "queued",
  "enqueued",
  "downloading",
  "stalled",
  "processing",
  "indexing",
]);

const [jobsSignal, setJobsSignal] = createSignal<DownloadJob[]>([]);
export const jobs = jobsSignal;

export function activeCount(): number {
  return jobsSignal().filter((j) => NON_TERMINAL_KINDS.has(j.state.kind)).length;
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
}
