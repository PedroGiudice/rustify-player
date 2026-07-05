/* ============================================================
   shapes.ts — Spectrum shape functions (Now Playing background).

   Each shape maps (u, v, t) ∈ [0,1]² × seconds → amplitude ∈ [0,1].
   18 shapes consumidos pelo SpectrumCanvas (background global).
   Shape = "o quê" (campo escalar); renderers.ts = "como" pintar.
   Valores copiados 1:1 do handoff (docs/design-refs/
   design_handoff_persistent_background) — não reinterpretar.
   ============================================================ */

export type ShapeFn = (u: number, v: number, t: number) => number;

export interface Shape {
  name: string;
  fn: ShapeFn;
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
  // ── família campo/curtain ──────────────────────────────────
  {
    name: "aurora",
    fn: (u, v, t) => {
      const curtain = Math.sin(u * Math.PI * 5 + Math.sin(t * 0.3) * 2);
      const band = Math.exp(-Math.pow(v - 0.42, 2) * 6);
      return band * (0.55 + 0.45 * curtain);
    },
  },
  {
    name: "ripple",
    fn: (u, v, t) => {
      const cx = 0.5 + Math.sin(t * 0.25) * 0.12;
      const cy = 0.5 + Math.cos(t * 0.20) * 0.08;
      const r = Math.sqrt((u - cx) * (u - cx) + (v - cy) * (v - cy));
      return Math.exp(-r * r * 4) * (0.5 + 0.5 * Math.sin(r * 34 - t * 2.2));
    },
  },
  {
    name: "dunes",
    fn: (u, v, t) => {
      const ridge = Math.sin(u * Math.PI * 2.2 + t * 0.2) * 0.12;
      const dv = v - (0.55 + ridge);
      return Math.exp(-dv * dv * 22) + 0.35 * Math.exp(-Math.pow(v - 0.3 - ridge * 0.5, 2) * 30);
    },
  },
  {
    name: "lattice",
    fn: (u, v, t) => {
      const a = Math.sin(u * Math.PI * 6 + t * 0.4);
      const b = Math.sin(v * Math.PI * 6 - t * 0.3);
      return Math.max(0, a * b) * 0.9;
    },
  },
  {
    name: "comet",
    fn: (u, v, t) => {
      const cx = (t * 0.16) % 1.3 - 0.15;
      const cy = 0.5 + Math.sin(t * 0.5) * 0.12;
      const du = u - cx, dv = v - cy;
      const tail = du > 0 ? Math.exp(-du * 5) : Math.exp(du * 40);
      return Math.exp(-dv * dv * 40) * tail;
    },
  },
  {
    name: "tide",
    fn: (u, v, t) => {
      const level = 0.5 + Math.sin(t * 0.3) * 0.18;
      const swell = Math.sin(u * Math.PI * 3 + t * 0.6) * 0.04;
      const dv = v - (level + swell);
      return Math.exp(-dv * dv * 10);
    },
  },
  // ── família radial / propagante (no espírito da "ripple") ──
  {
    name: "sonar",
    fn: (u, v, t) => {
      const r = Math.sqrt((u - 0.5) * (u - 0.5) + (v - 0.5) * (v - 0.5));
      const ph = (t * 0.35) % 1;              // raio do anel: cresce 0→1 e reseta
      const ring = Math.exp(-Math.pow((r - ph * 0.9) * 10, 2));
      return ring * (1 - ph);                 // desbota conforme expande
    },
  },
  {
    name: "pond",
    fn: (u, v, t) => {
      const s1x = 0.35 + Math.sin(t * 0.20) * 0.05, s1y = 0.40;
      const s2x = 0.65, s2y = 0.60 + Math.cos(t * 0.17) * 0.05;
      const r1 = Math.sqrt((u - s1x) * (u - s1x) + (v - s1y) * (v - s1y));
      const r2 = Math.sqrt((u - s2x) * (u - s2x) + (v - s2y) * (v - s2y));
      const w1 = Math.exp(-r1 * r1 * 3) * Math.sin(r1 * 40 - t * 2.4);
      const w2 = Math.exp(-r2 * r2 * 3) * Math.sin(r2 * 40 - t * 2.0);
      return Math.max(0, w1 + w2);            // duas gotas interferindo
    },
  },
  {
    name: "whirlpool",
    fn: (u, v, t) => {
      const du = u - 0.5, dv = v - 0.5;
      const r = Math.sqrt(du * du + dv * dv);
      const th = Math.atan2(dv, du);
      const wave = Math.sin(r * 30 - t * 2.0 + th * 2);
      return Math.exp(-r * r * 4) * (0.5 + 0.5 * wave);
    },
  },
  {
    name: "shock",
    fn: (u, v, t) => {
      const r = Math.sqrt((u - 0.5) * (u - 0.5) + (v - 0.5) * (v - 0.5));
      const ph = (t * 0.5) % 1.1;             // anel fino, nítido, em loop
      return Math.exp(-Math.pow((r - ph * 0.8) * 22, 2));
    },
  },
  {
    name: "radar",
    fn: (u, v, t) => {
      const du = u - 0.5, dv = v - 0.5;
      const r = Math.sqrt(du * du + dv * dv);
      let th = Math.atan2(dv, du) - t * 0.8;  // feixe girando
      th = ((th % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const beam = th > Math.PI ? 2 * Math.PI - th : th;
      const sweep = Math.exp(-beam * beam * 3);
      return Math.exp(-r * r * 3) * (0.15 + 0.85 * sweep);
    },
  },
];
