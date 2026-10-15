import { describe, expect, it } from "vitest";
import { qualityBadge } from "./quality";

const tech = (bitDepth: number | null, sampleRate: number | null) => ({ format: "FLAC", bitDepth, sampleRate });

describe("qualityBadge", () => {
  it("lossless medido ou ainda não medido mostra o formato do arquivo", () => {
    expect(qualityBadge(tech(16, 44100), { quality_class: "sem_corte", quality_cutoff_hz: null })).toEqual({ label: "FLAC 16/44", lossy: false, title: null });
    expect(qualityBadge(tech(24, 96000), null)).toEqual({ label: "FLAC 24/96", lossy: false, title: null });
    expect(qualityBadge(tech(null, null), {}).label).toBe("FLAC");
  });

  it("MP3 disfarçado de FLAC troca o 24/44 pelo corte medido", () => {
    const b = qualityBadge(tech(24, 44100), { quality_class: "lossy", quality_cutoff_hz: 16075 });
    expect(b.label).toBe("Lossy 16,1 kHz");
    expect(b.lossy).toBe(true);
    expect(b.title).toBe("O arquivo é FLAC 24/44, mas o som tem corte em 16,1 kHz: veio de MP3 ou AAC.");
  });

  it("provável lossy também mostra o corte", () => {
    const b = qualityBadge(tech(16, 44100), { quality_class: "provavel_lossy", quality_cutoff_hz: 20155 });
    expect(b.label).toBe("Lossy 20,2 kHz");
    expect(b.lossy).toBe(true);
  });

  it("hi-res que é upsample de CD diz isso", () => {
    const b = qualityBadge(tech(24, 96000), { quality_class: "hires_de_cd", quality_cutoff_hz: 21879 });
    expect(b.label).toBe("CD em 24/96");
    expect(b.lossy).toBe(false);
    expect(b.title).toBe("O arquivo é 24/96, mas o som para em 21,9 kHz: é áudio de CD convertido.");
  });
});
