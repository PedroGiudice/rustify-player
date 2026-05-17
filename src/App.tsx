/* ============================================================
   App.tsx — Shell do redesign Extractor Lab.

   Mantemos a Titlebar custom porque `tauri.conf.json` define
   `decorations: false` (precisamos dos drag-region + botoes
   minimize/maximize/close).

   Atalhos globais: N (now playing), H (home), L (library), Esc
   (sai do cinema mode). Demais atalhos (Q, F, [, ], Ctrl/Cmd+K)
   vivem nos componentes responsaveis.
   ============================================================ */

import { onCleanup, onMount } from "solid-js";
import { Titlebar } from "./components/Titlebar";
import { Sidebar } from "./components/Sidebar";
import { PlayerBar } from "./components/PlayerBar";
import { CommandPalette } from "./components/CommandPalette";
import { QueueDrawer } from "./components/QueueDrawer";
import { RouterView, navigate } from "./router";
import { Tweaks } from "./views/Tweaks";
// Painel Tweaks (Solid). loadTweaks aplica state salvo antes do render
// pra evitar flash; o componente <Tweaks/> renderiza via Portal e
// reage ao evento "toggle-tweaks" disparado pela sidebar.
import { loadTweaks } from "./store/tweaks";

export default function App() {
  // Aplica preferencias de fonte/zoom o quanto antes — evita flash de fonte padrao.
  loadTweaks();

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
        const app = document.getElementById("rustify-app");
        if (app?.getAttribute("data-cinema") === "true") {
          app.setAttribute("data-cinema", "false");
        }
      }
    };
    window.addEventListener("keydown", onKey);
    onCleanup(() => window.removeEventListener("keydown", onKey));
  });

  return (
    <div class="app" id="rustify-app" data-cinema="false">
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
