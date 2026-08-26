/* ============================================================
   Settings.tsx — porte de S.settings do handoff, reduzido ao que
   tem trilho no v0.

   Ficaram: Appearance (renderer + shape do fundo e Beat sync, tudo
   local, como no protótipo) e Library (raiz do acervo, re-scan via
   lib_rescan — que existe — e as contagens reais).

   Saíram, por não existir command nenhum por trás: tema
   claro/escuro e YAML, full-screen player, resume on launch,
   volume, normalização de loudness, embeddings/qdrant e a tela
   Signal/EQ. Renderizar esses controles seria desenhar botão morto.

   Entrou (26/08): Atualização — check no release dev + download +
   PackageInstaller (spec 2026-08-24).
   ============================================================ */

import { For, Show } from "solid-js";
import { ViewHead } from "../components/ui";
import { BEAT_MODES, beatMode, setBeatMode } from "../bg/beatSetting";
import { useRenderer, useShape } from "../bg/spectrum";
import {
  albums,
  artists,
  continuityOn,
  folders,
  rescan,
  rescanning,
  setContinuity,
  tracks,
} from "../store";
import { commonRoot, fmtCount } from "../derive";
import { appVersion, checkForUpdate, fmtBytes, installUpdate, upd, updBusy } from "../updater";

export function Settings() {
  const root = () => commonRoot(tracks().map((t) => t.path)) ?? "—";
  const stats = () => [
    ["FAIXAS", fmtCount(tracks().length), "indexadas"],
    ["PASTAS", String(folders().length), "playlists"],
    ["ÁLBUNS", String(albums().length), "distintos"],
    ["ARTISTAS", String(artists().length), "distintos"],
  ];

  const updLabel = () => {
    const s = upd();
    switch (s.phase) {
      case "checking":
        return "Consultando o release…";
      case "available":
      case "needs_permission":
        return `Versão ${s.check?.latest} disponível`;
      case "downloading":
        return `Baixando ${fmtBytes(s.bytes)}${s.total ? ` de ${fmtBytes(s.total)}` : ""}`;
      case "verifying":
        return "Verificando o pacote…";
      case "installing":
        return "Preparando a instalação…";
      case "confirming":
        return "Confirme a instalação na tela do sistema";
      case "done":
        return "Instalada — o app vai reabrir";
      case "failed":
        return "A atualização falhou";
      case "uptodate":
        return "Você está na versão mais recente";
      default:
        return "Buscar atualização";
    }
  };
  const updHint = () => {
    const s = upd();
    if (s.phase === "failed") return s.error ?? "erro desconhecido";
    if (s.phase === "needs_permission")
      return "O Android exige liberar 'instalar apps desconhecidos' para o Rustify uma vez. Volte e toque de novo.";
    if (s.phase === "available" && s.check)
      return `${fmtBytes(s.check.size)} · do release dev no GitHub · a instalação pede confirmação do sistema.`;
    return "Consulta o release dev no GitHub. O check automático roda no máximo a cada 6h.";
  };
  const updButton = () => {
    const p = upd().phase;
    if (p === "available" || p === "needs_permission") return "Baixar e instalar";
    if (p === "failed") return "Tentar de novo";
    if (p === "downloading" || p === "verifying" || p === "installing" || p === "confirming") return "…";
    return "Buscar";
  };
  const updAction = () => {
    const p = upd().phase;
    if (p === "available" || p === "needs_permission") return installUpdate();
    if (p === "failed" && upd().check?.available) return installUpdate();
    return checkForUpdate(true);
  };

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
              pulsa a amplitude. O pulso vem da FFT do próprio player (SpectrumTap), com as mesmas
              bandas do desktop — o gerador sintético só cobre o intervalo até o primeiro quadro real.
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
          <div class="setpanel__title">Reprodução</div>
        </div>
        <div class="setrow">
          <div>
            <div class="setrow__label">Continuar tocando</div>
            <div class="setrow__hint">
              Quando a fila está acabando, o aparelho escolhe as próximas sozinho — station usa o
              pool dela, qualquer outra fila vira rádio semeado pelo que está tocando. Playlist é a
              exceção: coleção curada tem fim e termina. Funciona com a tela apagada; desligado, a
              fila termina e o som para.
            </div>
          </div>
          <div class="seg">
            <button
              aria-pressed={continuityOn() ? "true" : "false"}
              onClick={() => void setContinuity(true)}
            >
              on
            </button>
            <button
              aria-pressed={!continuityOn() ? "true" : "false"}
              onClick={() => void setContinuity(false)}
            >
              off
            </button>
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
          <div class="setpanel__title">Atualização</div>
          <span class="setpanel__sub">
            <Show when={appVersion()} fallback="versão —">
              v{appVersion()}
            </Show>
          </span>
        </div>
        <div class="setrow setrow--inline">
          <div>
            <div class="setrow__label">{updLabel()}</div>
            <div class="setrow__hint">{updHint()}</div>
          </div>
          <button
            class="selbtn selbtn--accent"
            style={{ width: "auto" }}
            disabled={updBusy()}
            onClick={() => void updAction()}
          >
            {updButton()}
          </button>
        </div>
        <Show when={upd().phase === "downloading" && upd().total > 0}>
          <div class="setrow">
            <div class="updbar">
              <i style={{ width: `${Math.min(100, (100 * upd().bytes) / upd().total)}%` }} />
            </div>
          </div>
        </Show>
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
