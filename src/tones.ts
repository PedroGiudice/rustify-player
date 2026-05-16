/* ============================================================
   tones.ts — Hash deterministico de string -> pastel tone.
   Cada album/artist sempre cai no mesmo tone, sem coordenação
   externa.

   Tones disponiveis (do design system Extractor Lab):
     lavender · mint · peach · sky · rose · butter · paper · bone

   Glyphs disponiveis para a cover-art hairline central:
     target · grid-3x3 · spiral · rows-3 · mountain · atom
     audio-lines · waves · diamond · plus · rainbow · dots-nine
   ============================================================ */

export type Tone =
  | "lavender" | "mint" | "peach" | "sky"
  | "rose"     | "butter" | "paper" | "bone";

export type Glyph =
  | "rings" | "grid" | "spiral" | "stack"
  | "mountain" | "orbit" | "bars" | "wave"
  | "diamond" | "cross" | "arc" | "dot-grid";

const TONES: Tone[] = [
  "lavender", "mint", "peach", "sky",
  "rose", "butter", "paper", "bone",
];

const GLYPHS: Glyph[] = [
  "rings", "grid", "spiral", "stack",
  "mountain", "orbit", "bars", "wave",
  "diamond", "cross", "arc", "dot-grid",
];

const GLYPH_ICONS: Record<Glyph, string> = {
  "rings":    "lucide:target",
  "grid":     "lucide:grid-3x3",
  "spiral":   "ph:spiral",
  "stack":    "lucide:rows-3",
  "mountain": "lucide:mountain",
  "orbit":    "lucide:atom",
  "bars":     "lucide:audio-lines",
  "wave":     "lucide:waves",
  "diamond":  "lucide:diamond",
  "cross":    "lucide:plus",
  "arc":      "lucide:rainbow",
  "dot-grid": "ph:dots-nine",
};

/** djb2-ish 32-bit hash; deterministic and fast. */
function hash32(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}

export function toneFor(seed: string | null | undefined): Tone {
  if (!seed) return "paper";
  return TONES[hash32(seed) % TONES.length];
}

export function glyphFor(seed: string | null | undefined): Glyph {
  if (!seed) return "rings";
  // Mix with prime so tone and glyph don't always correlate
  return GLYPHS[(hash32(seed) * 31) % GLYPHS.length >>> 0];
}

export function glyphIcon(g: Glyph): string {
  return GLYPH_ICONS[g];
}
