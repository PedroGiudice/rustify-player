/* ============================================================
   App.tsx — Shell do redesign Extractor Lab.

   Mantemos a Titlebar custom porque `tauri.conf.json` define
   `decorations: false` (precisamos dos drag-region + botoes
   minimize/maximize/close).

   Background animado é GLOBAL ao app: mora aqui (.app-bg),
   monta o canvas UMA vez e nunca remonta. Só o data-mode do
   wrapper recomputa em mudança de rota — "focused" quando o
   user está em /now-playing (ou cinema mode), "ambient" caso
   contrário. Animação persiste entre navegações.

   Atalhos globais: N (now playing), H (home), L (library), Esc
   (sai do cinema mode). Demais atalhos (Q, F, [, ], Ctrl/Cmd+K)
   vivem nos componentes responsaveis.
   ============================================================ */

import { createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Titlebar } from "./components/Titlebar";
import { Sidebar } from "./components/Sidebar";
import { PlayerBar } from "./components/PlayerBar";
import { CommandPalette } from "./components/CommandPalette";
import { QueueDrawer } from "./components/QueueDrawer";
import { SpectrumCanvas } from "./components/SpectrumCanvas";
import { RouterView, navigate, route } from "./router";
import { Tweaks } from "./views/Tweaks";
// Painel Tweaks (Solid). loadTweaks aplica state salvo antes do render
// pra evitar flash; o componente <Tweaks/> renderiza via Portal e
// reage ao evento "toggle-tweaks" disparado pela sidebar.
import { loadTweaks } from "./store/tweaks";

export default function App() {
  // Aplica preferencias de fonte/zoom o quanto antes — evita flash de fonte padrao.
  loadTweaks();

  // Cinema mode é um signal local pra o data-mode do bg poder
  // reagir junto com a rota. App.tsx é o único lugar que escreve.
  const [cinema, setCinema] = createSignal(false);

  // ── Reatividade do bg ─────────────────────────────────────
  // Único bit reativo do background: o data-mode do wrapper.
  // O canvas em si não depende disso — continua rodando rAF.
  const bgMode = createMemo<"focused" | "ambient">(() =>
    cinema() || route().path === "/now-playing" ? "focused" : "ambient"
  );

  onMount(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
      if (tag === "input" || tag === "textarea") return;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === "n") { e.preventDefault(); navigate("/now-playing"); }
      else if (k === "h") { e.preventDefault(); navigate("/home"); }
      else if (k === "l") { e.preventDefault(); navigate("/library"); }
      else if (e.key === "Escape") {
        if (cinema()) {
          setCinema(false);
          document.getElementById("rustify-app")?.setAttribute("data-cinema", "false");
        }
      }
    };
    window.addEventListener("keydown", onKey);

    // Cinema mode toggle vem de NowPlaying.tsx via custom event —
    // o estado canônico vive aqui pra o bgMode poder reagir.
    const onCinemaToggle = (e: Event) => {
      const next = (e as CustomEvent<boolean>).detail;
      setCinema(next);
      document.getElementById("rustify-app")?.setAttribute("data-cinema", next ? "true" : "false");
    };
    window.addEventListener("rustify:cinema", onCinemaToggle);

    onCleanup(() => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("rustify:cinema", onCinemaToggle);
    });
  });

  return (
    <div class="app" id="rustify-app" data-cinema="false">
      {/* Background global — UMA instância pro app inteiro. */}
      <div class="app-bg" data-mode={bgMode()} aria-hidden="true">
        <SpectrumCanvas />
      </div>

      <Titlebar />
      <Sidebar />
      <main class="main">
        <RouterView />
      </main>
      <PlayerBar />
      <CommandPalette />
      <QueueDrawer />
      <Tweaks />
    </div>
  );
}
