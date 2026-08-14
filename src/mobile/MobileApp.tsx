/* ============================================================
   MobileApp.tsx — raiz da UI Android.

   Estrutura do handoff (Rustify Mobile.html): fundo persistente em
   canvas montado UMA vez, shell com a tela corrente por cima,
   dock (progresso + mini + tabbar) no rodapé e o Now Playing
   deslizando por cima de tudo.

   Fora do handoff: a moldura de aparelho (.wrap/.label), a status
   bar falsa e a barra de navegação falsa do Android — o aparelho
   real desenha as duas.
   ============================================================ */

import { Show, createEffect, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";

// Fontes do handoff, self-hosted (o @import do Google Fonts é
// proibido pela CSP). Só entram no chunk mobile.
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-700.css";
import "@fontsource/inter/latin-ext-400.css";
import "@fontsource/inter/latin-ext-500.css";
import "@fontsource/fraunces/latin-600.css";
import "@fontsource/jetbrains-mono/latin-400.css";
import "@fontsource/jetbrains-mono/latin-500.css";

import "./styles/tokens.css";
import "./styles/app.css";

import { Dock } from "./components/Dock";
import { NowPlaying } from "./components/NowPlaying";
import { Home } from "./screens/Home";
import { Search } from "./screens/Search";
import { Library } from "./screens/Library";
import { Folder } from "./screens/Folder";
import { Album } from "./screens/Album";
import { Artist } from "./screens/Artist";
import { Queue } from "./screens/Queue";
import { Settings } from "./screens/Settings";
import { Stations } from "./screens/Stations";
import { baseRoute, bootRoute, isNpOpen } from "./nav";
import { bootStore, current, pb, toast } from "./store";
import { applyAdaptiveColor } from "./adaptiveColor";
import { applyBeatMode } from "./bg/beatSetting";
import { mockFft, mountSpectrum, pushFft } from "./bg/spectrum";
import { onFft } from "./ipc";

/* Chamada como expressão no JSX (`{screen()}`), NÃO como <screen />:
   corpo de componente Solid roda uma vez e a leitura de baseRoute()
   ficaria congelada na primeira rota. Como expressão, o compilador
   embrulha num efeito e a troca de tela reage de verdade. */
function screen() {
  const r = baseRoute();
  switch (r.path) {
    case "/search":
      return <Search />;
    case "/library":
      return <Library />;
    case "/settings":
      return <Settings />;
    case "/folder":
      return <Folder param={r.param} />;
    case "/album":
      return <Album param={r.param} />;
    case "/artist":
      return <Artist param={r.param} />;
    case "/queue":
      return <Queue />;
    case "/stations":
      return <Stations />;
    default:
      return <Home />;
  }
}

function SpectrumBg() {
  let canvas: HTMLCanvasElement | undefined;
  onMount(() => {
    if (!canvas) return;
    // Mock até o primeiro frame REAL do SpectrumTap (CMR-192) chegar —
    // aí o gerador sintético desliga e o bg passa a ouvir a música.
    let stopMock: (() => void) | null = mockFft(() => pb.isPlaying);
    let stopFftListener: (() => void) | undefined;
    onFft((f) => {
      if (stopMock) {
        stopMock();
        stopMock = null;
      }
      pushFft(f.low, f.mid, f.high);
    })
      .then((un) => {
        stopFftListener = un;
      })
      .catch((e) => console.warn("[mobile] listener fft:", e));
    const stopRaf = mountSpectrum(canvas);
    onCleanup(() => {
      stopMock?.();
      stopFftListener?.();
      stopRaf();
    });
  });
  return (
    <div class="app-bg" attr:data-mode={isNpOpen() ? "focused" : "ambient"} aria-hidden="true">
      <div class="app-bg__curtain" />
      <canvas class="app-bg__canvas" ref={canvas} />
    </div>
  );
}

export function MobileApp() {
  let viewEl: HTMLDivElement | undefined;
  // Trocou de tela: volta ao topo (o protótipo zerava o scrollTop).
  createEffect(() => {
    baseRoute();
    if (viewEl) viewEl.scrollTop = 0;
  });

  // Ink do bg + accents seguem a dominante da capa da faixa corrente.
  createEffect(() => {
    applyAdaptiveColor(current()?.dominant_color);
  });

  return (
    <div class="device">
      <SpectrumBg />
      <div class="shell">
        <div class="view" ref={viewEl}>{screen()}</div>
        <Dock />
      </div>
      <NowPlaying />
      <Show when={toast()}>
        {(msg) => (
          <div class="toast" attr:data-on="">
            {msg()}
          </div>
        )}
      </Show>
    </div>
  );
}

/** Chamado pelo dispatch de main.tsx quando o user agent é Android. */
export function mountMobile() {
  // viewport-fit=cover: sem isso env(safe-area-inset-*) volta 0 e o
  // conteúdo passa por baixo do notch e da barra de gestos.
  const meta = document.querySelector('meta[name="viewport"]');
  if (meta) {
    meta.setAttribute(
      "content",
      "width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover",
    );
  }
  document.documentElement.setAttribute("data-platform", "android");

  applyBeatMode();
  bootRoute();

  const root = document.getElementById("app");
  if (!root) throw new Error("[mobile] #app não encontrado");
  render(() => <MobileApp />, root);

  // Console do WebView → log do Rust (ajuda a depurar no aparelho).
  import("@tauri-apps/plugin-log")
    .then((m) => m.attachConsole())
    .catch(() => {});

  // Depois do primeiro paint: initialize do plugin, biblioteca,
  // get_state e os listeners.
  void bootStore();
}

export default MobileApp;
