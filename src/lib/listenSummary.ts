/* lib/listenSummary.ts — escuta viva e qualidade medida onde se navega
   (B11, cabeçalho de Álbum e Artista).

   A escuta vem de `lib_listen_stats` (play_events pelo cache do motor),
   nunca do `play_count`/`last_played` fóssil do Track. A qualidade é a do
   corte espectral (o mesmo que o selo da barra usa): faixa sem medição
   fica em "sem medição", nunca entra na conta das limpas. */

import type { ListenStats, QualitySummary } from "../tauri";

const vezes = (n: number) => (n === 1 ? "1 vez" : `${n} vezes`);

/** "hoje", "ontem", "há 3 dias", "há 2 semanas", "há 2 meses", "há 2 anos"
    (unix s; `now` em ms). Por dia do calendário local. */
export function ago(ts: number, now: number = Date.now()): string {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(new Date(now)) - day(new Date(ts * 1000))) / 86_400_000);
  if (days <= 0) return "hoje";
  if (days === 1) return "ontem";
  if (days < 14) return `há ${days} dias`;
  if (days < 60) return `há ${Math.floor(days / 7)} semanas`;
  if (days < 730) return `há ${Math.floor(days / 30)} meses`;
  return `há ${Math.floor(days / 365)} anos`;
}

/** "ouvido até o fim 12 vezes · última há 3 dias". null enquanto o índice
    do motor monta (a escuta viria zerada e mentiria). */
export function listenLine(s: ListenStats, now: number = Date.now()): string | null {
  if (!s.familiarity_ready) return null;
  const last = s.last_played_at ? ` · última ${ago(s.last_played_at, now)}` : "";
  if (s.full_listens > 0) return `ouvido até o fim ${vezes(s.full_listens)}${last}`;
  if (s.plays > 0) return `tocado ${vezes(s.plays)}, nunca até o fim${last}`;
  return "nunca tocado";
}

export interface QualityPart {
  n: number;
  label: string;
  /** Ponto do selo de qualidade: verde (medido, sem corte de lossy), âmbar
      (lossy por dentro) ou neutro (sem medição). */
  tone: "ok" | "lossy" | "none";
  title?: string;
}

const khz = (hz: number) => (hz / 1000).toFixed(1).replace(".", ",");

/** "12 sem corte · 2 CD convertido · 1 lossy · 3 sem medição". */
export function qualityParts(q: QualitySummary): QualityPart[] {
  const out: QualityPart[] = [];
  if (q.sem_corte > 0) out.push({ n: q.sem_corte, label: `${q.sem_corte} sem corte`, tone: "ok" });
  if (q.hires_de_cd > 0) out.push({ n: q.hires_de_cd, label: `${q.hires_de_cd} CD convertido`, tone: "ok" });
  const lossy = q.lossy + q.provavel_lossy;
  if (lossy > 0) {
    out.push({
      n: lossy,
      label: `${lossy} lossy`,
      tone: "lossy",
      title: q.lowest_cutoff_hz
        ? `Corte de MP3 ou AAC; o menor em ${khz(q.lowest_cutoff_hz)} kHz`
        : "Corte de MP3 ou AAC",
    });
  }
  if (q.unmeasured > 0) out.push({ n: q.unmeasured, label: `${q.unmeasured} sem medição`, tone: "none" });
  return out;
}
