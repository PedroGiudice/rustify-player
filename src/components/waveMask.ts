// src/components/waveMask.ts — desenha as barras do perfil (lib/waveProfile)
// como máscara alfa num data URL. O seek aplica a mesma máscara em duas
// camadas de cor (resto e tocado), então tema e hover mudam a cor por CSS,
// sem redesenhar.
import { waveBars } from "../lib/waveProfile";

export const BAR_W = 2;
export const BAR_GAP = 1;

export function makeWaveMask(profile: ArrayLike<number>, width: number, height: number, dpr = 1): string | null {
  if (width <= 0 || height <= 0) return null;
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * dpr);
  canvas.height = Math.round(height * dpr);
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  const step = BAR_W + BAR_GAP;
  const bars = waveBars(profile, Math.max(1, Math.floor((width + BAR_GAP) / step)));
  ctx.scale(dpr, dpr);
  ctx.fillStyle = "#000";
  const mid = height / 2;
  bars.forEach((h, i) => {
    const bh = Math.max(1, h * height);
    ctx.fillRect(i * step, mid - bh / 2, BAR_W, bh);
  });
  return canvas.toDataURL("image/png");
}
