import { describe, it, expect } from "vitest";
import { levelsFromPayload } from "./levels";
import type { FftPayload } from "../tauri";

const base: FftPayload = {
  stream_time_ms: 0, magnitudes: [], low_band_mag: 0, mid_band_mag: 0, high_band_mag: 0,
  rms_energy: 0.3, sample_rate: 48000,
};

describe("níveis a partir do evento de áudio", () => {
  it("usa os níveis por canal quando o backend manda", () => {
    expect(levelsFromPayload({ ...base, level_l_rms: 0.2, level_r_rms: 0.4, level_l_peak: 0.5, level_r_peak: 0.9 }))
      .toEqual({ rms: [0.2, 0.4], peak: [0.5, 0.9] });
  });
  it("backend antigo: cai no rms_energy mono nos dois canais", () => {
    expect(levelsFromPayload(base)).toEqual({ rms: [0.3, 0.3], peak: [0.3, 0.3] });
  });
});
