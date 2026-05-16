/* ============================================================
   shapes.ts — Spectrum shape functions (Now Playing background).

   Each shape maps (u, v, t) ∈ [0,1]² × seconds → amplitude ∈ [0,1].
   Same 7 shapes from SpectrumBackground_V2.tsx — kept identical so
   the visual identity carries over to the redesign.
   ============================================================ */

export interface Shape {
  name: string;
  fn: (u: number, v: number, t: number) => number;
}

export const SHAPES: Shape[] = [
  {
    name: "cordillera",
    fn: (u, v, t) => {
      const cx = 0.5 + Math.sin(t * 0.18) * 0.04;
      const du = u - cx, dv = v - 0.5;
      return Math.exp(-(du * du * 26 + dv * dv * 1.6));
    },
  },
  {
    name: "nebula",
    fn: (u, v, t) => {
      const cx = 0.5 + Math.sin(t * 0.13) * 0.07;
      const cy = 0.5 + Math.cos(t * 0.10) * 0.04;
      const du = u - cx, dv = v - cy;
      return Math.exp(-(du * du * 5 + dv * dv * 4));
    },
  },
  {
    name: "horizon",
    fn: (u, v, t) => {
      const dv = v - 0.5;
      const ripple = 0.7 + 0.3 * Math.sin(u * Math.PI * 4 + t * 0.4);
      return Math.exp(-(dv * dv * 12)) * ripple;
    },
  },
  {
    name: "twin peaks",
    fn: (u, v, t) => {
      const dv = v - 0.5;
      const drift = Math.sin(t * 0.22) * 0.025;
      const a = u - (0.34 + drift);
      const b = u - (0.66 - drift);
      return Math.max(
        Math.exp(-(a * a * 52 + dv * dv * 2.0)),
        Math.exp(-(b * b * 52 + dv * dv * 2.0)),
      );
    },
  },
  {
    name: "vortex",
    fn: (u, v, t) => {
      const du = u - 0.5, dv = v - 0.5;
      const r = Math.sqrt(du * du + dv * dv);
      const theta = Math.atan2(dv, du);
      const spiral = Math.sin(theta * 3 + r * 16 - t * 1.0);
      return Math.exp(-r * r * 5) * (0.55 + 0.45 * spiral);
    },
  },
  {
    name: "ember",
    fn: (u, v, t) => {
      const cx = 0.5 + Math.sin(t * 0.4) * 0.025;
      const widthK = 6 + v * 22;
      const du = u - cx;
      const env = Math.exp(-Math.pow(v - 0.62, 2) * 5);
      const flicker = 0.86 + 0.14 * Math.sin(t * 4.5 + v * 9);
      return Math.exp(-du * du * widthK) * env * flicker;
    },
  },
  {
    name: "wavefront",
    fn: (u, v, t) => {
      const angle = (u * 1.6 - v * 0.8) + t * 0.18;
      const wave = Math.sin(angle * Math.PI * 2);
      const env = 1 - Math.abs(v - 0.5) * 1.3;
      return Math.max(0, wave) * Math.max(0, env) * 0.9;
    },
  },
];
