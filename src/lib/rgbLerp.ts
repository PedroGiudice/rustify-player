/* ============================================================
   lib/rgbLerp.ts — lerp exponencial de cor pros canvases.

   Por que existe: a interpolação de cor NÃO pode vir de transition
   CSS em custom property registrada no :root. Animar uma prop
   herdada no root força restyle da árvore inteira POR FRAME no
   WebKitGTK — medido no app real (2026-07-17): 60fps -> 29fps
   durante os 480ms da transition, com stall de até 382ms. A var
   salta pro alvo; quem quer suavidade faz lerp local por frame.

   Modelo: convergência exponencial frame-rate-independent
   (k = 1 - e^(-dt/tau)) — o mesmo do SpectrumCanvas. Muta `cur`
   in-place de propósito: roda por frame, sem alocação.
   ============================================================ */

export type Rgb = { r: number; g: number; b: number };

/** Avança `cur` na direção de `tgt` pela fração exponencial de `dt`
    (segundos) com constante de tempo `tau` (segundos). */
export function stepRgbLerp(cur: Rgb, tgt: Rgb, dt: number, tau: number): void {
  if (dt <= 0 || tau <= 0) return;
  const k = 1 - Math.exp(-dt / tau);
  cur.r += (tgt.r - cur.r) * k;
  cur.g += (tgt.g - cur.g) * k;
  cur.b += (tgt.b - cur.b) * k;
}
