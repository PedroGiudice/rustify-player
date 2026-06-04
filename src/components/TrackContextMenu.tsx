// src/components/TrackContextMenu.tsx — menu de contexto de faixa (right-click).
// Reintroduz o antigo showTrackMenu (era src/js/components/context-menu.js,
// morto na migração pra Solid) como componente Solid reativo. Singleton
// montado UMA vez no App; o estado vive em store/contextMenu.
//
// Backend 100% compartilhado — mesmas funções que o CommandPalette usa:
//   setQueue / enqueueNext / enqueueEnd / shuffleQueue (store/player)
//   libToggleLike / libIsLiked (tauri)  ·  navigate (router)
// Zero comando Tauri novo.
import { Show, createSignal, createEffect, onCleanup } from "solid-js";
import { Portal } from "solid-js/web";
import { trackMenu, closeTrackMenu } from "../store/contextMenu";
import { libToggleLike, libIsLiked } from "../tauri";
import {
  setQueue, enqueueNext, enqueueEnd, shuffleQueue, player, setLiked,
} from "../store/player";
import { playTrack } from "./PlayerBar";
import { navigate } from "../router";
import { Icon, ICONS } from "./Icon";

export function TrackContextMenu() {
  let menuEl: HTMLDivElement | undefined;
  const [liked, setLikedLocal] = createSignal(false);
  const [pos, setPos] = createSignal<{ x: number; y: number }>({ x: 0, y: 0 });

  // Ao abrir: posiciona, pré-busca o estado de like, e reposiciona com clamp
  // ao viewport após o paint (pra não vazar pela borda).
  createEffect(() => {
    const st = trackMenu();
    if (!st) return;
    setPos({ x: st.x, y: st.y });
    if (st.track.id) {
      libIsLiked(st.track.id).then(setLikedLocal).catch(() => setLikedLocal(false));
    } else {
      setLikedLocal(false);
    }
    requestAnimationFrame(() => {
      if (!menuEl) return;
      const r = menuEl.getBoundingClientRect();
      const vw = window.innerWidth, vh = window.innerHeight;
      setPos({
        x: st.x + r.width > vw ? Math.max(8, vw - r.width - 8) : st.x,
        y: st.y + r.height > vh ? Math.max(8, vh - r.height - 8) : st.y,
      });
    });
  });

  // Dismiss em click-outside / Esc — listeners só enquanto aberto.
  createEffect(() => {
    if (!trackMenu()) return;
    const onDown = (ev: PointerEvent) => {
      if (menuEl && !menuEl.contains(ev.target as Node)) closeTrackMenu();
    };
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") closeTrackMenu();
    };
    // rAF: impede que o mesmo gesto que abriu o menu o feche imediatamente.
    const raf = requestAnimationFrame(() => {
      document.addEventListener("pointerdown", onDown, { capture: true });
      document.addEventListener("keydown", onKey);
    });
    onCleanup(() => {
      cancelAnimationFrame(raf);
      document.removeEventListener("pointerdown", onDown, { capture: true });
      document.removeEventListener("keydown", onKey);
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
          >
            <button class="track-ctx-menu__item" type="button" onClick={doPlay} role="menuitem">
              <Icon name={ICONS.play} size={15} /><span>Play</span>
            </button>
            <Show when={(st().list?.length ?? 0) > 1}>
              <button class="track-ctx-menu__item" type="button" onClick={doShuffle} role="menuitem">
                <Icon name={ICONS.shuffle} size={15} /><span>Shuffle</span>
              </button>
            </Show>
            <button class="track-ctx-menu__item" type="button" onClick={doPlayNext} role="menuitem">
              <Icon name={ICONS.next} size={15} /><span>Play Next</span>
            </button>
            <button class="track-ctx-menu__item" type="button" onClick={doAddQueue} role="menuitem">
              <Icon name={ICONS.queue} size={15} /><span>Add to Queue</span>
            </button>

            <div class="track-ctx-menu__sep" />
            <button class="track-ctx-menu__item" type="button" onClick={doToggleLike} role="menuitem">
              <Icon name={liked() ? ICONS.heartFilled : ICONS.heart} size={15} />
              <span>{liked() ? "Unlike" : "Like"}</span>
            </button>

            <Show when={st().track.album_title || st().track.artist_name}>
              <div class="track-ctx-menu__sep" />
            </Show>
            <Show when={st().track.album_title}>
              <button class="track-ctx-menu__item" type="button" onClick={goAlbum} role="menuitem">
                <Icon name={ICONS.albums} size={15} /><span>Go to Album</span>
              </button>
            </Show>
            <Show when={st().track.artist_name}>
              <button class="track-ctx-menu__item" type="button" onClick={goArtist} role="menuitem">
                <Icon name={ICONS.artists} size={15} /><span>Go to Artist</span>
              </button>
            </Show>
          </div>
        </Portal>
      )}
    </Show>
  );
}
