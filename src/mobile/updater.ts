/* ============================================================
   updater.ts — estado do auto-update (spec 2026-08-24).

   O trabalho (HTTP, sha256, PackageInstaller) é do Kotlin. Aqui só
   vive o estado da UI: resultado do check, progresso do download e
   o throttle do check automático de boot. Sideload nunca é
   silencioso — o sistema pede confirmação; "done" raramente chega
   porque a instalação reinicia o processo.
   ============================================================ */

import { createSignal } from "solid-js";
import * as ipc from "./ipc";
import { showToast } from "./store";
import type { UpdateCheck, UpdaterProgress } from "./types";

export type UpdPhase =
  | "idle"
  | "checking"
  | "uptodate"
  | "available"
  | "needs_permission"
  | "downloading"
  | "verifying"
  | "installing"
  | "confirm_pending"
  | "confirming"
  | "done"
  | "failed";

export interface UpdState {
  phase: UpdPhase;
  check: UpdateCheck | null;
  bytes: number;
  total: number;
  error: string | null;
}

const CHECK_KEY = "kv-mobile-upd-check";
/** Check automático no máximo a cada 6h (spec). */
export const BOOT_THROTTLE_MS = 6 * 3_600_000;

const [upd, setUpd] = createSignal<UpdState>({
  phase: "idle",
  check: null,
  bytes: 0,
  total: 0,
  error: null,
});
const [appVersion, setAppVersion] = createSignal<string>("");
export { upd, appVersion };

/** Puro: evento do plugin -> estado novo. */
export function reduceProgress(s: UpdState, ev: UpdaterProgress): UpdState {
  switch (ev.phase) {
    case "downloading":
      // total -1 = Content-Length desconhecido; nunca mostrar "-0,0 MB".
      return {
        ...s,
        phase: "downloading",
        bytes: ev.bytes ?? s.bytes,
        total: Math.max(0, ev.total ?? s.total),
        error: null,
      };
    case "failed":
      return { ...s, phase: "failed", error: ev.message ?? "falha desconhecida" };
    default:
      return { ...s, phase: ev.phase, error: null };
  }
}

/** Puro: `last` é o epoch-ms salvo (string) ou null. */
export function bootCheckDue(last: string | null, nowMs: number, throttleMs = BOOT_THROTTLE_MS): boolean {
  if (!last) return true;
  const t = Number(last);
  if (!Number.isFinite(t)) return true;
  return nowMs - t >= throttleMs;
}

export function fmtBytes(n: number): string {
  const mb = n / 1_048_576;
  return `${mb.toLocaleString("pt-BR", { minimumFractionDigits: mb ? 1 : 0, maximumFractionDigits: 1 })} MB`;
}

/**
 * Ocupado = o Kotlin ainda está trabalhando. `confirming`/`confirm_pending`
 * NÃO contam: o diálogo do sistema pode ter sumido (ligação, Home) sem
 * nenhum status voltar, e aí o único caminho é o usuário re-tentar.
 */
export const updBusy = () => ["checking", "downloading", "verifying", "installing"].includes(upd().phase);

/** Puro: fase após um check que FALHOU. O último resultado válido prevalece —
 *  falha de rede não pode promover "atualizado" a "disponível". */
export function phaseAfterCheckFailure(check: UpdateCheck | null): UpdPhase {
  if (!check) return "idle";
  return check.available ? "available" : "uptodate";
}

export async function loadAppVersion() {
  try {
    setAppVersion(await ipc.appVersion());
  } catch (e) {
    console.warn("[mobile] app_version falhou:", e);
  }
}

/**
 * `manual=true` (botão): erro vira toast. `manual=false` (boot): silencioso,
 * só o log — sem rede no boot não é notícia.
 */
export async function checkForUpdate(manual: boolean): Promise<void> {
  if (updBusy()) return;
  setUpd((s) => ({ ...s, phase: "checking", error: null }));
  try {
    const check = await ipc.updaterCheck();
    localStorage.setItem(CHECK_KEY, String(Date.now()));
    if (check.installed) setAppVersion(check.installed);
    setUpd({ phase: check.available ? "available" : "uptodate", check, bytes: 0, total: 0, error: null });
    if (check.available && !manual) showToast(`Atualização ${check.latest} disponível — veja em Settings`);
    if (!check.available && manual) showToast("Você já está na versão mais recente");
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    console.warn("[mobile] updater_check falhou:", msg);
    setUpd((s) => ({ ...s, phase: phaseAfterCheckFailure(s.check), error: manual ? msg : null }));
    if (manual) showToast("Não deu para consultar o release");
  }
}

export async function installUpdate(): Promise<void> {
  const s = upd();
  const check = s.check;
  if (!check?.apkUrl || updBusy()) return;
  setUpd((x) => ({ ...x, phase: "downloading", bytes: 0, total: check.size, error: null }));
  try {
    const r = await ipc.updaterInstall({ url: check.apkUrl, sha256: check.sha256, size: check.size });
    if (r.status === "needs_permission") {
      setUpd((x) => ({ ...x, phase: "needs_permission" }));
      showToast("Libere 'instalar apps desconhecidos' e toque de novo");
    } else if (r.status === "busy") {
      setUpd((x) => ({ ...x, phase: "downloading" }));
    }
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    setUpd((x) => ({ ...x, phase: "failed", error: msg }));
  }
}

/** Boot: versão instalada + listener de progresso + check com throttle. */
export function bootUpdater(): void {
  void loadAppVersion();
  ipc
    .onUpdaterProgress((ev) => {
      setUpd((s) => reduceProgress(s, ev));
      // O usuário pode estar em qualquer tela: falha e conclusão são notícia.
      if (ev.phase === "failed") showToast(`Atualização falhou: ${(ev.message ?? "erro").slice(0, 70)}`);
      else if (ev.phase === "done") showToast("Atualização instalada");
    })
    .catch((e) => console.warn("[mobile] listener updater_progress:", e));
  if (bootCheckDue(localStorage.getItem(CHECK_KEY), Date.now())) {
    // Depois do boot pesado (biblioteca, fila): nada disso é urgente.
    setTimeout(() => void checkForUpdate(false), 4000);
  }
}
