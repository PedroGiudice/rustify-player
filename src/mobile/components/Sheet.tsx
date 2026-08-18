/* ============================================================
   Sheet.tsx — bottom-sheet do handoff (.sheet/.panel/.grab/.kv).

   É o primitivo que faltava: sem ele não há long-press, menu de
   faixa, track info nem confirmação — metade das micro-interações
   do app dependia de ter onde morar.

   Fecha por: toque no scrim, arraste do grab para baixo e botão
   voltar do Android (sentinela de history, em sheet.ts).
   ============================================================ */

import { For, Show, createSignal } from "solid-js";
import { Icon } from "../icons";
import { closeSheet, closeSheetThen, openSheet, sheet } from "../sheet";
import type { SheetSpec } from "../sheet";
import { navigate } from "../nav";
import { albumKey, fmtDuration, shuffled } from "../derive";
import { enqueueEnd, enqueueNext, playList, playSimilar, playTrackFrom } from "../store";
import type { Track } from "../types";

type IconName = keyof typeof Icon;

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
      run: () => {
        if (ctx) void playTrackFrom(ctx.list, ctx.index);
        else void playList([t], 0, "manual");
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
      // A cauda embaralhada e arranjo da maquina: origin `autoplay` (vocabulario v3).
      run: () => void playList([t, ...shuffled(ctx.list.slice(ctx.index + 1))], 0, "autoplay"),
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
        <div class="sheet__title">{props.spec.track.title}</div>
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
        <div class="sheet__title">Informações</div>
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
    <div class="sheet" attr:data-open={sheet() ? "" : undefined} role="dialog" aria-modal="true">
      <div class="scrim" onClick={() => closeSheet()} />
      <div class="panel" style={dragY() ? { transform: `translateY(${dragY()}px)` } : undefined}>
        <div
          class="grab"
          onPointerDown={(e) => (startY = e.clientY)}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
        />
        <Show when={sheet()}>
          {(spec) => (
            <Show
              when={spec().kind === "track" ? (spec() as Extract<SheetSpec, { kind: "track" }>) : null}
              fallback={<InfoSheet track={spec().track} />}
            >
              {(s) => <TrackSheet spec={s()} />}
            </Show>
          )}
        </Show>
      </div>
    </div>
  );
}

/** Ponto de entrada das telas: abre a sheet de uma faixa com o contexto. */
export function openTrackSheet(track: Track, context?: { list: Track[]; index: number }) {
  openSheet({ kind: "track", track, context });
}
