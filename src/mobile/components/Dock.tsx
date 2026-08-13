/* ============================================================
   Dock.tsx — rodapé persistente do handoff: barra de progresso
   fina + mini player + tabbar.

   Gestos portados do protótipo: arrastar o mini na horizontal =
   prev/next, arrastar pra cima ou tocar = abre o Now Playing.

   O tabbar tem 4 abas (o protótipo tinha 5): Crate saiu junto com
   a tela, que não existe no v0.
   ============================================================ */

import { For, Show, createSignal, onCleanup } from "solid-js";
import { Cover } from "./Cover";
import { Icon } from "../icons";
import { activeTab, navigate, openNowPlaying } from "../nav";
import { current, next, pb, previous, queueOrigin, toggle } from "../store";
import { originLabel, originSrc } from "../derive";

const TAB_DEFS: Array<{ path: string; label: string; icon: () => any }> = [
  { path: "/home", label: "Home", icon: Icon.home },
  { path: "/search", label: "Search", icon: Icon.search },
  { path: "/library", label: "Library", icon: Icon.library },
  { path: "/settings", label: "Settings", icon: Icon.settings },
];

function Vu() {
  const [bars, setBars] = createSignal([4, 4, 4, 4]);
  const id = setInterval(() => {
    setBars(pb.isPlaying ? Array.from({ length: 4 }, () => 4 + Math.random() * 10) : [3, 3, 3, 3]);
  }, 400);
  onCleanup(() => clearInterval(id));
  return (
    <div class="vu">
      <For each={bars()}>{(h) => <i style={{ height: `${h}px` }} />}</For>
    </div>
  );
}

export function Dock() {
  const progress = () => (pb.durationMs > 0 ? Math.min(1, pb.positionMs / pb.durationMs) : 0);

  // Gestos do mini (porte do protótipo)
  let sx = 0, sy = 0, st = 0;
  const onDown = (e: PointerEvent) => {
    sx = e.clientX; sy = e.clientY; st = Date.now();
  };
  const onUp = (e: PointerEvent) => {
    const dx = e.clientX - sx, dy = e.clientY - sy;
    if (Date.now() - st > 600) return;
    if (Math.abs(dx) > 44 && Math.abs(dx) > Math.abs(dy)) {
      void (dx < 0 ? next() : previous());
      return;
    }
    if (dy < -40 && Math.abs(dy) > Math.abs(dx)) {
      openNowPlaying();
      return;
    }
    if (Math.abs(dx) < 8 && Math.abs(dy) < 8 && !(e.target as HTMLElement).closest("button.iconbtn")) {
      openNowPlaying();
    }
  };

  return (
    <div class="dock">
      <div class="prog">
        <i style={{ width: `${progress() * 100}%` }} />
      </div>
      <Show
        when={current()}
        fallback={
          <div class="mini" aria-hidden="true">
            <div class="cov" style={{ background: "var(--tone-paper)", "border-color": "var(--tone-paper-b)" }}>
              <Icon.note />
            </div>
            <div class="info" style={{ flex: 1, "min-width": 0 }}>
              <div class="tt" style={{ color: "var(--t3)" }}>Nada tocando</div>
              <div class="ts">escolha uma faixa</div>
            </div>
          </div>
        }
      >
        {(t) => (
          <div class="mini" onPointerDown={onDown} onPointerUp={onUp}>
            <Cover path={t().album_cover_path} seed={t().id} />
            <div class="info" style={{ flex: 1, "min-width": 0 }}>
              <div class="tt">{t().title}</div>
              <div class="ts">
                <span class="srcbadge" attr:data-src={originSrc(queueOrigin())}>
                  {originLabel(queueOrigin())}
                </span>
                <span>{t().artist_name ?? "—"}</span>
              </div>
            </div>
            <Vu />
            <button
              class="iconbtn"
              aria-label={pb.isPlaying ? "Pausar" : "Tocar"}
              onClick={(e) => {
                e.stopPropagation();
                void toggle();
              }}
            >
              <Show when={pb.isPlaying} fallback={<Icon.play />}>
                <Icon.pause />
              </Show>
            </button>
            <button
              class="iconbtn"
              aria-label="Próxima"
              onClick={(e) => {
                e.stopPropagation();
                void next();
              }}
            >
              <Icon.next />
            </button>
          </div>
        )}
      </Show>
      <nav class="tabbar">
        <For each={TAB_DEFS}>
          {(tab) => (
            <button
              class="tab"
              attr:data-on={activeTab() === tab.path ? "" : undefined}
              onClick={() => navigate(tab.path)}
            >
              <tab.icon />
              <span>{tab.label}</span>
            </button>
          )}
        </For>
      </nav>
    </div>
  );
}
