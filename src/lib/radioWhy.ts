/* lib/radioWhy.ts — o motor explica a escolha e a recusa (B9, B10).

   Princípio 3 do produto: o algoritmo serve ao dono, explica a escolha e
   aceita negativo com escopo. Aqui só o TEXTO, puro e testado:
   - autoplayReasonText: a linha curta sob a faixa que o rádio escolheu
     (gaveta da fila e /queue), a partir do `autoplay_reason` do backend;
   - exclusionText: por que a faixa está "Fora do rádio", em números. */

import type { AutoplayReason, RadioExclusion } from "../tauri";

const vezes = (n: number) => (n === 1 ? "1 vez" : `${n} vezes`);

/** Linha curta do motivo: "Conhecida: você ouviu até o fim 7 vezes",
    "Descoberta", "Parecida com “Alright”". `seedTitle` = título da faixa
    que semeou o pedido, quando se sabe. */
export function autoplayReasonText(r: AutoplayReason, seedTitle?: string | null): string {
  const ended = r.ended;
  switch (r.kind) {
    case "known":
      if (r.liked) {
        return ended && ended > 0
          ? `Conhecida: você curtiu e ouviu até o fim ${vezes(ended)}`
          : "Conhecida: você curtiu";
      }
      return ended !== null && ended > 0 ? `Conhecida: você ouviu até o fim ${vezes(ended)}` : "Conhecida";
    case "discovery":
      if (ended === null) return "Descoberta";
      return ended === 0 ? "Descoberta: nunca ouvida até o fim" : `Descoberta: ouvida até o fim só ${vezes(ended)}`;
    case "similar":
      return seedTitle ? `Parecida com “${seedTitle}”` : "Parecida com a faixa de partida";
    case "shuffle":
      return "Sorteio do acervo";
  }
}

const MONTHS = ["jan", "fev", "mar", "abr", "mai", "jun", "jul", "ago", "set", "out", "nov", "dez"];

/** "hoje", "ontem", "em 12 out", "em 12 out 2025" (unix s; `now` em ms). */
function onDay(ts: number, now: number): string {
  const then = new Date(ts * 1000);
  const today = new Date(now);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(today) - day(then)) / 86_400_000);
  if (days <= 0) return "hoje";
  if (days === 1) return "ontem";
  const date = `${then.getDate()} ${MONTHS[then.getMonth()]}`;
  return `em ${then.getFullYear() === today.getFullYear() ? date : `${date} ${then.getFullYear()}`}`;
}

function joinPt(items: string[]): string {
  return items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} e ${items[items.length - 1]}`;
}

/** Por que a faixa está fora do rádio, em números. `stationName` resolve o
    id da station (undefined = station apagada). */
export function exclusionText(
  r: RadioExclusion,
  stationName: (id: string) => string | undefined,
  now: number = Date.now(),
): string {
  const parts: string[] = [];
  if (r.never_at) parts.push(`Você tirou do rádio ${onDay(r.never_at, now)}`);
  if (r.never_ends) {
    parts.push(
      `Pulada cedo ${vezes(r.early_skips)} nas ${r.motor_attempts} em que o rádio a tocou, ` +
        (r.ended > 0 ? `ouvida até o fim só ${vezes(r.ended)}` : "nunca até o fim"),
    );
  }
  if (r.off_stations.length > 0) {
    const known = r.off_stations.map(stationName).filter((n): n is string => !!n);
    const gone = r.off_stations.length - known.length;
    if (known.length > 0) {
      parts.push(known.length === 1 ? `Fora da station ${known[0]}` : `Fora das stations ${joinPt(known)}`);
    }
    if (gone > 0) {
      parts.push(gone === 1 ? "Fora de 1 station que já não existe" : `Fora de ${gone} stations que já não existem`);
    }
  }
  return parts.join(" · ");
}
