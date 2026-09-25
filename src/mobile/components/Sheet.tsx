/* ============================================================
   Sheet.tsx — bottom-sheet do handoff (.sheet/.panel/.grab/.kv).

   É o primitivo que faltava: sem ele não há long-press, menu de
   faixa, track info nem confirmação — metade das micro-interações
   do app dependia de ter onde morar.

   Fecha por: toque no scrim, arraste do grab para baixo e botão
   voltar do Android (sentinela de history, em sheet.ts).
   ============================================================ */

import { For, Match, Show, Switch, createEffect, createSignal } from "solid-js";
import { Icon } from "../icons";
import { closeSheet, closeSheetThen, openSheet, sheet } from "../sheet";
import type { SheetSpec } from "../sheet";
import { navigate, navigateFromNp } from "../nav";
import { is2dActive } from "../bg/engine";
import { useRenderer, useShape } from "../bg/spectrum";
import { albumKey, fmtDuration } from "../derive";
import {
  enqueueEnd,
  enqueueNext,
  playFolderFrom,
  playFromHere,
  playList,
  playSimilar,
  playTrackFrom,
} from "../store";
import type { Track, TrackContext } from "../types";

type IconName = keyof typeof Icon;

/** Uma sheet por vez: o título da aberta nomeia o diálogo (aria-labelledby). */
const TITLE_ID = "sheet-title";

interface Action {
  label: string;
  icon: IconName;
  run: () => void;
  hint?: string;
  /** A própria ação cuida de fechar (navega depois de consumir a sentinela). */
  selfClosing?: boolean;
}

/** Pasta de 1º nível = playlist neste acervo (mesma regra do desktop). */
function playlistOf(t: Track): string | null {
  const m = t.path.match(/\/Music\/([^/]+)\//);
  return m ? m[1] : null;
}

const baseName = (p: string) => p.split("/").pop() ?? p;

function trackActions(spec: Extract<SheetSpec, { kind: "track" }>): Action[] {
  const t = spec.track;
  const ctx = spec.context;
  const acts: Action[] = [
    {
      label: "Tocar agora",
      icon: "play",
      // Mesma decisão da linha tocada: dentro de uma playlist a fila É a
      // playlist (contexto = pasta, continuidade OFF); fora, o default.
      run: () => {
        if (!ctx) void playList([t], 0, "manual");
        else if (ctx.playlist != null) void playFolderFrom(ctx.list, ctx.index, ctx.playlist);
        else void playTrackFrom(ctx.list, ctx.index);
      },
    },
  ];
  acts.push(
    {
      label: "Tocar em seguida",
      icon: "next",
      hint: "sem interromper o que toca",
      run: () => void enqueueNext(t),
    },
    {
      label: "Adicionar ao fim da fila",
      icon: "queue",
      run: () => void enqueueEnd(t),
    },
  );
  if (ctx && ctx.index < ctx.list.length - 1) {
    acts.push({
      label: "Tocar a partir daqui",
      icon: "shuffle",
      hint: `${ctx.list.length - ctx.index} faixas, embaralhadas`,
      // A regra (origin `autoplay`; dentro de playlist, contexto = pasta e
      // continuidade OFF) vive no store, ao lado de shuffleFolder — e é
      // testada lá (CMR-211).
      run: () => void playFromHere(ctx),
    });
  }
  acts.push({
    label: "Rádio da faixa",
    icon: "radio",
    hint: "vizinhos por similaridade",
    run: () => void playSimilar(t),
  });
  if (t.album_title) {
    acts.push({
      label: "Ir para o álbum",
      icon: "disc",
      selfClosing: true,
      run: () => closeSheetThen(() => navigate("/album", albumKey(t))),
    });
  }
  if (t.artist_name) {
    const artist = t.artist_name;
    acts.push({
      label: "Ir para o artista",
      icon: "person",
      selfClosing: true,
      run: () => closeSheetThen(() => navigate("/artist", artist)),
    });
  }
  acts.push({
    label: "Informações da faixa",
    icon: "note",
    // Troca o conteúdo da sheet aberta — sheet.ts não empilha outra sentinela.
    selfClosing: true,
    run: () => openSheet({ kind: "info", track: t }),
  });
  return acts;
}

function TrackSheet(props: { spec: Extract<SheetSpec, { kind: "track" }> }) {
  return (
    <>
      <div class="sheet__head">
        <div class="sheet__title" id={TITLE_ID}>{props.spec.track.title}</div>
        <div class="sheet__sub">
          {[props.spec.track.artist_name, props.spec.track.album_title]
            .filter(Boolean)
            .join(" · ")}
        </div>
      </div>
      <For each={trackActions(props.spec)}>
        {(a) => {
          const Ico = Icon[a.icon];
          return (
            <button
              class="sheet__act"
              onClick={() => {
                a.run();
                if (!a.selfClosing) closeSheet();
              }}
            >
              <Ico class="lead" />
              <div class="sheet__actlabel">
                <span>{a.label}</span>
                <Show when={a.hint}>
                  <span class="sheet__acthint">{a.hint}</span>
                </Show>
              </div>
            </button>
          );
        }}
      </For>
    </>
  );
}

/**
 * "Mais opções" do Now Playing (mobile-1): o cabeçalho só comporta quatro
 * alvos de 44px na largura útil do S24 (316px), e as ações secundárias
 * transbordavam — o overflow cortava justamente Fila e Fechar.
 */
function NpSheet(props: { track: Track }) {
  return (
    <>
      <div class="sheet__head">
        <div class="sheet__title" id={TITLE_ID}>{props.track.title}</div>
        <div class="sheet__sub">
          {[props.track.artist_name, props.track.album_title].filter(Boolean).join(" · ")}
        </div>
      </div>
      <button
        class="sheet__act"
        onClick={() => {
          void playSimilar(props.track);
          closeSheet();
        }}
      >
        <Icon.radio class="lead" />
        <div class="sheet__actlabel">
          <span>Rádio da faixa</span>
          <span class="sheet__acthint">vizinhos por similaridade</span>
        </div>
      </button>
      {/* replace, não push: o voltar da fila não pode reabrir o NP (mobile-v3) */}
      <button class="sheet__act" onClick={() => closeSheetThen(() => navigateFromNp("/queue"))}>
        <Icon.queue class="lead" />
        <div class="sheet__actlabel">
          <span>Fila</span>
        </div>
      </button>
      {/* Só com o canvas 2D desenhando (mobile-2). Trocar não fecha a sheet:
          o rótulo mostra o novo valor e dá pra ciclar em sequência. */}
      <Show when={is2dActive()}>
        <button class="sheet__act" onClick={() => useRenderer.next()}>
          <Icon.sparkle class="lead" />
          <div class="sheet__actlabel">
            <span>Render do fundo</span>
            <span class="sheet__acthint">{useRenderer.name()}</span>
          </div>
        </button>
        <button class="sheet__act" onClick={() => useShape.next()}>
          <Icon.sparkle class="lead" />
          <div class="sheet__actlabel">
            <span>Shape do fundo</span>
            <span class="sheet__acthint">{useShape.name()}</span>
          </div>
        </button>
      </Show>
    </>
  );
}

function InfoSheet(props: { track: Track }) {
  const rows = (): [string, string][] => {
    const t = props.track;
    const list: [string, string][] = [
      ["Título", t.title],
      ["Artista", t.artist_name ?? "—"],
      ["Álbum", t.album_title ?? "—"],
    ];
    if (t.album_year) list.push(["Ano", String(t.album_year)]);
    if (t.track_number) list.push(["Faixa nº", String(t.track_number)]);
    if (t.genre_name) list.push(["Gênero", t.genre_name]);
    list.push(["Duração", fmtDuration(t.duration_ms)]);
    const pl = playlistOf(t);
    if (pl) list.push(["Playlist", pl]);
    list.push(["Arquivo", baseName(t.path)]);
    list.push(["Letra", t.lrc_path ? "sincronizada" : "não disponível"]);
    list.push(["track_id", t.id]);
    return list;
  };
  return (
    <>
      <div class="sheet__head">
        <div class="sheet__title" id={TITLE_ID}>Informações</div>
        <div class="sheet__sub">{props.track.title}</div>
      </div>
      <For each={rows()}>
        {([k, v]) => (
          <div class="kv">
            <span>{k}</span>
            <span>{v}</span>
          </div>
        )}
      </For>
    </>
  );
}

export function Sheet() {
  const [dragY, setDragY] = createSignal(0);
  let startY: number | null = null;
  let panelEl: HTMLDivElement | undefined;

  // Ao ABRIR (não ao trocar o conteúdo), o foco entra na sheet: sem isso o
  // leitor de tela seguia na tela de baixo, atrás do scrim (mobile-20).
  // Ao FECHAR, volta a quem abriu: a sheet vira display:none com o foco
  // dentro e ele caía no body (o TalkBack voltava ao topo da página). Só
  // se quem abriu ainda está no DOM e fora de uma subárvore inerte (a ação
  // pode ter trocado de tela ou aberto o Now Playing por cima).
  let wasOpen = false;
  let opener: HTMLElement | null = null;
  createEffect(() => {
    const open = sheet() != null;
    if (open && !wasOpen) {
      opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      panelEl?.focus({ preventScroll: true });
    } else if (!open && wasOpen) {
      const back = opener;
      opener = null;
      if (back?.isConnected && !back.closest("[inert]") && panelEl?.contains(document.activeElement)) {
        back.focus({ preventScroll: true });
      }
    }
    wasOpen = open;
  });

  const onMove = (e: PointerEvent) => {
    if (startY == null) return;
    setDragY(Math.max(0, e.clientY - startY));
  };
  const onUp = () => {
    // Arrastou o suficiente para baixo: fecha (gesto canônico do Android).
    if (dragY() > 90) closeSheet();
    startY = null;
    setDragY(0);
  };

  return (
    <div
      class="sheet"
      attr:data-open={sheet() ? "" : undefined}
      role="dialog"
      aria-modal="true"
      aria-labelledby={sheet() ? TITLE_ID : undefined}
    >
      <div class="scrim" onClick={() => closeSheet()} />
      <div
        class="panel"
        ref={panelEl}
        tabindex="-1"
        style={dragY() ? { transform: `translateY(${dragY()}px)` } : undefined}
      >
        <div
          class="grab"
          onPointerDown={(e) => (startY = e.clientY)}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
        <Show when={sheet()}>
          {(spec) => (
            <Switch fallback={<InfoSheet track={spec().track} />}>
              <Match when={spec().kind === "track" ? (spec() as Extract<SheetSpec, { kind: "track" }>) : null}>
                {(s) => <TrackSheet spec={s()} />}
              </Match>
              <Match when={spec().kind === "np" ? spec() : null}>
                {(s) => <NpSheet track={s().track} />}
              </Match>
            </Switch>
          )}
        </Show>
      </div>
    </div>
  );
}

/** Ponto de entrada das telas: abre a sheet de uma faixa com o contexto. */
export function openTrackSheet(track: Track, context?: TrackContext) {
  openSheet({ kind: "track", track, context });
}
