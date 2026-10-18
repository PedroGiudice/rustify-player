/* ============================================================
   gl/glyphAtlas.ts — alfabeto asêmico da cena Lorem, rasterizado na
   CPU (sem fonte, sem Canvas 2D).

   "Lorem ipsum" de verdade seria texto; o pedido do CEO (18/10) é
   algo que LEIA como texto sem dizer nada. Cada glifo é montado de
   2 a 4 traços de um vocabulário de escrita latina (haste, bojo,
   arco, barra, diagonal, ponto) em posições sorteadas, com
   ascendente/descendente como letras minúsculas. Nenhum é uma letra
   de verdade; o conjunto parece um parágrafo de uma língua que não
   existe.

   Sai um bitmap R8 (ATLAS_W x ATLAS_H, GLYPH_COUNT células de
   GLYPH_W x GLYPH_H em grade ATLAS_COLS por linha) que a cena sobe
   como textura. Rasterização por distância ao traço (antisserrilhado
   de 1 px), determinística pela semente: o mesmo atlas em toda
   sessão e nos testes. Sem Canvas 2D de propósito: o jsdom dos
   testes não o tem, e o app não precisa de fonte para isto.
   ============================================================ */

export const GLYPH_W = 12;
export const GLYPH_H = 18;
export const GLYPH_COUNT = 64;
export const ATLAS_COLS = 8;
export const ATLAS_ROWS = GLYPH_COUNT / ATLAS_COLS;
export const ATLAS_W = GLYPH_W * ATLAS_COLS;
export const ATLAS_H = GLYPH_H * ATLAS_ROWS;

/** Meia espessura do traço + 1 px de antisserrilhado. */
const STROKE = 0.75;

/** Linhas tipográficas dentro da célula (y cresce para baixo). */
const ASC = 2.5;   // topo da ascendente
const XTOP = 7;    // altura de x
const BASE = 14;   // linha de base
const DESC = 17;   // fim da descendente
const LEFT = 3;
const RIGHT = 9;
const MID = 6;

type Seg = { k: "seg"; x0: number; y0: number; x1: number; y1: number };
type Arc = { k: "arc"; cx: number; cy: number; r: number; a0: number; a1: number };
type Stroke = Seg | Arc;

/** mulberry32: gerador pequeno e determinístico. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const seg = (x0: number, y0: number, x1: number, y1: number): Seg => ({ k: "seg", x0, y0, x1, y1 });
const arc = (cx: number, cy: number, r: number, a0: number, a1: number): Arc => ({ k: "arc", cx, cy, r, a0, a1 });

/** Traços de um glifo: corpo sorteado + enfeites. Exportado para o teste
    travar a gramática (todo glifo tem de 2 a 5 traços dentro da célula). */
export function glyphStrokes(rnd: () => number): Stroke[] {
  const s: Stroke[] = [];
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
  const top = pick([ASC, XTOP, XTOP]);
  const bottom = pick([BASE, BASE, DESC]);
  const body = Math.floor(rnd() * 5);
  const bowlR = (RIGHT - LEFT) / 2;
  const bowlCy = (XTOP + BASE) / 2;
  if (body === 0) {
    // haste + bojo (b, d, p, q)
    const x = pick([LEFT, RIGHT]);
    s.push(seg(x, top, x, bottom));
    const a0 = x === LEFT ? -Math.PI / 2 : Math.PI / 2;
    s.push(arc(MID, bowlCy, bowlR, a0, a0 + Math.PI * pick([1, 1.5])));
  } else if (body === 1) {
    // redondo com abertura (o, c, e)
    const gap = rnd() * Math.PI * 2;
    s.push(arc(MID, bowlCy, bowlR, gap + 0.6, gap + Math.PI * 2 - 0.6));
    if (rnd() < 0.5) s.push(seg(LEFT + 0.5, bowlCy, RIGHT - 0.5, bowlCy));
  } else if (body === 2) {
    // haste + arco + segunda haste (n, h, u)
    const up = rnd() < 0.5;
    s.push(seg(LEFT, up ? top : XTOP, LEFT, up ? BASE : bottom));
    s.push(seg(RIGHT, XTOP, RIGHT, up ? bottom : BASE));
    s.push(up ? arc(MID, XTOP + bowlR, bowlR, Math.PI, Math.PI * 2) : arc(MID, BASE - bowlR, bowlR, 0, Math.PI));
  } else if (body === 3) {
    // angular (v, x, z, k)
    const kind = Math.floor(rnd() * 3);
    if (kind === 0) s.push(seg(LEFT, XTOP, MID, BASE), seg(MID, BASE, RIGHT, XTOP));
    else if (kind === 1) s.push(seg(LEFT, XTOP, RIGHT, BASE), seg(RIGHT, XTOP, LEFT, BASE));
    else s.push(seg(LEFT, XTOP, RIGHT, XTOP), seg(RIGHT, XTOP, LEFT, BASE), seg(LEFT, BASE, RIGHT, BASE));
  } else {
    // haste + ramo (r, t, f, l)
    const x = pick([LEFT, MID]);
    s.push(seg(x, top, x, bottom));
    const y = pick([XTOP, (XTOP + BASE) / 2]);
    s.push(seg(x, y, x + pick([2.5, 3.5]), y - pick([0, 1.5])));
  }
  // enfeites: ponto, barra, gancho
  if (rnd() < 0.25) s.push(seg(MID, ASC + 1, MID, ASC + 1.01));
  if (rnd() < 0.2) s.push(seg(LEFT, XTOP - 1, RIGHT, XTOP - 1));
  if (rnd() < 0.2) s.push(arc(RIGHT - 1.5, bottom - 1.5, 1.5, 0, Math.PI / 2 + 0.6));
  return s;
}

function distSeg(px: number, py: number, s: Seg): number {
  const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - s.x0) * dx + (py - s.y0) * dy) / l2 : 0;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const ex = s.x0 + t * dx - px, ey = s.y0 + t * dy - py;
  return Math.sqrt(ex * ex + ey * ey);
}

function distArc(px: number, py: number, a: Arc): number {
  const dx = px - a.cx, dy = py - a.cy;
  const ang = Math.atan2(dy, dx);
  const span = a.a1 - a.a0;
  let rel = ang - a.a0;
  rel = rel - Math.floor(rel / (Math.PI * 2)) * Math.PI * 2;
  if (rel <= span) return Math.abs(Math.sqrt(dx * dx + dy * dy) - a.r);
  // fora do arco: distância ao ponto final mais perto
  const e0x = a.cx + a.r * Math.cos(a.a0), e0y = a.cy + a.r * Math.sin(a.a0);
  const e1x = a.cx + a.r * Math.cos(a.a1), e1y = a.cy + a.r * Math.sin(a.a1);
  const d0 = Math.hypot(px - e0x, py - e0y), d1 = Math.hypot(px - e1x, py - e1y);
  return Math.min(d0, d1);
}

/** Rasteriza um glifo na célula (cx, cy) do atlas. */
function raster(out: Uint8Array, strokes: Stroke[], col: number, row: number): void {
  for (let y = 0; y < GLYPH_H; y++) {
    for (let x = 0; x < GLYPH_W; x++) {
      const px = x + 0.5, py = y + 0.5;
      let d = 1e9;
      for (const s of strokes) {
        const v = s.k === "seg" ? distSeg(px, py, s) : distArc(px, py, s);
        if (v < d) d = v;
      }
      let cov = STROKE + 0.5 - d;
      cov = cov < 0 ? 0 : cov > 1 ? 1 : cov;
      out[(row * GLYPH_H + y) * ATLAS_W + col * GLYPH_W + x] = Math.round(cov * 255);
    }
  }
}

/** O atlas inteiro, R8, GLYPH_COUNT glifos. Mesma semente = mesmos bytes. */
export function makeGlyphAtlas(seed = 0x1707): Uint8Array {
  const out = new Uint8Array(ATLAS_W * ATLAS_H);
  const rnd = rng(seed);
  for (let i = 0; i < GLYPH_COUNT; i++) {
    raster(out, glyphStrokes(rnd), i % ATLAS_COLS, Math.floor(i / ATLAS_COLS));
  }
  return out;
}

/** Cobertura média de um glifo (0..1): o teste exige tinta em todos. */
export function glyphInk(atlas: Uint8Array, i: number): number {
  const col = i % ATLAS_COLS, row = Math.floor(i / ATLAS_COLS);
  let sum = 0;
  for (let y = 0; y < GLYPH_H; y++) {
    for (let x = 0; x < GLYPH_W; x++) sum += atlas[(row * GLYPH_H + y) * ATLAS_W + col * GLYPH_W + x];
  }
  return sum / (GLYPH_W * GLYPH_H * 255);
}
