/** Rótulo de qualidade do player (barra, selo da capa, ficha do Now Playing).

    O "24/44" vem do motor de áudio e descreve o ARQUIVO; um FLAC 24 bit pode
    ser MP3 por dentro. Quando a faixa tem a qualidade medida no conteúdo
    (corte espectral do indexador, `spectral.rs`), o rótulo mostra o que se
    ouve, e o title explica em uma frase. Faixa ainda não medida: o rótulo do
    arquivo, como sempre, e o ponto da barra fica neutro (`unmeasured`). */

import type { QualityClass } from "../tauri";

export interface MeasuredQuality {
  quality_class?: QualityClass | null;
  quality_cutoff_hz?: number | null;
}

interface Tech {
  format: string;
  bitDepth: number | null;
  sampleRate: number | null;
}

export interface QualityBadge {
  label: string;
  /** Conteúdo com perda: quem desenha pode atenuar o rótulo. */
  lossy: boolean;
  /** Frase de "por que o rótulo não é o do arquivo": só quando a medição
      contradiz o arquivo (lossy ou CD convertido). A ficha do Now Playing
      usa a presença dela para trocar o "24-bit" pelo rótulo medido. */
  title: string | null;
  /** Medido no conteúdo e sem corte de lossy: o único caso do ponto verde. */
  verified: boolean;
  /** Nunca medido (ou medição indeterminada): ponto neutro, sem promessa. */
  unmeasured: boolean;
  /** Dica da pílula da barra, sempre presente. */
  hint: string;
}

/** 16075 -> "16,1" */
function khz(hz: number): string {
  return (hz / 1000).toFixed(1).replace(".", ",");
}

/** O arquivo por extenso, para title/aria-label: "FLAC 24 bits, 96 kHz". */
export function describeFile(tech: Tech): string {
  const parts: string[] = [];
  if (tech.bitDepth) parts.push(`${tech.bitDepth} bits`);
  if (tech.sampleRate) parts.push(`${khz(tech.sampleRate).replace(/,0$/, "")} kHz`);
  return parts.length ? `${tech.format} ${parts.join(", ")}` : tech.format;
}

export function qualityBadge(tech: Tech, q: MeasuredQuality | null | undefined): QualityBadge {
  const spec = tech.bitDepth && tech.sampleRate ? `${tech.bitDepth}/${Math.round(tech.sampleRate / 1000)}` : null;
  const file = spec ? `${tech.format} ${spec}` : tech.format;
  const cls = q?.quality_class;
  const cut = q?.quality_cutoff_hz;
  if ((cls === "lossy" || cls === "provavel_lossy") && cut) {
    const title = `O arquivo é ${file}, mas o som tem corte em ${khz(cut)} kHz: veio de MP3 ou AAC.`;
    return { label: `Lossy ${khz(cut)} kHz`, lossy: true, title, verified: false, unmeasured: false, hint: title };
  }
  if (cls === "hires_de_cd" && cut && spec) {
    const title = `O arquivo é ${spec}, mas o som para em ${khz(cut)} kHz: é áudio de CD convertido.`;
    return { label: `CD em ${spec}`, lossy: false, title, verified: false, unmeasured: false, hint: title };
  }
  if (cls === "sem_corte") {
    return {
      label: file, lossy: false, title: null, verified: true, unmeasured: false,
      hint: "Medido no conteúdo: sem corte de lossy.",
    };
  }
  // Ausente, "indeterminado" (a medição falhou) ou classe sem o corte.
  return {
    label: file, lossy: false, title: null, verified: false, unmeasured: true,
    hint: "Qualidade ainda não medida.",
  };
}
