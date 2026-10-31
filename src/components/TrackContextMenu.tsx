// src/components/TrackContextMenu.tsx — menu de contexto de faixa (right-click).
// Reintroduz o antigo showTrackMenu (era src/js/components/context-menu.js,
// morto na migração pra Solid) como componente Solid reativo. Singleton
// montado UMA vez no App; o estado vive em store/contextMenu.
//
// Backend 100% compartilhado — mesmas funções que o CommandPalette usa:
//   setQueue / enqueueNext / enqueueEnd / shuffleQueue (store/player)
//   libToggleLike / libIsLiked (tauri)  ·  navigate (router)
// Zero comando Tauri novo.
//
// Teclado (A35): aberto pela tecla Menu, Shift+F10 ou Enter no "More", ancora
// no gatilho e o foco vai ao primeiro item; ↑/↓ andam (com volta), Home/End
// vão às pontas, Tab e Esc fecham e o foco volta ao gatilho. Pelo ponteiro, o
// foco fica no próprio menu (as setas funcionam, sem anel aceso).
import { Show, createSignal, createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { trackMenu, closeTrackMenu } from "../store/contextMenu";
import { pushEscLayer } from "../lib/escLayers";
import { rememberFocus } from "../lib/focusReturn";
import { libToggleLike, libIsLiked } from "../tauri";
import {
  setQueue, enqueueNext, enqueueEnd, enqueueNextMany, enqueueEndMany, shuffleQueue, player, setLiked,
} from "../store/player";
import { playTrack } from "./PlayerBar";
import { navigate } from "../router";
import { openMoveDialog } from "../store/moveDialog";
import { clearSelection } from "../store/selection";
import { moveLabel } from "../lib/selection";
import { Icon, ICONS } from "./Icon";

export function TrackContextMenu() {
  let menuEl: HTMLDivElement | undefined;
  const [liked, setLikedLocal] = createSignal(false);
  const [pos, setPos] = createSignal<{ x: number; y: number }>({ x: 0, y: 0 });

  // Ao abrir: posiciona, pré-busca o estado de like, e reposiciona com clamp
  // ao viewport após o paint (pra não vazar pela borda). Ancorado no gatilho
  // (teclado) e sem espaço embaixo, abre para cima do gatilho.
  createEffect(() => {
    const st = trackMenu();
    if (!st) return;
    setPos({ x: st.x, y: st.y });
    if (st.track.id) {
      libIsLiked(st.track.id).then(setLikedLocal).catch(() => setLikedLocal(false));
    } else {
      setLikedLocal(false);
    }
    const focusRet = rememberFocus(() => st.returnTo);
    onCleanup(() => focusRet.restore({ within: menuEl }));
    requestAnimationFrame(() => {
      if (!menuEl || trackMenu() !== st) return;
      const r = menuEl.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      const below = st.y + r.height > vh;
      setPos({
        x: st.x + r.width > vw ? Math.max(8, vw - r.width - 8) : st.x,
        y: !below ? st.y
          : st.anchor && st.anchor.top - r.height - 4 >= 8 ? st.anchor.top - r.height - 4
          : Math.max(8, vh - r.height - 8),
      });
      if (st.anchor) items()[0]?.focus();
      else menuEl.focus({ preventScroll: true });
    });
  });

  const items = () => Array.from(menuEl?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? []);

  const onMenuKey = (e: KeyboardEvent) => {
    const list = items();
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    let next = -1;
    if (e.key === "ArrowDown") next = i < 0 ? 0 : (i + 1) % list.length;
    else if (e.key === "ArrowUp") next = i < 0 ? list.length - 1 : (i - 1 + list.length) % list.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = list.length - 1;
    else if (e.key === "Tab") { e.preventDefault(); closeTrackMenu(); return; }
    else return;
    e.preventDefault();
    list[next].focus();
  };

  // Dismiss em click-outside / Esc — listeners só enquanto aberto.
  createEffect(() => {
    if (!trackMenu()) return;
    const onDown = (ev: PointerEvent) => {
      if (menuEl && !menuEl.contains(ev.target as Node)) closeTrackMenu();
    };
    // Esc pela pilha única (lib/escLayers): o menu é a camada de cima, fecha
    // antes da fila e do Tweaks, e o App não sai do cinema no mesmo toque.
    onCleanup(pushEscLayer(closeTrackMenu));
    // rAF: impede que o mesmo gesto que abriu o menu o feche imediatamente.
    const raf = requestAnimationFrame(() => {
      document.addEventListener("pointerdown", onDown, { capture: true });
    });
    onCleanup(() => {
      cancelAnimationFrame(raf);
      document.removeEventListener("pointerdown", onDown, { capture: true });
    });
  });

  const doPlay = () => {
    const st = trackMenu(); if (!st) return;
    if (st.onPlay) st.onPlay();
    else { setQueue([st.track], 0); playTrack(st.track); }
    closeTrackMenu();
  };

  // Inicia na faixa clicada e embaralha o resto da lista da view.
  const doShuffle = () => {
    const st = trackMenu(); if (!st || !st.list) return;
    const idx = Math.max(0, st.list.findIndex((t) => t.id === st.track.id));
    setQueue(st.list, idx, "curated");
    shuffleQueue();              // mantém a clicada em [0], embaralha o resto
    playTrack(st.track);
    closeTrackMenu();
  };

  const doPlayNext = () => {
    const st = trackMenu(); if (!st) return;
    enqueueNext(st.track); closeTrackMenu();
  };

  const doAddQueue = () => {
    const st = trackMenu(); if (!st) return;
    enqueueEnd(st.track); closeTrackMenu();
  };

  // Like NÃO fecha o menu — dá feedback imediato (label/ícone alternam).
  const doToggleLike = async () => {
    const st = trackMenu(); if (!st || !st.track.id) return;
    try {
      const now = await libToggleLike(st.track.id);
      setLikedLocal(now);
      if (player.currentTrack?.id === st.track.id) setLiked(now); // sincroniza PlayerBar
    } catch { /* no-op */ }
  };

  // Fecha ANTES de abrir o diálogo: o foco volta ao gatilho primeiro e o
  // diálogo o guarda como "quem me abriu" (senão guardaria o item do menu,
  // que some, e o foco cairia no <body> ao fechar o Mover).
  const doMove = () => {
    const st = trackMenu(); if (!st || !st.track.id) return;
    const tracks = multi() ?? [st.track];
    closeTrackMenu();
    openMoveDialog(tracks);
  };

  // Seleção múltipla: o menu age sobre as N faixas, não só sobre a clicada.
  const multi = () => {
    const sel = trackMenu()?.selection;
    return sel && sel.length > 1 ? sel : null;
  };
  const doPlayNextMulti = () => {
    const sel = multi(); if (!sel) return;
    enqueueNextMany(sel); clearSelection(); closeTrackMenu();
  };
  const doAddQueueMulti = () => {
    const sel = multi(); if (!sel) return;
    enqueueEndMany(sel); clearSelection(); closeTrackMenu();
  };

  const goAlbum = () => {
    const st = trackMenu(); if (!st?.track.album_title) return;
    navigate(`/album/${encodeURIComponent(st.track.album_title)}`);
    closeTrackMenu();
  };

  const goArtist = () => {
    const st = trackMenu(); if (!st?.track.artist_name) return;
    navigate(`/artist/${encodeURIComponent(st.track.artist_name)}`);
    closeTrackMenu();
  };

  return (
    <Show when={trackMenu()}>
      {(st) => (
        <Portal mount={document.body}>
          <div
            class="track-ctx-menu"
            ref={menuEl}
            style={{ left: `${pos().x}px`, top: `${pos().y}px` }}
            role="menu"
            aria-label={multi() ? `Ações de ${multi()!.length} faixas` : `Ações de ${st().track.title || "faixa"}`}
            tabIndex={-1}
            onKeyDown={onMenuKey}
          >
            <Show when={multi()} fallback={
              <>
            <button class="track-ctx-menu__item" type="button" onClick={doPlay} role="menuitem" tabIndex={-1}>
              <Icon name={ICONS.play} size={14} /><span>Play</span>
            </button>
            <Show when={(st().list?.length ?? 0) > 1}>
              <button class="track-ctx-menu__item" type="button" onClick={doShuffle} role="menuitem" tabIndex={-1}>
                <Icon name={ICONS.shuffle} size={14} /><span>Shuffle</span>
              </button>
            </Show>
            <button class="track-ctx-menu__item" type="button" onClick={doPlayNext} role="menuitem" tabIndex={-1}>
              <Icon name={ICONS.next} size={14} /><span>Play Next</span>
            </button>
            <button class="track-ctx-menu__item" type="button" onClick={doAddQueue} role="menuitem" tabIndex={-1}>
              <Icon name={ICONS.queue} size={14} /><span>Add to Queue</span>
            </button>

            <div class="track-ctx-menu__sep" />
            <button class="track-ctx-menu__item" type="button" onClick={doToggleLike} role="menuitem" tabIndex={-1}>
              <span class="track-ctx-menu__icon" data-liked={liked() ? "true" : "false"}>
                <Icon name={liked() ? ICONS.heartFilled : ICONS.heart} size={14} />
              </span>
              <span>{liked() ? "Unlike" : "Like"}</span>
            </button>

            <button class="track-ctx-menu__item" type="button" onClick={doMove} role="menuitem" tabIndex={-1}>
              <Icon name={ICONS.moveTo} size={14} /><span>Mover para playlist…</span>
            </button>

            <Show when={st().track.album_title || st().track.artist_name}>
              <div class="track-ctx-menu__sep" />
            </Show>
            <Show when={st().track.album_title}>
              <button class="track-ctx-menu__item" type="button" onClick={goAlbum} role="menuitem" tabIndex={-1}>
                <Icon name={ICONS.albums} size={14} /><span>Go to Album</span>
              </button>
            </Show>
            <Show when={st().track.artist_name}>
              <button class="track-ctx-menu__item" type="button" onClick={goArtist} role="menuitem" tabIndex={-1}>
                <Icon name={ICONS.artists} size={14} /><span>Go to Artist</span>
              </button>
            </Show>
              </>
            }>
              <button class="track-ctx-menu__item" type="button" onClick={doPlayNextMulti} role="menuitem" tabIndex={-1}>
                <Icon name={ICONS.next} size={14} /><span>{`Tocar ${multi()!.length} a seguir`}</span>
              </button>
              <button class="track-ctx-menu__item" type="button" onClick={doAddQueueMulti} role="menuitem" tabIndex={-1}>
                <Icon name={ICONS.queue} size={14} /><span>{`Adicionar ${multi()!.length} à fila`}</span>
              </button>
              <div class="track-ctx-menu__sep" />
              <button class="track-ctx-menu__item" type="button" onClick={doMove} role="menuitem" tabIndex={-1}>
                <Icon name={ICONS.moveTo} size={14} /><span>{moveLabel(multi()!.length)}</span>
              </button>
            </Show>
          </div>
        </Portal>
      )}
    </Show>
  );
}
