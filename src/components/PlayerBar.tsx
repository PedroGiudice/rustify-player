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
import { dsp } from "../store/dsp";
import { tweaks, updateTweak } from "../store/tweaks";
import {
  playerPlay, playerPause, playerResume, playerSeek,
  playerEnqueueNext, playerSetOrigin, playerLoadPaused,
  setVolume, libIsLiked, libToggleLike, libRecordPlay,
  libAutoplayNext, getState, cycleRepeat as ipcCycleRepeat,
  coverUrl, formatDuration, onPlayerState, onMprisCommand,
  persistLoadState, persistSaveState, libGetTracksByIds,
} from "../tauri";
import { showPlayerMenu } from "../js/components/context-menu.js";
import { Icon, ICONS } from "./Icon";
import { CoverArt } from "./CoverArt";
import { CMD_PALETTE_EVENT } from "./CommandPalette";
import { QUEUE_EVENT } from "./QueueDrawer";
import { navigate } from "../router";

// Re-export para que outros call-sites possam importar daqui.
export { CMD_PALETTE_EVENT };

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

  onMount(() => {
    // ── Listeners/timers DOM: registro sincrono, antes de qualquer await ──
    // onCleanup so registra dentro do owner do Solid; chamado apos um await
    // dentro de onMount(async) ele roda fora do owner e vira no-op (os
    // cleanups nunca executariam).

    // Bridge: vanilla search-bar dispatches this event to play a track
    const onSearchPlay = (e: Event) => {
      const { track, queue, index } = (e as CustomEvent).detail;
      setQueue(queue, index);
      playTrack(track, "search");
    };
    window.addEventListener("search-play-track", onSearchPlay);

    // Reconcilia estado quando janela volta ao foco
    document.addEventListener("visibilitychange", onVisibility);

    // Periodic save covers crashes. Event-driven saves (track
    // change, pause, seek, beforeunload) cover graceful shutdown.
    // (saveSession e no-op sem currentTrack, entao ticks antes do
    // restoreSession abaixo nao gravam nada.)
    const saveTimer = window.setInterval(() => {
      void saveSession();
    }, SAVE_INTERVAL_MS);

    const onBeforeUnload = () => {
      void saveSession();
    };
    window.addEventListener("beforeunload", onBeforeUnload);

    onCleanup(() => {
      window.removeEventListener("search-play-track", onSearchPlay);
      document.removeEventListener("visibilitychange", onVisibility);
      window.clearInterval(saveTimer);
      window.removeEventListener("beforeunload", onBeforeUnload);
    });

    // ── Setup assincrono (IPC listeners + session resume) ──
    // Os unlisteners vao pra vars capturadas pelo onCleanup externo
    // (registrado sincronamente no corpo do componente).
    setupAsync().catch((e) => console.error("[player] setup failed:", e));
  });

  async function setupAsync() {
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

    // ── Session resume ────────────────────────────────────────
    // Restore the previous session in paused state. The backend
    // already filtered out snapshots older than 6h, so anything
    // returned is "fresh enough" to be useful.
    await restoreSession();
  }

  onCleanup(() => {
    unlistenPlayer?.();
    unlistenMpris?.();
  });

  async function restoreSession() {
    try {
      const snap = await persistLoadState();
      if (!snap || snap.queue_ids.length === 0 || snap.track_id == null) return;
      const tracks = await libGetTracksByIds(snap.queue_ids);
      if (tracks.length === 0) return;
      // The library may have moved on (tracks deleted, re-indexed).
      // Rebuild the queue with whatever survived and pin the index to
      // the current track if it's still there; otherwise bail.
      const newIndex = tracks.findIndex((t) => t.id === snap.track_id);
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
      for (const id of snap.recently_played) recentlyPlayedIds.add(id);
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
      // IDs como string end-to-end: Qdrant point IDs sao u64 hashes que
      // estouram Number.MAX_SAFE_INTEGER. Converter pra Number trunca.
      await persistSaveState({
        track_id: player.currentTrack.id,
        position_ms: Math.floor(player.positionSecs * 1000),
        queue_ids: player.queue.map((t) => t.id).filter((id): id is string => !!id),
        queue_index: player.queueIndex,
        shuffle: player.shuffle,
        repeat_mode: player.repeatMode,
        recently_played: Array.from(recentlyPlayedIds),
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
      // Lookahead 1: cada nova track usa a anterior como seed e o
      // behavioral mais recente. Sem isso, uma chamada com limit>1
      // pré-computa uma queue que envelhece — a 5ª track ainda
      // reflete a vibe da 1ª, sem influência do que aconteceu no meio.
      const tracks = await libAutoplayNext(seedId, [...recentlyPlayedIds], 1);
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
      // Lookahead 1 — mesma razão de doAutoplay. Disparado quando o
      // player chega às 2 últimas posições da queue (ver TrackEnded
      // handler). Garante 1 track sempre à frente, recalculada com
      // base no que toca agora.
      const tracks = await libAutoplayNext(seedId, [...recentlyPlayedIds], 1);
      if (!tracks.length) return;
      setQueue([...player.queue, ...tracks], player.queueIndex);
    } catch (e) {
      console.error("[shuffle] radio prefetch failed:", e);
    }
  }

  // Adaptive shuffle baseado no queueScope:
  // - "curated" (playlist, station): embaralha a propria queue mantendo
  //   o contexto. O usuario montou ou abriu essa lista de proposito.
  // - "open" (history, library, search, home suggestions): entra em radio
  //   mode -- descarta a queue e repopula com [current, ...autoplayNext()].
  //   Sem isso, clicar shuffle no historico ficava "shuffle do historico"
  //   em vez de uma estacao a partir da track atual.
  // Caso de borda: queue == [current] (1 track so) sempre vira radio,
  // independente do scope -- nao ha o que embaralhar.
  // Turning shuffle off: mantem queue como esta, so para de top-up.
  async function toggleShuffle() {
    const turningOn = !player.shuffle;
    setPlayer("shuffle", turningOn);
    if (!turningOn) return;

    const isCurated = player.queueScope === "curated";
    if (isCurated && player.queue.length > 1) {
      shuffleQueue();
      return;
    }

    // Open scope OR single-track queue: virar radio com a track atual.
    // Lookahead 1 — o prefetchRadio no TrackEnded vai sustentar a
    // queue daqui pra frente, sempre com 1 track à frente recalculada
    // a partir do que toca agora.
    const seed = player.currentTrack?.id;
    if (!seed) return;
    try {
      const recs = await libAutoplayNext(seed, [...recentlyPlayedIds], 1);
      if (!recs.length) return;
      const current = player.currentTrack!;
      setQueue([current, ...recs], 0, "open");
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

  // DSP chain summary mostrado na tech pill. Reage ao store de dsp,
  // entao toggles na view Signal aparecem aqui imediatamente.
  const dspSummary = () => {
    if (dsp.bypass) return "BYPASS";
    const parts: string[] = [];
    if (dsp.eq.enabled) parts.push("EQ");
    if (dsp.limiter.enabled) parts.push("LIM");
    if (dsp.bass.enabled) parts.push("BASS");
    return parts.length ? parts.join(" · ") : "DSP OFF";
  };

  return (
    <footer class="playerbar" id="player-bar" data-screen-label="Player Bar">

      {/* ── Esquerdo: cover + meta + like + more ── */}
      <div class="pb-left">
        <Show
          when={player.currentTrack}
          fallback={
            <CoverArt
              seed="empty"
              size="sm"
              class="pb-cover"
              style={{ width: "44px", height: "44px" }}
            />
          }
        >
          {(track) => (
            <CoverArt
              seed={track().album_title || track().id}
              src={coverUrl(track().album_cover_path)}
              size="sm"
              class="pb-cover"
              style={{ width: "44px", height: "44px" }}
            />
          )}
        </Show>

        <div
          class="pb-meta"
          onClick={() => navigate("/now-playing")}
          onContextMenu={(e) => {
            if (player.currentTrack) showPlayerMenu(e, player.currentTrack);
          }}
        >
          <span class="pb-title" id="pb-title">
            {player.currentTrack?.title ?? "—"}
          </span>
          <span class="pb-artist" id="pb-artist">
            {player.currentTrack?.artist_name ?? "—"}
            <Show when={player.currentTrack?.album_title}>
              {(album) => <> · {album()}</>}
            </Show>
          </span>
        </div>

        <Show when={player.currentTrack}>
          <button
            class="pb-icon-btn pb-like"
            id="pb-like"
            aria-label="Like"
            aria-pressed={player.isLiked ? "true" : "false"}
            title="Like"
            onClick={onLike}
          >
            <Icon name={player.isLiked ? ICONS.heartFilled : ICONS.heart} size={14} />
          </button>
          <button
            class="pb-icon-btn"
            id="pb-more"
            aria-label="More"
            title="More"
            onClick={(e) => { if (player.currentTrack) showPlayerMenu(e, player.currentTrack); }}
          >
            <Icon name={ICONS.more} size={14} />
          </button>
        </Show>
      </div>

      {/* ── Centro: transport + seek ── */}
      <div class="pb-center">
        <div class="pb-transport">
          <button
            class="pb-btn"
            id="pb-shuffle"
            aria-label="Shuffle"
            aria-pressed={player.shuffle ? "true" : "false"}
            title="Shuffle"
            onClick={toggleShuffle}
          >
            <Icon name={ICONS.shuffle} size={14} />
          </button>

          <button
            class="pb-btn"
            id="pb-prev"
            aria-disabled={player.queueIndex <= 0}
            aria-label="Previous"
            title="Previous"
            onClick={() => { const t = retreatQueue(); if (t) playTrack(t, "queue"); }}
          >
            <Icon name={ICONS.prev} size={14} />
          </button>

          <button
            class="pb-btn pb-btn--primary"
            id="pb-play-pause"
            aria-disabled={!player.currentTrack}
            aria-label={player.isPlaying ? "Pause" : "Play"}
            title={player.isPlaying ? "Pause" : "Play"}
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
            <Icon name={player.isPlaying ? ICONS.pause : ICONS.play} size={12} />
          </button>

          <button
            class="pb-btn"
            id="pb-next"
            aria-disabled={player.queueIndex >= player.queue.length - 1}
            aria-label="Next"
            title="Next"
            onClick={() => { const t = advanceQueue(); if (t) playTrack(t, "queue"); }}
          >
            <Icon name={ICONS.next} size={14} />
          </button>

          <button
            class="pb-btn"
            id="pb-repeat"
            aria-label="Repeat"
            aria-pressed={player.repeatMode !== "off" ? "true" : "false"}
            data-repeat-mode={player.repeatMode}
            title={`Repeat: ${player.repeatMode}`}
            onClick={() => { cycleRepeat(); ipcCycleRepeat().catch(console.error); }}
          >
            <Icon name={player.repeatMode === "one" ? ICONS.repeatOne : ICONS.repeat} size={14} />
          </button>
        </div>

        <div class="pb-seek">
          <span class="pb-time" id="pb-time-current">
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
          <span class="pb-time" id="pb-time-total">
            {formatDuration(player.durationSecs)}
          </span>
        </div>
      </div>

      {/* ── Direito: tech pill + queue + volume ── */}
      <div class="pb-right">
        <Show when={player.techInfo.format && player.techInfo.format !== "—"}>
          <div class="pb-tech" id="pb-tech" title="Signal path">
            <span class="pb-tech__dot" />
            <span>
              {player.techInfo.format}
              <Show when={player.techInfo.bitDepth && player.techInfo.sampleRate}>
                {" "}
                {player.techInfo.bitDepth}/{Math.round((player.techInfo.sampleRate ?? 0) / 1000)}
              </Show>
            </span>
            <span class="pb-tech__sep">·</span>
            <span>{dspSummary()}</span>
          </div>
        </Show>

        <button
          class="pb-btn"
          id="pb-lyrics"
          title={tweaks().lyricsVisible ? "Hide lyrics" : "Show lyrics"}
          aria-label="Toggle lyrics"
          aria-pressed={tweaks().lyricsVisible}
          onClick={() => updateTweak("lyricsVisible", !tweaks().lyricsVisible)}
        >
          <Icon name={ICONS.lyrics} size={14} />
        </button>

        <button
          class="pb-btn"
          id="pb-queue"
          title="Queue (Q)"
          aria-label="Queue"
          onClick={() => window.dispatchEvent(new CustomEvent(QUEUE_EVENT))}
        >
          <Icon name={ICONS.queue} size={14} />
        </button>

        <div class="pb-vol">
          <button class="pb-btn" id="pb-vol-btn" aria-label="Volume" title="Mute" onClick={toggleMute}>
            <Icon name={player.isMuted ? ICONS.volumeMute : ICONS.volume} size={14} />
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
