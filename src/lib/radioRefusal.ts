/* lib/radioRefusal.ts — recusar e devolver ao rádio, com Desfazer (B9).

   Um gesto, um aviso: "nunca no rádio" e "fora desta station" (menu de
   contexto da faixa) e "Devolver ao rádio" (lista Fora do rádio) avisam
   pelo store/toast com [Desfazer], que grava de volta o estado de antes
   (`libRadioRestore(before)`). Falha sai por lib/failNotice.

   `radioRevision` sobe a cada mudança gravada: a lista "Fora do rádio"
   relê quando ele muda (a recusa feita pelo menu aparece lá sem recarregar). */

import { createSignal } from "solid-js";
import { libRadioRefuse, libRadioReturn, libRadioRestore } from "../tauri";
import type { RadioChange, Track } from "../tauri";
import { showToast } from "../store/toast";
import { failNotice } from "./failNotice";

const [radioRevision, setRadioRevision] = createSignal(0);
export { radioRevision };
const bump = () => setRadioRevision((n) => n + 1);

const name = (t: Pick<Track, "title">) => `“${t.title || "faixa"}”`;

function offerUndo(message: string, t: Pick<Track, "id" | "title">, ch: RadioChange) {
  showToast({
    message,
    action: {
      label: "Desfazer",
      run: () => {
        libRadioRestore(t.id, ch.before)
          .then(bump)
          .catch((e) => failNotice(`Não consegui desfazer a mudança em ${name(t)}.`, e));
      },
    },
  });
}

/** "never" = nunca no rádio (autoplay e todas as stations); "station" = só
    a station dada. */
export async function refuseFromRadio(
  t: Pick<Track, "id" | "title">,
  scope: "never" | "station",
  station?: { id: string; name?: string | null },
): Promise<void> {
  try {
    const ch = await libRadioRefuse(t.id, scope, scope === "station" ? station?.id : undefined);
    bump();
    const where = scope === "station"
      ? (station?.name ? `na station ${station.name}` : "nesta station")
      : "no rádio";
    offerUndo(`${name(t)} não toca mais ${where}`, t, ch);
  } catch (e) {
    failNotice(`Não consegui tirar ${name(t)} do rádio.`, e, () => { void refuseFromRadio(t, scope, station); });
  }
}

/** Devolve ao rádio por inteiro: tira as recusas e perdoa os pulos cedo. */
export async function returnToRadio(t: Pick<Track, "id" | "title">): Promise<void> {
  try {
    const ch = await libRadioReturn(t.id);
    bump();
    offerUndo(`${name(t)} voltou ao rádio`, t, ch);
  } catch (e) {
    const warming = String(e).includes("montando");
    failNotice(
      warming
        ? `Não consegui devolver ${name(t)} ao rádio: o motor ainda está carregando.`
        : `Não consegui devolver ${name(t)} ao rádio.`,
      e,
      () => { void returnToRadio(t); },
    );
  }
}
