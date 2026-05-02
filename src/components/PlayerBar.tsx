/* ============================================================
   components/PlayerBar.tsx — Migra player-bar.js para Solid.

   Contrato preservado:
   - Todos os invoke() nomes idênticos ao backend Rust
   - Lógica de gapless (enqueueNext), autoplay, visibilitychange
   - Seek via pointerdown drag
   - Volume slider
   - Like button
   ============================================================ */

import { onMount, onCleanup, Show } from "solid-js";
import {
  player, setPlayer,
  applyTrackStarted, updatePosition, setPlayingState,
  setLiked, cycleRepeat, advanceQueue, retreatQueue,
  shuffleQueue, reconcileFromState, setQueue,
} from "../store/player";
import {
  playerPlay, playerPause, playerResume, playerSeek,
  playerEnqueueNext, playerSetOrigin,
  setVolume, libIsLiked, libToggleLike, libRecordPlay,
  libGetAlbum, libAutoplayNext, getState, cycleRepeat as ipcCycleRepeat,
  coverUrl, formatDuration, onPlayerState, onMprisCommand,
} from "../tauri";
import { showPlayerMenu } from "../js/components/context-menu.js";

const recentlyPlayedIds = new Set<number>();

export function PlayerBar() {
  let seekBarRef!: HTMLDivElement;
  let volBarRef!: HTMLDivElement;
  let unlistenPlayer: () => void;
  let unlistenMpris: () => void;

  onMount(async () => {
    unlistenPlayer = await onPlayerState(async (p) => {
      if ("TrackStarted" in p) {
        applyTrackStarted(p.TrackStarted);
        // Pre-load next para gapless
        const next = player.queue[player.queueIndex + 1];
        if (next) playerEnqueueNext(next.path).catch(console.error);

      } else if ("Position" in p) {
        updatePosition(p.Position.samples_played, p.Position.sample_rate);

      } else if ("StateChanged" in p) {
        const s = p.StateChanged;
        if (s === "Playing") setPlayingState(true);
        else if (s === "Paused") setPlayingState(false);
        else if (s === "Idle" || s === "Stopped") setPlayingState(false);

      } else if ("TrackEnded" in p) {
        const ended = player.currentTrack;
        if (ended?.id) {
          libRecordPlay(ended.id).catch(console.error);
          recentlyPlayedIds.add(ended.id);
          if (recentlyPlayedIds.size > 30) {
            recentlyPlayedIds.delete(recentlyPlayedIds.values().next().value);
          }
        }
        // Auto-advance
        const next = advanceQueue();
        if (next) {
          await playTrack(next, "album_seq");
        } else if (ended?.id) {
          await doAutoplay(ended.id);
        }
      }
    });

    unlistenMpris = await onMprisCommand(async (cmd) => {
      if (cmd === "next") {
        const next = advanceQueue();
        if (next) await playTrack(next, "queue");
        else if (player.currentTrack?.id) await doAutoplay(player.currentTrack.id);
      } else if (cmd === "previous") {
        const prev = retreatQueue();
        if (prev) await playTrack(prev, "queue");
      }
    });

    // Reconcilia estado quando janela volta ao foco
    document.addEventListener("visibilitychange", onVisibility);
    onCleanup(() => document.removeEventListener("visibilitychange", onVisibility));
  });

  onCleanup(() => {
    unlistenPlayer?.();
    unlistenMpris?.();
  });

  async function onVisibility() {
    if (document.visibilityState !== "visible") return;
    try {
      const snap = await getState();
      reconcileFromState(snap.current_library_track, snap.is_playing);
    } catch (e) {
      console.warn("[player] visibility sync failed:", e);
    }
  }

  async function doAutoplay(seedId: number) {
    try {
      const tracks = await libAutoplayNext(seedId, [...recentlyPlayedIds], 5);
      if (!tracks.length) return;
      // Append new tracks to queue and advance index by 1 (same as vanilla)
      const newQueue = [...player.queue, ...tracks];
      const newIndex = player.queueIndex + 1;
      setQueue(newQueue, newIndex);
      const next = newQueue[newIndex];
      if (next) await playTrack(next, "autoplay");
    } catch (e) {
      console.error("[autoplay] failed:", e);
    }
  }

  // ── Seek ──────────────────────────────────────────────────────

  function onSeekPointerDown(e: PointerEvent) {
    if (!player.currentTrack || !player.durationSecs) return;
    setPlayer("isScrubbing", true);
    updateFromSeekEvent(e);

    const onMove = (ev: PointerEvent) => updateFromSeekEvent(ev);
    const onUp = (ev: PointerEvent) => {
      setPlayer("isScrubbing", false);
      updateFromSeekEvent(ev);
      playerSeek(player.positionSecs).catch(console.error);
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function updateFromSeekEvent(e: PointerEvent) {
    const rect = seekBarRef.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    setPlayer("positionSecs", pct * player.durationSecs);
  }

  // ── Volume ─────────────────────────────────────────────────────

  function onVolPointerDown(e: PointerEvent) {
    const update = (ev: PointerEvent) => {
      const rect = volBarRef.getBoundingClientRect();
      const vol = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      setPlayer("volume", vol);
      setPlayer("isMuted", false);
      setVolume(vol).catch(console.error);
    };
    update(e);
    const onMove = (ev: PointerEvent) => update(ev);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function toggleMute() {
    const muted = !player.isMuted;
    setPlayer("isMuted", muted);
    setVolume(muted ? 0 : player.volume).catch(console.error);
  }

  // ── Like ───────────────────────────────────────────────────────

  async function onLike() {
    if (!player.currentTrack?.id) return;
    try {
      const liked = await libToggleLike(player.currentTrack.id);
      setLiked(liked);
    } catch (e) {
      console.error("[like] toggle failed:", e);
    }
  }

  // ── Derived ────────────────────────────────────────────────────

  const pct = () =>
    player.durationSecs ? (player.positionSecs / player.durationSecs) * 100 : 0;

  const volPct = () => (player.isMuted ? 0 : player.volume * 100);

  return (
    <footer class="player-bar" id="player-bar">

      {/* ── Esquerdo: cover + meta + like ── */}
      <div class="player-bar__block player-bar__block--left">
        <div class={`album-cover-empty${player.currentTrack?.album_cover_path ? "" : ""}`} id="pb-cover">
          <Show when={player.currentTrack?.album_cover_path}>
            {(path) => <img src={coverUrl(path())} alt="" />}
          </Show>
        </div>

        <div class="player-bar__track-meta">
          <span class="player-bar__track-label" id="pb-label">
            <svg class="icon icon--sm" aria-hidden="true">
              <use href={player.isPlaying ? "#icon-music-note" : "#icon-pause"} />
            </svg>
            {player.isPlaying ? "Playing" : player.currentTrack ? "Paused" : "No Track"}
          </span>
          <span class="player-bar__track-title" id="pb-title">
            {player.currentTrack?.title ?? "—"}
          </span>
          <span class="player-bar__track-artist" id="pb-artist">
            {player.currentTrack?.artist_name ?? "—"}
          </span>
        </div>

        <Show when={player.currentTrack}>
          <button
            class={`icon-btn like-btn${player.isLiked ? " is-liked" : ""}`}
            id="pb-like"
            aria-label="Like"
            aria-pressed={player.isLiked}
            onClick={onLike}
          >
            <svg class="icon" aria-hidden="true"><use href="#icon-flame" /></svg>
          </button>
          <button
            class="icon-btn"
            id="pb-more"
            aria-label="More options"
            onClick={(e) => { if (player.currentTrack) showPlayerMenu(e, player.currentTrack); }}
          >
            <svg class="icon" aria-hidden="true"><use href="#icon-more-vertical" /></svg>
          </button>
        </Show>
      </div>

      {/* ── Centro: transport + seek ── */}
      <div class="player-bar__block player-bar__block--center">
        <div class="player-bar__controls">
          <button
            class={`icon-btn icon-btn--toggle${player.shuffle ? " is-active" : ""}`}
            id="pb-shuffle"
            aria-label="Shuffle"
            onClick={() => {
              setPlayer("shuffle", (s) => !s);
              if (!player.shuffle) shuffleQueue();
            }}
          >
            <svg class="icon" aria-hidden="true"><use href="#icon-shuffle" /></svg>
            <span class="icon-btn__pip" />
          </button>

          <button
            class="icon-btn"
            id="pb-prev"
            aria-disabled={player.queueIndex <= 0}
            aria-label="Previous"
            onClick={() => { const t = retreatQueue(); if (t) playTrack(t, "queue"); }}
          >
            <svg class="icon" aria-hidden="true"><use href="#icon-skip-previous" /></svg>
          </button>

          <button
            class="icon-btn icon-btn--primary"
            id="pb-play-pause"
            aria-disabled={!player.currentTrack}
            aria-label={player.isPlaying ? "Pause" : "Play"}
            onClick={() => {
              if (player.isPlaying) {
                setPlayingState(false);
                playerPause().catch(console.error);
              } else {
                setPlayingState(true);
                playerResume().catch(console.error);
              }
            }}
          >
            <svg class="icon icon--filled" aria-hidden="true">
              <use href={player.isPlaying ? "#icon-pause" : "#icon-play"} />
            </svg>
          </button>

          <button
            class="icon-btn"
            id="pb-next"
            aria-disabled={player.queueIndex >= player.queue.length - 1}
            aria-label="Next"
            onClick={() => { const t = advanceQueue(); if (t) playTrack(t, "queue"); }}
          >
            <svg class="icon" aria-hidden="true"><use href="#icon-skip-next" /></svg>
          </button>

          <button
            class={`icon-btn icon-btn--toggle${player.repeatMode !== "off" ? " is-active" : ""}`}
            id="pb-repeat"
            aria-label="Repeat"
            onClick={() => { cycleRepeat(); ipcCycleRepeat().catch(console.error); }}
          >
            <svg class="icon" aria-hidden="true"><use href="#icon-repeat" /></svg>
            <span class="icon-btn__pip" />
            <Show when={player.repeatMode === "one"}>
              <span class="icon-btn__badge">1</span>
            </Show>
          </button>
        </div>

        {/* Seek bar */}
        <div class="player-bar__seek">
          <span class="player-bar__time" id="pb-time-current">
            {formatDuration(player.positionSecs)}
          </span>
          <div
            class="progress"
            id="pb-progress"
            ref={seekBarRef}
            aria-label="Seek"
            onPointerDown={onSeekPointerDown}
          >
            <div class="progress__fill" id="pb-progress-fill" style={{ width: `${pct()}%` }} />
            <div class="progress__thumb" id="pb-progress-thumb" style={{ left: `${pct()}%` }} />
          </div>
          <span class="player-bar__time player-bar__time--right" id="pb-time-total">
            {formatDuration(player.durationSecs)}
          </span>
        </div>
      </div>

      {/* ── Direito: tech info + volume ── */}
      <div class="player-bar__block player-bar__block--right">
        <div class="player-bar__tech">
          <div class={`tech-badge${player.techInfo.format === "—" ? " tech-badge--dim" : ""}`} id="pb-tech-badge">
            {player.techInfo.format}
          </div>
          <div class="player-bar__tech-line" id="pb-tech-line">
            {player.techInfo.bitDepth ? `${player.techInfo.bitDepth}bit` : "—"} / {player.techInfo.sampleRate ? `${player.techInfo.sampleRate / 1000}kHz` : "—"}
          </div>
        </div>

        <div class="volume">
          <button class="icon-btn" id="pb-vol-btn" aria-label="Volume" onClick={toggleMute}>
            <svg class="icon" aria-hidden="true">
              <use href={player.isMuted ? "#icon-volume-mute" : "#icon-volume"} />
            </svg>
          </button>
          <div
            class="progress"
            id="pb-vol-progress"
            ref={volBarRef}
            aria-label="Volume"
            onPointerDown={onVolPointerDown}
          >
            <div class="progress__fill" id="pb-vol-fill" style={{ width: `${volPct()}%` }} />
          </div>
        </div>
      </div>
    </footer>
  );
}

// ── playTrack — equivalente ao playTrack() de player-bar.js ───

export async function playTrack(track: import("../tauri").Track, origin = "manual") {
  setPlayer({
    currentTrack: track,
    durationSecs: (track.duration_ms ?? 0) / 1000,
    positionSecs: 0,
    isTransitioning: true,
  });

  // Like state
  if (track.id) {
    libIsLiked(track.id).then(setLiked).catch(() => setLiked(false));
  } else {
    setLiked(false);
  }

  playerPlay(track.path, origin, track.id ?? null).catch((e) =>
    console.error("[player] play failed:", e)
  );

  if (track.id) {
    libRecordPlay(track.id).catch(console.error);
  }
}
