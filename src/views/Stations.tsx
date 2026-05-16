/* ============================================================
   views/Stations.tsx — Mood/seed-driven radio stations.
   Static set for v1; backend hook ready for libGetStations().
   ============================================================ */

import { For } from "solid-js";
import { CoverArt } from "../components/CoverArt";
import { Icon, ICONS } from "../components/Icon";

// MOCK: lib_get_stations não existe no backend — dataset estático até ser implementado.
const STATIONS = [
  { name: "Midnight",     desc: "ambient · drone · sleepless", seed: "midnight" },
  { name: "Sunday Slow",  desc: "modern classical · acoustic", seed: "sunday-slow" },
  { name: "Bridge Cable", desc: "field recording · industrial",seed: "bridge-cable" },
  { name: "Solstice",     desc: "winter strings · cold piano", seed: "solstice" },
  { name: "Pylon",        desc: "minimal electronic",          seed: "pylon" },
  { name: "Halocline",    desc: "deep ambient · brackish",     seed: "halocline" },
];

export default function Stations() {
  return (
    <article class="view">
      <header class="view__head">
        <div>
          <h1>Stations</h1>
          <p class="view__head-hint">Geradas a partir das suas seeds.</p>
        </div>
      </header>

      <div class="view__body">
        <div class="card-grid">
          <For each={STATIONS}>
            {(s) => (
              <div class="card">
                <CoverArt seed={s.seed} size="md" class="card__cover">
                  <button class="card__play" type="button"><Icon name={ICONS.play} size={12} /></button>
                </CoverArt>
                <div class="card__title">{s.name}</div>
                <div class="card__sub">{s.desc}</div>
              </div>
            )}
          </For>
        </div>
      </div>
    </article>
  );
}
