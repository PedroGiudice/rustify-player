/* ============================================================
   StationViz.tsx — Canvas usado na feature card de Stations.
   Visualiza 3 seed dots azuis pulsando + 28 generated dots cinza
   conectados por hairlines ao seed mais proximo. Hairline dot grid
   ao fundo. 60fps via requestAnimationFrame.
   ============================================================ */

import { Component, createMemo, onCleanup, onMount } from "solid-js";

export interface StationVizProps {
  seedCount?: number;
  genCount?: number;
}

interface Seed { x: number; y: number; }
interface Gen { x: number; y: number; r: number; }

// Posicoes fixas dos seeds — replica do HTML referencia.
// Coordenadas relativas (0..1) no espaco do canvas.
const DEFAULT_SEEDS: Seed[] = [
  { x: 0.28, y: 0.42 },
  { x: 0.62, y: 0.36 },
  { x: 0.48, y: 0.68 },
];

// Gera generated dots determinanticamente em torno dos seeds.
// Math.random() so e chamado no client — em testes jsdom devolve mesmo
// padrao, mas nao garantimos determinismo cross-run (visual; nao importa).
function makeGenerated(seeds: Seed[], count: number): Gen[] {
  const out: Gen[] = [];
  for (let i = 0; i < count; i++) {
    const s = seeds[i % seeds.length];
    const r = 0.06 + Math.random() * 0.18;
    const theta = Math.random() * Math.PI * 2;
    out.push({
      x: s.x + Math.cos(theta) * r,
      y: s.y + Math.sin(theta) * r,
      r: 1.4 + Math.random() * 1.6,
    });
  }
  return out;
}

export const StationViz: Component<StationVizProps> = (props) => {
  let canvasEl!: HTMLCanvasElement;
  let raf: number | null = null;
  const t0 = typeof performance !== "undefined" ? performance.now() : Date.now();

  // Derivacao reativa de verdade: mudar props.seedCount/genCount pos-mount
  // regenera os pontos (o loop de RAF le os memos a cada frame).
  const seedCount = () => props.seedCount ?? DEFAULT_SEEDS.length;
  const genCount = () => props.genCount ?? 28;

  const seeds = createMemo<Seed[]>(() => {
    const out = DEFAULT_SEEDS.slice(0, seedCount());
    // Se seedCount > defaults, padding com seed central.
    while (out.length < seedCount()) out.push({ x: 0.5, y: 0.5 });
    return out;
  });

  const generated = createMemo<Gen[]>(() => makeGenerated(seeds(), genCount()));

  function draw() {
    const ctx = canvasEl.getContext("2d");
    if (!ctx) return;
    const r = canvasEl.getBoundingClientRect();
    if (!r.width || !r.height) return;

    const dpr = Math.min((typeof window !== "undefined" ? window.devicePixelRatio : 1) || 1, 2);
    canvasEl.width = Math.round(r.width * dpr);
    canvasEl.height = Math.round(r.height * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const w = r.width;
    const h = r.height;
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    const t = (now - t0) * 0.001;

    ctx.clearRect(0, 0, w, h);

    // Snapshot dos memos pro frame corrente (leitura fora de escopo
    // reativo e ok — memo devolve o valor atualizado).
    const sds = seeds();
    const gens = generated();

    // Hairline dot grid
    ctx.fillStyle = "rgba(0,0,0,0.05)";
    const step = 14;
    for (let yy = step / 2; yy < h; yy += step) {
      for (let xx = step / 2; xx < w; xx += step) {
        ctx.fillRect(xx, yy, 1, 1);
      }
    }

    // Hairlines connecting generated -> nearest seed
    ctx.strokeStyle = "rgba(0,0,0,0.06)";
    ctx.lineWidth = 1;
    for (const g of gens) {
      let best = sds[0];
      let bestD = Infinity;
      for (const s of sds) {
        const d = Math.hypot(s.x - g.x, s.y - g.y);
        if (d < bestD) { bestD = d; best = s; }
      }
      ctx.beginPath();
      ctx.moveTo(g.x * w, g.y * h);
      ctx.lineTo(best.x * w, best.y * h);
      ctx.stroke();
    }

    // Generated dots (carbono dim)
    ctx.fillStyle = "rgba(23,23,23,0.45)";
    for (const g of gens) {
      ctx.beginPath();
      ctx.arc(g.x * w, g.y * h, g.r, 0, Math.PI * 2);
      ctx.fill();
    }

    // Seeds com halo pulsante azul
    sds.forEach((s, i) => {
      const pulse = 0.5 + 0.5 * Math.sin(t * 1.4 + i * 1.3);
      // Halo
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, 14 + pulse * 6, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(59,130,246,${0.06 + pulse * 0.04})`;
      ctx.fill();
      // Core
      ctx.beginPath();
      ctx.arc(s.x * w, s.y * h, 4.5, 0, Math.PI * 2);
      ctx.fillStyle = "rgba(37,99,235,1)";
      ctx.fill();
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
  }

  function tick() {
    draw();
    raf = requestAnimationFrame(tick);
  }

  onMount(() => {
    draw();
    raf = requestAnimationFrame(tick);
  });

  onCleanup(() => {
    if (raf !== null) {
      cancelAnimationFrame(raf);
      raf = null;
    }
  });

  // So o <canvas>: a moldura .st-feature__visual e responsabilidade do
  // call site (LazyStationViz em Stations.tsx) — antes havia div duplicado
  // aninhado com a mesma classe (borda/bg/radius renderizados duas vezes).
  return <canvas ref={canvasEl} aria-hidden="true" />;
};
