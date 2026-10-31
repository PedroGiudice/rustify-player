/* lib/failNotice.ts — aviso de falha de um gesto do dono (B5).

   Tocar, curtir, embaralhar e mexer em station que falham avisavam só no
   console. O aviso sai pelo store/toast (um por vez, mesmo lugar do
   "Desfazer"), começa por "Não consegui…" e, quando refazer o gesto faz
   sentido, traz [Tentar de novo]. O erro segue no console para diagnóstico. */
import { showToast } from "../store/toast";

export const RETRY_LABEL = "Tentar de novo";

export function failNotice(message: string, err: unknown, retry?: () => void): void {
  console.error(`[falha] ${message}`, err);
  showToast({ message, action: retry ? { label: RETRY_LABEL, run: retry } : undefined });
}
