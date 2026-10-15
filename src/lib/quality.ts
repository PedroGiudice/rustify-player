/** Rótulo de qualidade do player (barra, selo da capa, ficha do Now Playing).

    O "24/44" vem do motor de áudio e descreve o ARQUIVO; um FLAC 24 bit pode
    ser MP3 por dentro. Quando a faixa tem a qualidade medida no conteúdo
    (corte espectral do indexador, `spectral.rs`), o rótulo mostra o que se
    ouve, e o title explica em uma frase. Faixa ainda não medida: o rótulo do
    arquivo, como sempre. */

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
  title: string | null;
}

/** 16075 -> "16,1" */
function khz(hz: number): string {
  return (hz / 1000).toFixed(1).replace(".", ",");
}

export function qualityBadge(tech: Tech, q: MeasuredQuality | null | undefined): QualityBadge {
  const spec = tech.bitDepth && tech.sampleRate ? `${tech.bitDepth}/${Math.round(tech.sampleRate / 1000)}` : null;
  const file = spec ? `${tech.format} ${spec}` : tech.format;
  const cls = q?.quality_class;
  const cut = q?.quality_cutoff_hz;
  if ((cls === "lossy" || cls === "provavel_lossy") && cut) {
    return {
      label: `Lossy ${khz(cut)} kHz`,
      lossy: true,
      title: `O arquivo é ${file}, mas o som tem corte em ${khz(cut)} kHz: veio de MP3 ou AAC.`,
    };
  }
  if (cls === "hires_de_cd" && cut && spec) {
    return {
      label: `CD em ${spec}`,
      lossy: false,
      title: `O arquivo é ${spec}, mas o som para em ${khz(cut)} kHz: é áudio de CD convertido.`,
    };
  }
  return { label: file, lossy: false, title: null };
}
