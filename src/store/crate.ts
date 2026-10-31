/* ============================================================
   store/crate.ts — Board de downloads do Crate (fila global).

   Ciclo LONGO, atravessa views (spec §3.5, M6): a fila precisa
   alimentar o badge da sidebar mesmo com a view Crate desmontada,
   diferente da busca (ciclo curto, poll na própria view). Por isso
   o boot é feito uma vez a partir de main.tsx — não em Crate.tsx.

   bootCrateStore() é idempotente (flag `booted`): chamar de novo
   (ex.: Crate.tsx também chama por segurança, ou em testes) é
   no-op depois da primeira vez.

   A fila da Tidal (VM) também mora aqui desde 31/10/2026 (A17): o que
   ela baixa conta no selo e nas chegadas da barra lateral, com o Crate
   aberto ou não. Poll de 10 s com o Crate aberto e 60 s fechado; parado
   com a janela oculta e, com o Crate fechado, enquanto a VM não responde.
   ============================================================ */

import { createSignal } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import {
  slskJobs, onSlskJobs, crateTidalJobs,
  type DownloadJob, type TidalJob, type SearchSnapshot, type ScResult,
} from "../tauri";
import { isTidalActive, tidalArrivedCount } from "../lib/tidalFila";

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
// Peso por job: 1 por faixa do Soulseek/SoundCloud; o job da Tidal pesa as
// faixas que chegaram (um mix de 50 não é "1 faixa nova").
let knownReady = new Set<string>();
let hydrated = false;
const [arrivals, setArrivals] = createSignal<ReadonlyMap<string, number>>(new Map());

function addArrivals(fresh: [string, number][]): void {
  const real = fresh.filter(([, n]) => n > 0);
  if (real.length) setArrivals((a) => new Map([...a, ...real]));
}

/** Ids de job que viraram `ready` agora e não estavam prontos antes. */
export function newlyReady(known: ReadonlySet<string>, next: DownloadJob[]): string[] {
  return next.filter((j) => j.state.kind === "ready" && !known.has(j.job_id)).map((j) => j.job_id);
}

function trackArrivals(next: DownloadJob[]): void {
  const fresh = newlyReady(knownReady, next);
  knownReady = new Set(next.filter((j) => j.state.kind === "ready").map((j) => j.job_id));
  if (!hydrated) { hydrated = true; return; }
  addArrivals(fresh.map((id) => [id, 1]));
}

/** Faixas novas no acervo desde a última vez que o Crate foi aberto. */
export const newArrivalsCount = (): number => {
  let n = 0;
  for (const v of arrivals().values()) n += v;
  return n;
};
/** Mesmo contador, nome usado pela barra lateral. */
export const newArrivals = newArrivalsCount;

/** O Crate está aberto: o dono já está vendo as chegadas. */
export function markArrivalsSeen(): void {
  if (arrivals().size) setArrivals(new Map<string, number>());
}

function setJobsSignal(next: DownloadJob[]): void {
  trackArrivals(next);
  setBoard("list", reconcile(next, { key: "job_id" }));
}

export const jobs = (): DownloadJob[] => board.list;

/** Downloads em andamento: board do Crate (Soulseek, SoundCloud) mais os
    jobs da Tidal na fila ou baixando. */
export function activeCount(): number {
  return board.list.filter((j) => NON_TERMINAL_KINDS.has(j.state.kind)).length
    + tidal.jobs.filter((j) => isTidalActive(j.status)).length;
}

// ── Fila da Tidal (VM) ──────────────────────────────────────────
export const TIDAL_POLL_OPEN_MS = 10_000;
export const TIDAL_POLL_CLOSED_MS = 60_000;

const [tidalState, setTidal] = createStore<{
  jobs: TidalJob[];
  pastas: string[];
  load: "loading" | "loaded" | "error";
  loadError: string | null;
}>({ jobs: [], pastas: [], load: "loading", loadError: null });
/** Estado da fila da Tidal (somente leitura fora daqui). */
export const tidal = tidalState;

let tidalKnownDone = new Set<string>();
let tidalHydrated = false;
let crateOpen = false;
/** Aba do Crate que mostra a fila da Tidal (Fila ou Tidal) está à vista. */
let tidalFocus = true;
let tidalTimer: ReturnType<typeof setTimeout> | undefined;
/** Ritmo do timer armado agora (true = 10 s). */
let scheduledFast = false;
let tidalSeq = 0;

function errorText(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e ?? "");
}

function trackTidalArrivals(next: TidalJob[]): void {
  const done = next.filter((j) => j.status === "ok" || j.status === "parcial");
  const fresh = done.filter((j) => !tidalKnownDone.has(j.id));
  tidalKnownDone = new Set(done.map((j) => j.id));
  if (!tidalHydrated) { tidalHydrated = true; return; }
  addArrivals(fresh.map((j) => [`tidal:${j.id}`, tidalArrivedCount(j)]));
}

/** Consulta a fila da VM agora. Resposta de uma consulta mais velha que a
    última é descartada. */
export async function refreshTidal(): Promise<void> {
  const seq = ++tidalSeq;
  try {
    const snap = await crateTidalJobs();
    if (seq !== tidalSeq) return;
    trackTidalArrivals(snap.jobs);
    setTidal("jobs", reconcile(snap.jobs, { key: "id" }));
    setTidal({ pastas: snap.pastas, load: "loaded", loadError: null });
    // Job que começou (ou terminou) muda o ritmo: não espera a volta lenta.
    if (booted && tidalTimer !== undefined && tidalFast() !== scheduledFast) scheduleTidal();
  } catch (e) {
    if (seq !== tidalSeq) return;
    setTidal({ load: "error", loadError: errorText(e) || null });
  }
}

function scheduleTidal(): void {
  clearTimeout(tidalTimer);
  scheduledFast = tidalFast();
  tidalTimer = setTimeout(() => {
    const hidden = typeof document !== "undefined" && document.visibilityState === "hidden";
    const parked = !crateOpen && tidalState.load === "error";
    if (!hidden && !parked) void refreshTidal();
    scheduleTidal();
  }, scheduledFast ? TIDAL_POLL_OPEN_MS : TIDAL_POLL_CLOSED_MS);
}

/** 10 s só com o Crate aberto E (fila da Tidal à vista OU job andando): na
    aba Buscar, sem nada baixando, a consulta à VM pela tailnet não muda nada
    na tela; as chegadas da barra lateral seguem no ritmo de 60 s (A49). */
function tidalFast(): boolean {
  return crateOpen && (tidalFocus || tidal.jobs.some((j) => isTidalActive(j.status)));
}

/** A aba à vista do Crate mostra a fila da Tidal (Fila, Tidal) ou não (Buscar). */
export function setCrateTidalFocus(on: boolean): void {
  if (on === tidalFocus) return;
  const wasFast = tidalFast();
  tidalFocus = on;
  if (!booted || !crateOpen) return;
  if (on && !wasFast) void refreshTidal();
  if (tidalFast() !== wasFast) scheduleTidal();
}

/** A view do Crate abriu ou fechou: abrir consulta na hora e passa a 10 s. */
export function setCrateViewOpen(open: boolean): void {
  if (open === crateOpen) return;
  crateOpen = open;
  if (!booted) return;
  if (open) void refreshTidal();
  scheduleTidal();
}

// ── Busca preservada (B28) ─────────────────────────────────────
// Sair do Crate não joga fora uma busca de 25 s (uma das 40 por hora):
// a view guarda o estado aqui ao desmontar e retoma por 10 min.
export const SEARCH_CACHE_MS = 10 * 60_000;

export interface SearchCache {
  query: string;
  searchId: string | null;
  snapshot: SearchSnapshot | null;
  scResults: ScResult[];
  scState: "idle" | "loading" | "done" | "empty" | "error";
  scError: string | null;
  groupJobs: Record<string, string>;
  rowOverrides: Record<string, string>;
  savedAt: number;
}

let searchCache: SearchCache | null = null;

export function saveSearchCache(c: SearchCache | null): void {
  searchCache = c;
}

/** A busca guardada, se ainda vale (menos de 10 min). */
export function loadSearchCache(now = Date.now()): SearchCache | null {
  if (!searchCache || now - searchCache.savedAt > SEARCH_CACHE_MS) return null;
  return searchCache;
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
  void refreshTidal();
  scheduleTidal();
}

// ── Destino persistido (kv-crate-dest) ──────────────────────────
// Precedência de destino (spec §4.5): override da toolbar > artista já no
// acervo (suggested_dest) > ESTE valor > seletor obrigatório. Resolvido
// na view (Crate.tsx); aqui só a persistência crua.
// Uma memória só para o Crate inteiro (B7, 31/10/2026): Buscar, SoundCloud e
// Tidal lembram a mesma pasta. A chave antiga da aba Tidal é só leitura.
const DEST_KEY = "kv-crate-dest";
const LEGACY_TIDAL_DEST_KEY = "kv-crate-tidal-dest";

export function loadLastDest(): string | null {
  try {
    return localStorage.getItem(DEST_KEY) ?? localStorage.getItem(LEGACY_TIDAL_DEST_KEY);
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
  setArrivals(new Map<string, number>());
  clearTimeout(tidalTimer);
  tidalTimer = undefined;
  crateOpen = false;
  tidalFocus = true;
  tidalSeq++;
  tidalKnownDone = new Set();
  tidalHydrated = false;
  setTidal({ jobs: [], pastas: [], load: "loading", loadError: null });
  searchCache = null;
}
