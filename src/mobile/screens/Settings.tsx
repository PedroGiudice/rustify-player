/* ============================================================
   Settings.tsx — porte de S.settings do handoff, reduzido ao que
   tem trilho no v0.

   Ficaram: Appearance (renderer + shape do fundo e Beat sync, tudo
   local, como no protótipo) e Library (raiz do acervo, re-scan via
   lib_rescan — que existe — e as contagens reais).

   Saíram, por não existir command nenhum por trás: tema
   claro/escuro e YAML, full-screen player, resume on launch,
   volume, normalização de loudness, embeddings/qdrant, check for
   updates e a tela Signal/EQ. Renderizar esses controles seria
   desenhar botão morto.
   ============================================================ */

import { For, Show } from "solid-js";
import { ViewHead } from "../components/ui";
import { BEAT_MODES, beatMode, setBeatMode } from "../bg/beatSetting";
import { useRenderer, useShape } from "../bg/spectrum";
import { albums, artists, folders, rescan, rescanning, tracks } from "../store";
import { commonRoot, fmtCount } from "../derive";

export function Settings() {
  const root = () => commonRoot(tracks().map((t) => t.path)) ?? "—";
  const stats = () => [
    ["FAIXAS", fmtCount(tracks().length), "indexadas"],
    ["PASTAS", String(folders().length), "playlists"],
    ["ÁLBUNS", String(albums().length), "distintos"],
    ["ARTISTAS", String(artists().length), "distintos"],
  ];

  return (
    <div class="screen">
      <ViewHead title="Settings" sub="fundo, biblioteca e o resto do que existe" />

      <div class="setpanel">
        <div class="setpanel__head">
          <div class="setpanel__title">Appearance</div>
          <span class="setpanel__sub">o fundo persistente do app</span>
        </div>
        <div class="setrow setrow--inline">
          <div>
            <div class="setrow__label">Background render + shape</div>
            <div class="setrow__hint">
              {useRenderer.count} renderers × {useShape.count} shapes sobre o mesmo campo escalar.
            </div>
          </div>
          <div style={{ display: "flex", gap: "8px" }}>
            <button class="selbtn" style={{ width: "auto" }} onClick={() => useRenderer.next()}>
              {useRenderer.name()}
            </button>
            <button class="selbtn" style={{ width: "auto" }} onClick={() => useShape.next()}>
              {useShape.name()}
            </button>
          </div>
        </div>
        <div class="setrow">
          <div>
            <div class="setrow__label">Beat sync</div>
            <div class="setrow__hint">
              Speed empurra a derivada do relógio com a energia do kick; Pulse trava fase por PLL e
              pulsa a amplitude. No Android o pulso vem de um relógio sintético — não há análise de
              áudio.
            </div>
          </div>
          <div class="seg">
            <For each={BEAT_MODES}>
              {(m) => (
                <button aria-pressed={beatMode() === m ? "true" : "false"} onClick={() => setBeatMode(m)}>
                  {m}
                </button>
              )}
            </For>
          </div>
        </div>
      </div>

      <div class="setpanel">
        <div class="setpanel__head">
          <div class="setpanel__title">Library</div>
          <span class="setpanel__sub">
            {fmtCount(tracks().length)} faixas · {folders().length} pastas
          </span>
        </div>
        <div class="setrow">
          <div>
            <div class="setrow__label">Pasta de música</div>
            <div class="setrow__hint mono">{root()}</div>
          </div>
        </div>
        <div class="setrow setrow--inline">
          <div>
            <div class="setrow__label">Re-scan library</div>
            <div class="setrow__hint">Relê o manifest e varre o acervo de novo.</div>
          </div>
          <button
            class="selbtn selbtn--accent"
            style={{ width: "auto" }}
            disabled={rescanning()}
            onClick={() => void rescan()}
          >
            <Show when={rescanning()} fallback="Re-scan">
              …
            </Show>
          </button>
        </div>
        <div class="statgrid">
          <For each={stats()}>
            {(s) => (
              <div class="stile">
                <span class="stile__l">{s[0]}</span>
                <span class="stile__v">{s[1]}</span>
                <span class="stile__s">{s[2]}</span>
              </div>
            )}
          </For>
        </div>
      </div>

      <div class="setpanel">
        <div class="setpanel__head">
          <div class="setpanel__title">About</div>
          <span class="setpanel__sub">rustify-player · Android v0</span>
        </div>
        <div class="aboutgrid">
          <For
            each={[
              ["Identifier", "dev.cmr.rustifyplayer"],
              ["Shell", "Tauri 2 · Rust"],
              ["Playback", "ExoPlayer · Media3"],
              ["Interface", "SolidJS"],
            ]}
          >
            {(a) => (
              <div class="aitem">
                <span class="aitem__l">{a[0]}</span>
                <span class="aitem__v">{a[1]}</span>
              </div>
            )}
          </For>
        </div>
      </div>
      <div style={{ height: "10px" }} />
    </div>
  );
}
