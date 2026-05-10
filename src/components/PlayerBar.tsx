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
  playerEnqueueNext, playerSetOrigin, playerLoadPaused,
  setVolume, libIsLiked, libToggleLike, libRecordPlay,
  libAutoplayNext, getState, cycleRepeat as ipcCycleRepeat,
  coverUrl, formatDuration, onPlayerState, onMprisCommand,
  persistLoadState, persistSaveState, libGetTracksByIds,
} from "../tauri";
import { showPlayerMenu } from "../js/components/context-menu.js";

const recentlyPlayedIds = new Set<string>();

// Throttle disk writes — saving every position tick would be wasteful;
// every 10s plus lifecycle events (track change, pause, seek, beforeunload)
// is enough to cover any reasonable crash/close scenario.
const SAVE_INTERVAL_MS = 10_000;

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
        void saveSession();

      } else if ("Position" in p) {
        updatePosition(p.Position.samples_played, p.Position.sample_rate);

      } else if ("StateChanged" in p) {
        const s = p.StateChanged;
        if (s === "Playing") setPlayingState(true);
        else if (s === "Paused") { setPlayingState(false); void saveSession(); }
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
          // Radio mode: top up the queue before it runs dry so playback
          // stays continuous without a Qdrant roundtrip gap at the end.
          if (
            player.shuffle &&
            player.queueIndex >= player.queue.length - 2 &&
            next.id
          ) {
            void prefetchRadio(next.id);
          }
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

    // Bridge: vanilla search-bar dispatches this event to play a track
    const onSearchPlay = (e: Event) => {
      const { track, queue, index } = (e as CustomEvent).detail;
      setQueue(queue, index);
      playTrack(track, "search");
    };
    window.addEventListener("search-play-track", onSearchPlay);
    onCleanup(() => window.removeEventListener("search-play-track", onSearchPlay));

    // Reconcilia estado quando janela volta ao foco
    document.addEventListener("visibilitychange", onVisibility);
    onCleanup(() => document.removeEventListener("visibilitychange", onVisibility));

    // ── Session resume ────────────────────────────────────────
    // Restore the previous session in paused state. The backend
    // already filtered out snapshots older than 6h, so anything
    // returned is "fresh enough" to be useful.
    await restoreSession();

    // Periodic save covers crashes. Event-driven saves (track
    // change, pause, seek, beforeunload) cover graceful shutdown.
    const saveTimer = window.setInterval(() => {
      void saveSession();
    }, SAVE_INTERVAL_MS);
    onCleanup(() => window.clearInterval(saveTimer));

    const onBeforeUnload = () => {
      void saveSession();
    };
    window.addEventListener("beforeunload", onBeforeUnload);
    onCleanup(() => window.removeEventListener("beforeunload", onBeforeUnload));
  });

  onCleanup(() => {
    unlistenPlayer?.();
    unlistenMpris?.();
  });

  async function restoreSession() {
    try {
      const snap = await persistLoadState();
      if (!snap || snap.queue_ids.length === 0 || snap.track_id == null) return;
      const tracks = await libGetTracksByIds(snap.queue_ids.map(String));
      if (tracks.length === 0) return;
      // The library may have moved on (tracks deleted, re-indexed).
      // Rebuild the queue with whatever survived and pin the index to
      // the current track if it's still there; otherwise bail.
      const wantedId = String(snap.track_id);
      const newIndex = tracks.findIndex((t) => t.id === wantedId);
      if (newIndex < 0) return;
      setQueue(tracks, newIndex);
      setPlayer({
        shuffle: snap.shuffle,
        repeatMode: (snap.repeat_mode as "off" | "all" | "one") ?? "off",
        positionSecs: snap.position_ms / 1000,
        durationSecs: (tracks[newIndex].duration_ms ?? 0) / 1000,
      });
      // Repopulate the recently-played exclusion set so autoplay/radio
      // don't immediately suggest tracks the user heard last session.
      for (const id of snap.recently_played) recentlyPlayedIds.add(String(id));
      const current = tracks[newIndex];
      await playerLoadPaused(current.path, snap.position_ms, current.id);
      if (current.id) {
        libIsLiked(current.id).then(setLiked).catch(() => setLiked(false));
      }
    } catch (e) {
      console.warn("[resume] failed:", e);
    }
  }

  async function saveSession() {
    if (!player.currentTrack?.id) return;
    try {
      await persistSaveState({
        track_id: Number(player.currentTrack.id),
        position_ms: Math.floor(player.positionSecs * 1000),
        queue_ids: player.queue.map((t) => Number(t.id)).filter((n) => !Number.isNaN(n)),
        queue_index: player.queueIndex,
        shuffle: player.shuffle,
        repeat_mode: player.repeatMode,
        recently_played: Array.from(recentlyPlayedIds)
          .map((s) => Number(s))
          .filter((n) => !Number.isNaN(n)),
        saved_at: Math.floor(Date.now() / 1000),
      });
    } catch (e) {
      console.warn("[resume] save failed:", e);
    }
  }

  async function onVisibility() {
    if (document.visibilityState !== "visible") return;
    try {
      const snap = await getState();
      reconcileFromState(snap.current_library_track, snap.is_playing);
    } catch (e) {
      console.warn("[player] visibility sync failed:", e);
    }
  }

  async function doAutoplay(seedId: string) {
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

  // Radio top-up: while shuffle is on and the queue is running dry, append
  // fresh recommendations seeded by the current track so playback continues
  // gaplessly. Distinct from doAutoplay, which only fires when the queue
  // hits zero and forces a track switch.
  async function prefetchRadio(seedId: string) {
    try {
      const tracks = await libAutoplayNext(seedId, [...recentlyPlayedIds], 5);
      if (!tracks.length) return;
      setQueue([...player.queue, ...tracks], player.queueIndex);
    } catch (e) {
      console.error("[shuffle] radio prefetch failed:", e);
    }
  }

  // Adaptive shuffle:
  // - Queue has >1 track: shuffle the existing queue (album / playlist scope).
  // - Queue has only the current track: enter radio mode by seeding the
  //   queue with autoplay recommendations from the current track. Gives
  //   immediate visual feedback (queue fills) and avoids a silent gap at EOS.
  // - Turning shuffle off: keep the queue as-is, just stop topping it up.
  async function toggleShuffle() {
    const turningOn = !player.shuffle;
    setPlayer("shuffle", turningOn);
    if (!turningOn) return;
    if (player.queue.length > 1) {
      shuffleQueue();
      return;
    }
    const seed = player.currentTrack?.id;
    if (!seed) return;
    try {
      const recs = await libAutoplayNext(seed, [...recentlyPlayedIds], 10);
      if (!recs.length) return;
      const current = player.currentTrack!;
      setQueue([current, ...recs], 0);
    } catch (e) {
      console.error("[shuffle] radio populate failed:", e);
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
            onClick={toggleShuffle}
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
