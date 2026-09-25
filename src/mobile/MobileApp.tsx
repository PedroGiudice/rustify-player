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

import { Show, Suspense, createEffect, lazy, onCleanup, onMount } from "solid-js";
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
import { Sheet } from "./components/Sheet";
import { initSheetHistory } from "./sheet";
import { Home } from "./screens/Home";
import { Search } from "./screens/Search";
import { Library } from "./screens/Library";
import { Folder } from "./screens/Folder";
import { Album } from "./screens/Album";
import { Artist } from "./screens/Artist";
import { Queue } from "./screens/Queue";
import { Settings } from "./screens/Settings";
import { Stations } from "./screens/Stations";
import { baseRoute, bootRoute, isNpOpen, rememberScroll, restoreScroll, savedScroll } from "./nav";
import { bootStore, current, pb } from "./store";
import { Toast } from "./components/ui";
import { applyAdaptiveColor } from "./adaptiveColor";
import { applyBeatMode } from "./bg/beatSetting";
import { mockFft, mountSpectrum, pushFft } from "./bg/spectrum";
import { is2dActive } from "./bg/engine";
import { onFft } from "./ipc";
import { bootUpdater } from "./updater";

// three.js só é baixado do disco se o motor WebGL estiver ligado —
// o APK carrega o chunk sob demanda, o boot do fundo 2D não muda.
const GlBg = lazy(async () => ({ default: (await import("./bg/GlBg")).GlBg }));

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

/** Canvas 2D de sempre — o motor default. */
function Spectrum2d() {
  let canvas: HTMLCanvasElement | undefined;
  onMount(() => {
    if (!canvas) return;
    const stopRaf = mountSpectrum(canvas);
    onCleanup(stopRaf);
  });
  return <canvas class="app-bg__canvas" ref={canvas} />;
}

/** Fundo persistente: o feed de FFT é do SHELL (vive enquanto o app
    vive, independente de quem desenha); só o motor troca por baixo.
    Se o WebGL não montar, o 2D reassume sozinho e o Settings mostra o
    motivo. */
function Bg() {
  onMount(() => {
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
    onCleanup(() => {
      stopMock?.();
      stopFftListener?.();
    });
  });
  return (
    <div class="app-bg" attr:data-mode={isNpOpen() ? "focused" : "ambient"} aria-hidden="true">
      <div class="app-bg__curtain" />
      <Show when={!is2dActive()} fallback={<Spectrum2d />}>
        <Suspense fallback={<Spectrum2d />}>
          <GlBg />
        </Suspense>
      </Show>
    </div>
  );
}

export function MobileApp() {
  let viewEl: HTMLDivElement | undefined;
  let cancelRestore: (() => void) | undefined;
  const stopRestore = () => {
    cancelRestore?.();
    cancelRestore = undefined;
  };
  // Trocou de tela: entrada NOVA do histórico abre no topo (como no
  // protótipo); VOLTAR devolve a rolagem que a entrada tinha (mobile-3).
  createEffect(() => {
    baseRoute();
    stopRestore();
    if (!viewEl) return;
    const y = savedScroll();
    if (y == null) viewEl.scrollTop = 0;
    else cancelRestore = restoreScroll(viewEl, y);
  });

  // Ink do bg + accents seguem a dominante da capa da faixa corrente.
  createEffect(() => {
    applyAdaptiveColor(current()?.dominant_color);
  });

  return (
    <div class="device">
      <Bg />
      {/* Com o NP aberto por cima, a tela e o dock atrás saem do foco e da
          árvore de acessibilidade (o TalkBack percorria o que estava
          escondido). O inverso — NP fechado — é tratado no próprio NP. */}
      <div
        class="shell"
        inert={isNpOpen()}
        aria-hidden={isNpOpen() ? "true" : undefined}
      >
        <div
          class="view"
          ref={viewEl}
          onScroll={() => viewEl && rememberScroll(viewEl.scrollTop)}
          onPointerDown={stopRestore}
          onWheel={stopRestore}
        >
          {screen()}
        </div>
        <Dock />
      </div>
      <NowPlaying />
      <Sheet />
      <Toast />
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
  // Sentinela de history da sheet: o voltar do Android fecha a sheet
  // antes de sair da tela.
  initSheetHistory();

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
  // Versão instalada + check de atualização com throttle (spec 2026-08-24).
  bootUpdater();
}

export default MobileApp;
