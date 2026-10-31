/* ============================================================
   Dock.tsx — rodapé persistente do handoff: barra de progresso
   fina + mini player + tabbar.

   Gestos portados do protótipo: arrastar o mini na horizontal =
   prev/next, arrastar pra cima ou tocar = abre o Now Playing.

   O tabbar tem 4 abas (o protótipo tinha 5): Crate saiu junto com
   a tela, que não existe no v0. Settings saiu do tabbar (já vive
   no header da Home) e a Queue entrou no lugar (CMR-213).
   ============================================================ */

import { For, Index, Show, createEffect, onCleanup } from "solid-js";
import { Cover } from "./Cover";
import { Icon } from "../icons";
import { activeTab, baseRoute, navigate, openNowPlaying } from "../nav";
import { current, next, pb, previous, queueContextId, queueOrigin, toggle } from "../store";
import { originLabel, originSrc } from "../derive";
import { scrollBehavior } from "../motion";
import { subscribeFft } from "../bg/spectrum";

const TAB_DEFS: Array<{ path: string; label: string; icon: () => any }> = [
  { path: "/home", label: "Home", icon: Icon.home },
  { path: "/search", label: "Search", icon: Icon.search },
  { path: "/library", label: "Library", icon: Icon.library },
  { path: "/queue", label: "Queue", icon: Icon.queue },
];

/** Sobe a tela corrente ao topo (a .view é o scroller do shell). */
function scrollViewToTop() {
  const view = document.querySelector<HTMLElement>(".view");
  if (!view) return;
  if (typeof view.scrollTo === "function") view.scrollTo({ top: 0, behavior: scrollBehavior() });
  else view.scrollTop = 0;
}

/** Tocar a aba JÁ ativa, na raiz dela, sobe ao topo (mobile-4): navigate()
 *  não faz nada quando o hash já é o alvo, e o toque morria. Numa sub-rota
 *  (pasta, álbum…) a aba continua levando de volta à raiz. */
function onTab(path: string) {
  if (baseRoute().path === path) scrollViewToTop();
  else navigate(path);
}

/** Altura (fração de 14 px) de cada barra em repouso e o teto. */
const VU_REST = 0.22;
const VU_GAIN = 1.25;

/** As quatro barras a partir das três bandas: grave, médio-grave, médio,
    agudo. Puro e determinístico (A56): o mesmo quadro dá a mesma altura. */
export function vuLevels(low: number, mid: number, high: number): number[] {
  const v = [low, (low + mid) / 2, mid, high];
  return v.map((x) => Math.max(VU_REST, Math.min(1, VU_REST + Math.max(0, x) * VU_GAIN)));
}

/** VU do mini: lê o MESMO feed de FFT do fundo (sem timer próprio) e pinta
    por transform, sem re-render do Solid. Pausado, repousa e não ouve. */
function Vu() {
  const bars: HTMLElement[] = [];
  const paint = (lv: number[] | null) => {
    for (let i = 0; i < bars.length; i++) {
      const el = bars[i];
      if (el) el.style.transform = `scaleY(${(lv ? lv[i] : VU_REST).toFixed(3)})`;
    }
  };
  const un = subscribeFft((low, mid, high) => {
    if (pb.isPlaying) paint(vuLevels(low, mid, high));
  });
  createEffect(() => {
    if (!pb.isPlaying) paint(null);
  });
  onCleanup(un);
  return (
    <div class="vu" aria-hidden="true">
      <Index each={[0, 1, 2, 3]}>
        {(_, i) => <i ref={(el) => (bars[i] = el)} style={{ transform: `scaleY(${VU_REST})` }} />}
      </Index>
    </div>
  );
}

export function Dock() {
  const progress = () => (pb.durationMs > 0 ? Math.min(1, pb.positionMs / pb.durationMs) : 0);

  // Gestos do mini (porte do protótipo)
  let sx = 0, sy = 0, st = 0;
  /** Último pointerup no mini: o click que o navegador dispara logo depois é
   *  eco do gesto (tap ou swipe), não uma segunda intenção. */
  let lastUp = 0;
  const onDown = (e: PointerEvent) => {
    sx = e.clientX; sy = e.clientY; st = Date.now();
  };
  const onUp = (e: PointerEvent) => {
    lastUp = Date.now();
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
  /* Caminho sem ponteiro (mobile-20): teclado e ativação do TalkBack, que
     chega como click sem gesto antes. Com gesto, o onUp já decidiu. */
  const onInfoClick = () => {
    if (Date.now() - lastUp < 700) return;
    openNowPlaying();
  };
  const onInfoKey = (e: KeyboardEvent) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    e.preventDefault();
    openNowPlaying();
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
            <div
              class="info"
              style={{ flex: 1, "min-width": 0 }}
              role="button"
              tabindex="0"
              aria-label={`Abrir Now Playing: ${t().title}`}
              onClick={onInfoClick}
              onKeyDown={onInfoKey}
            >
              <div class="tt">{t().title}</div>
              <div class="ts">
                <span class="srcbadge" attr:data-src={originSrc(queueOrigin(), queueContextId())}>
                  {originLabel(queueOrigin(), queueContextId())}
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
      <nav class="tabbar" aria-label="Navegação principal">
        <For each={TAB_DEFS}>
          {(tab) => (
            <button
              class="tab"
              attr:data-on={activeTab() === tab.path ? "" : undefined}
              aria-current={activeTab() === tab.path ? "page" : undefined}
              onClick={() => onTab(tab.path)}
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
