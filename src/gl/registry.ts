/* ============================================================
   gl/registry.ts — registro único das cenas: chave -> SceneDef.

   O motor (gl/engine.ts) resolve a cena por aqui; desktop
   (components/GlBackground.tsx) e mobile (mobile/bg/GlBg.tsx)
   usam o mesmo motor e, portanto, o mesmo registro. O bench
   offscreen (scripts/gl-bench) também.

   Record<SceneKey, SceneDef>: cena listada em gl/meta.ts sem
   entrada aqui (ou o contrário) não compila. NÃO importar este
   módulo do store nem dos painéis — ele puxa o código das cenas.
   ============================================================ */

import type { SceneKey } from "./meta";
import type { SceneDef } from "./scene";
import { dust } from "./scenes/dust";
import { relief } from "./scenes/relief";
import { orbits } from "./scenes/orbits";
import { nebula } from "./scenes/nebula";

export const SCENES: Readonly<Record<SceneKey, SceneDef>> = {
  dust,
  relief,
  orbits,
  nebula,
};
