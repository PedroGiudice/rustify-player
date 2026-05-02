/* ============================================================
   App.tsx — Shell do app: Titlebar, Sidebar, RouterView, PlayerBar.
   Substitui o boot() de main.js + o HTML estatico de index.html.
   ============================================================ */

import { onMount } from "solid-js";
import { Titlebar } from "./components/Titlebar";
import { Sidebar } from "./components/Sidebar";
import { PlayerBar } from "./components/PlayerBar";
import { RouterView } from "./router";
import { loadTweaks, mountTweaks } from "./js/components/tweaks.js";
import { mountResources } from "./js/components/resources.js";

export default function App() {
  onMount(() => {
    loadTweaks();
    mountTweaks();
    mountResources();
  });

  return (
    <>
      <Titlebar />
      <Sidebar />
      <main class="main" id="main">
        <RouterView />
      </main>
      <PlayerBar />
    </>
  );
}
