/* ============================================================
   icons-offline.ts — Registro OFFLINE dos ícones Iconify.

   Substitui a CDN (code.iconify.design / api.iconify.design): o app
   desktop roda em máquina sem internet garantida, e qualquer dependência
   de CDN deixava TODOS os <iconify-icon> invisíveis quando a rede caía.

   Importado pelo entry (main.tsx) ANTES do primeiro render. Registra o
   custom element <iconify-icon> + a coleção lucide inteira (com aliases,
   ex: more-horizontal -> ellipsis) + o único ícone ph usado (heart-fill),
   hardcoded para não bundlar a coleção ph inteira (~4 MB).
   ============================================================ */

import "iconify-icon"; // registra o custom element <iconify-icon>
import { addCollection, addIcon } from "iconify-icon";
import lucide from "@iconify-json/lucide/icons.json";

addCollection(lucide as Parameters<typeof addCollection>[0]);

// ph:heart-fill (ICONS.heartFilled) — único ícone fora do lucide.
addIcon("ph:heart-fill", {
  body: '<path fill="currentColor" d="M240 102c0 70-103.79 126.66-108.21 129a8 8 0 0 1-7.58 0C119.79 228.66 16 172 16 102a62.07 62.07 0 0 1 62-62c20.65 0 38.73 8.88 50 23.89C139.27 48.88 157.35 40 178 40a62.07 62.07 0 0 1 62 62"/>',
  width: 256,
  height: 256,
});
