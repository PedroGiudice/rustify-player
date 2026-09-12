/* ============================================================
   bg/engine.ts — qual motor desenha o fundo no aparelho.

   Espelha o `bgEngine`/`bgScene` do Tweaks do desktop, com a
   persistência local do mobile (localStorage direto, sem IPC —
   mesmo padrão de beatSetting.ts e das preferências de shape).

   "2d"    = o canvas de sempre (bg/spectrum.ts)
   "webgl" = as quatro cenas de gl/scenes.ts, as mesmas do desktop

   Os dois nunca rodam juntos: MobileApp monta um OU outro.
   ============================================================ */

import { createSignal } from "solid-js";
import { isSceneKey, type SceneKey } from "../../gl/meta";

export type BgEngine = "2d" | "webgl";

const ENGINE_KEY = "rustify-bg-engine-mobile";
const SCENE_KEY = "rustify-bg-scene-mobile";

function loadEngine(): BgEngine {
  try {
    const raw = localStorage.getItem(ENGINE_KEY);
    if (raw === "webgl" || raw === "2d") return raw;
  } catch {
    /* default abaixo */
  }
  return "2d";
}

function loadScene(): SceneKey {
  try {
    const raw = localStorage.getItem(SCENE_KEY);
    if (isSceneKey(raw)) return raw;
  } catch {
    /* default abaixo */
  }
  return "dust";
}

const [bgEngine, setEngineSignal] = createSignal<BgEngine>(loadEngine());
const [bgScene, setSceneSignal] = createSignal<SceneKey>(loadScene());

export { bgEngine, bgScene };

function persist(key: string, val: string) {
  try {
    localStorage.setItem(key, val);
  } catch {
    /* sem persistência é degradação aceitável */
  }
}

export function setBgEngine(e: BgEngine) {
  setEngineSignal(e);
  persist(ENGINE_KEY, e);
}

export function setBgScene(s: SceneKey) {
  setSceneSignal(s);
  persist(SCENE_KEY, s);
}
