// Player bar — three-block layout: left (cover+meta), center (transport+seek), right (tech+volume).
// Preserves all Tauri IPC contracts. Adds shuffle, repeat, volume, drag-to-seek.
//
// Time-unit convention:
//   • Library `Track` objects use `duration_ms` (matches backend serde).
//   • Engine `TrackInfo.duration` arrives as a Rust `Duration`, which serde
//     serializes as `{ secs, nanos }`. We read `.secs` directly.
//   • Internal state (`durationSecs`, `currentSecs`) and the local
//     `formatDuration` helper work in SECONDS, aligned with `PositionUpdate`
//     events (`samples_played / sample_rate`) and the scrub math.
//   • Conversions happen at the boundary: `track.duration_ms / 1000` before
//     writing to `durationSecs` or feeding `formatDuration`.
// Other views use `formatMs` from `utils/format.js`; the player-bar is the
// one place that stays in seconds because the engine itself does.

const { listen } = window.__TAURI__.event;
const { invoke, convertFileSrc } = window.__TAURI__.core;

let currentTrack = null;
let trackQueue = [];
let queueIndex = -1;
let ui = {};
let isPlaying = false;
let durationSecs = 0;
let currentSecs = 0;
let isScrubbing = false;
let autoplayEnabled = true;
const recentlyPlayedIds = new Set();

export function setQueue(tracks, startIndex) {
  trackQueue = tracks;
  queueIndex = startIndex;
}

export function getQueue() {
  return { tracks: trackQueue, position: queueIndex };
}

export function setAutoplay(enabled) {
  autoplayEnabled = enabled;
}

async function autoplayNext(seedTrack) {
  try {
    let candidates = await invoke("lib_similar", { trackId: seedTrack.id, limit: 10 });
    // lib_similar returns [{track, score}]
    let tracks = candidates
      .map((c) => c.track)
      .filter((t) => !recentlyPlayedIds.has(t.id));

    // Fallback to shuffle if no similar tracks (missing embeddings)
    if (tracks.length === 0) {
      tracks = await invoke("lib_shuffle", { limit: 10 });
      tracks = tracks.filter((t) => !recentlyPlayedIds.has(t.id));
    }

    if (tracks.length === 0) return;

    // Append to queue and advance
    const nextBatch = tracks.slice(0, 5);
    trackQueue.push(...nextBatch);
    queueIndex++;
    currentTrack = trackQueue[queueIndex];

    playTrack(currentTrack);
  } catch (err) {
    console.error("[autoplay] failed:", err);
  }
}

export function mountPlayerBar(root) {
  root.innerHTML = `
    <div class="player-bar__block player-bar__block--left">
      <div class="album-cover-empty" id="pb-cover" aria-hidden="true"></div>
      <div class="player-bar__track-meta">
        <span class="player-bar__track-label" id="pb-label">
          <svg class="icon icon--sm" aria-hidden="true"><use href="#icon-music-note"></use></svg>
          No Track
        </span>
        <span class="player-bar__track-title" id="pb-title">\u2014</span>
        <span class="player-bar__track-artist" id="pb-artist">\u2014</span>
      </div>
    </div>

    <div class="player-bar__block player-bar__block--center">
      <div class="player-bar__controls">
        <button class="icon-btn icon-btn--toggle" id="pb-shuffle" aria-label="Shuffle">
          <svg class="icon" aria-hidden="true"><use href="#icon-shuffle"></use></svg>
          <span class="icon-btn__pip"></span>
        </button>
        <button class="icon-btn" id="pb-prev" aria-disabled="true" aria-label="Previous">
          <svg class="icon" aria-hidden="true"><use href="#icon-skip-previous"></use></svg>
        </button>
        <button class="icon-btn icon-btn--primary" id="pb-play-pause" aria-disabled="true" aria-label="Play">
          <svg class="icon icon--filled" aria-hidden="true"><use href="#icon-play"></use></svg>
        </button>
        <button class="icon-btn" id="pb-next" aria-disabled="true" aria-label="Next">
          <svg class="icon" aria-hidden="true"><use href="#icon-skip-next"></use></svg>
        </button>
        <button class="icon-btn icon-btn--toggle" id="pb-repeat" aria-label="Repeat" data-mode="off">
          <svg class="icon" aria-hidden="true"><use href="#icon-repeat"></use></svg>
          <span class="icon-btn__pip"></span>
          <span class="icon-btn__badge">1</span>
        </button>
      </div>
      <div class="player-bar__seek">
        <span class="player-bar__time" id="pb-time-current">0:00</span>
        <div class="progress" id="pb-progress" aria-label="Seek">
          <div class="progress__fill" id="pb-progress-fill" style="width: 0%"></div>
          <div class="progress__thumb" id="pb-progress-thumb" style="left: 0%"></div>
        </div>
        <span class="player-bar__time player-bar__time--right" id="pb-time-total">0:00</span>
      </div>
    </div>

    <div class="player-bar__block player-bar__block--right">
      <div class="player-bar__tech">
        <div class="tech-badge tech-badge--dim" id="pb-tech-badge">\u2014</div>
        <div class="player-bar__tech-line" id="pb-tech-line">\u2014 / \u2014</div>
      </div>
      <div class="volume">
        <button class="icon-btn" id="pb-vol-btn" aria-label="Volume">
          <svg class="icon" aria-hidden="true"><use href="#icon-volume"></use></svg>
        </button>
        <div class="progress" id="pb-vol-progress" aria-label="Volume">
          <div class="progress__fill" id="pb-vol-fill" style="width: 78%"></div>
        </div>
      </div>
    </div>
  `;

  cacheUI(root);
  bindTransport();
  bindSeek();
  bindVolume();
  listenEngine();
}

function cacheUI(root) {
  ui = {
    cover: root.querySelector("#pb-cover"),
    label: root.querySelector("#pb-label"),
    title: root.querySelector("#pb-title"),
    artist: root.querySelector("#pb-artist"),
    playPauseBtn: root.querySelector("#pb-play-pause"),
    prevBtn: root.querySelector("#pb-prev"),
    nextBtn: root.querySelector("#pb-next"),
    shuffleBtn: root.querySelector("#pb-shuffle"),
    repeatBtn: root.querySelector("#pb-repeat"),
    timeCurrent: root.querySelector("#pb-time-current"),
    timeTotal: root.querySelector("#pb-time-total"),
    progressFill: root.querySelector("#pb-progress-fill"),
    progressThumb: root.querySelector("#pb-progress-thumb"),
    progressBar: root.querySelector("#pb-progress"),
    techBadge: root.querySelector("#pb-tech-badge"),
    techLine: root.querySelector("#pb-tech-line"),
    volBtn: root.querySelector("#pb-vol-btn"),
    volProgress: root.querySelector("#pb-vol-progress"),
    volFill: root.querySelector("#pb-vol-fill"),
  };
}

function bindTransport() {
  ui.playPauseBtn.addEventListener("click", () => {
    if (ui.playPauseBtn.getAttribute("aria-disabled") === "true") return;
    if (isPlaying) {
      invoke("player_pause");
    } else {
      invoke("player_resume");
    }
  });

  ui.prevBtn.addEventListener("click", () => {
    if (ui.prevBtn.getAttribute("aria-disabled") === "true") return;
    if (queueIndex > 0) {
      queueIndex--;
      playTrack(trackQueue[queueIndex]);
    }
  });

  ui.nextBtn.addEventListener("click", () => {
    if (ui.nextBtn.getAttribute("aria-disabled") === "true") return;
    if (queueIndex < trackQueue.length - 1) {
      queueIndex++;
      playTrack(trackQueue[queueIndex]);
    }
  });

  ui.shuffleBtn.addEventListener("click", () => {
    const active = ui.shuffleBtn.classList.toggle("is-active");
    if (active && trackQueue.length > 1) {
      // Shuffle remaining tracks (keep current track in place)
      const current = trackQueue[queueIndex];
      const remaining = trackQueue.filter((_, i) => i !== queueIndex);
      for (let i = remaining.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
      }
      trackQueue = [current, ...remaining];
      queueIndex = 0;
    }
  });

  ui.repeatBtn.addEventListener("click", () => {
    const modes = ["off", "all", "one"];
    const cur = ui.repeatBtn.dataset.mode || "off";
    const next = modes[(modes.indexOf(cur) + 1) % modes.length];
    ui.repeatBtn.dataset.mode = next;
    ui.repeatBtn.classList.toggle("is-active", next !== "off");
    invoke("cycle_repeat").catch(() => {});
  });
}

function bindSeek() {
  const onPointerDown = (e) => {
    if (!currentTrack || !durationSecs) return;
    isScrubbing = true;
    ui.progressBar.classList.add("is-scrubbing");
    updateSeekFromEvent(e);

    const onMove = (ev) => updateSeekFromEvent(ev);
    const onUp = (ev) => {
      isScrubbing = false;
      ui.progressBar.classList.remove("is-scrubbing");
      updateSeekFromEvent(ev);
      invoke("player_seek", { seconds: currentSecs }).catch(() => {});
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  ui.progressBar.addEventListener("pointerdown", onPointerDown);
}

function updateSeekFromEvent(e) {
  const rect = ui.progressBar.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  currentSecs = pct * durationSecs;
  updateProgressUI(pct * 100);
  ui.timeCurrent.textContent = formatDuration(currentSecs);
}

function bindVolume() {
  ui.volProgress.addEventListener("pointerdown", (e) => {
    const update = (ev) => {
      const rect = ui.volProgress.getBoundingClientRect();
      const pct = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width));
      ui.volFill.style.width = `${pct * 100}%`;
      invoke("set_volume", { volume: pct }).catch(() => {});
    };
    update(e);
    const onMove = (ev) => update(ev);
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  });

  let muted = false;
  ui.volBtn.addEventListener("click", () => {
    muted = !muted;
    const useId = muted ? "#icon-volume-mute" : "#icon-volume";
    ui.volBtn.querySelector("use").setAttribute("href", useId);
    invoke("set_volume", { volume: muted ? 0 : 0.78 }).catch(() => {});
    ui.volFill.style.width = muted ? "0%" : "78%";
  });
}

function listenEngine() {
  listen("player-state", (e) => {
    const payload = e.payload;
    if (payload.StateChanged) {
      if (payload.StateChanged === "Idle" || payload.StateChanged === "Stopped") {
        setPlayingState(false);
      } else if (payload.StateChanged.Playing) {
        setPlayingState(true);
      } else if (payload.StateChanged.Paused) {
        setPlayingState(false);
      }
    } else if (payload.Position) {
      if (!isScrubbing) {
        updatePosition(payload.Position);
      }
    } else if (payload.TrackStarted) {
      const info = payload.TrackStarted;
      updateTechInfo(info);
      if (info.duration && info.duration.secs) {
        durationSecs = info.duration.secs;
        ui.timeTotal.textContent = formatDuration(durationSecs);
      }
      // Audio is now actually flowing — re-enable the play/pause button
      // (playTrack disabled it to avoid the 2-click race).
      ui.playPauseBtn.removeAttribute("aria-disabled");
      // Pre-load next track for gapless playback (ONE decoder, not N).
      const nextTrack = trackQueue[queueIndex + 1];
      if (nextTrack) {
        invoke("player_enqueue_next", { path: nextTrack.path }).catch((err) =>
          console.error("[player] prefetch next failed:", err)
        );
      }
    } else if (payload.TrackEnded != null) {
      const endedTrack = currentTrack;
      if (endedTrack?.id) {
        invoke("lib_record_play", { trackId: endedTrack.id })
          .catch((err) => console.error("[history] record_play failed:", err));
        recentlyPlayedIds.add(endedTrack.id);
        if (recentlyPlayedIds.size > 30) {
          const first = recentlyPlayedIds.values().next().value;
          recentlyPlayedIds.delete(first);
        }
      }
      // Auto-advance to the next queue entry.
      if (queueIndex < trackQueue.length - 1) {
        queueIndex++;
        currentTrack = trackQueue[queueIndex];
        ui.title.textContent = currentTrack.title || "Unknown Title";
        ui.artist.textContent = currentTrack.artist_name || "Unknown Artist";
        ui.timeTotal.textContent = formatDuration((currentTrack.duration_ms || 0) / 1000);
        updateProgressUI(0);
        ui.timeCurrent.textContent = "0:00";
        updateNavButtons();
      } else if (autoplayEnabled && endedTrack?.id) {
        autoplayNext(endedTrack);
      }
    }
  });
}

function setPlayingState(playing) {
  isPlaying = playing;
  const useEl = ui.playPauseBtn.querySelector("use");
  useEl.setAttribute("href", playing ? "#icon-pause" : "#icon-play");
  ui.playPauseBtn.setAttribute("data-playing", playing ? "true" : "false");
  ui.label.innerHTML = playing
    ? `<svg class="icon icon--sm" aria-hidden="true"><use href="#icon-music-note"></use></svg> Playing`
    : `<svg class="icon icon--sm" aria-hidden="true"><use href="#icon-pause"></use></svg> Paused`;
}

function updateNavButtons() {
  ui.prevBtn.setAttribute("aria-disabled", queueIndex <= 0 ? "true" : "false");
  ui.nextBtn.setAttribute("aria-disabled", queueIndex >= trackQueue.length - 1 ? "true" : "false");
}

function updatePosition(pos) {
  currentSecs = pos.samples_played / pos.sample_rate;
  ui.timeCurrent.textContent = formatDuration(currentSecs);
  if (durationSecs > 0) {
    const pct = Math.min(100, (currentSecs / durationSecs) * 100);
    updateProgressUI(pct);
  }
}

function updateProgressUI(pct) {
  ui.progressFill.style.width = `${pct}%`;
  ui.progressThumb.style.left = `${pct}%`;
}

function updateTechInfo(info) {
  ui.techBadge.textContent = "FLAC";
  ui.techBadge.classList.remove("tech-badge--dim");
  const depth = info.bit_depth != null ? `${info.bit_depth}bit` : "\u2014";
  const rate = info.sample_rate ? `${info.sample_rate / 1000}kHz` : "\u2014";
  ui.techLine.textContent = `${depth} / ${rate}`;
}

export async function playTrack(track) {
  currentTrack = track;
  durationSecs = (track.duration_ms || 0) / 1000;
  currentSecs = 0;

  ui.title.textContent = track.title || "Unknown Title";
  ui.artist.textContent = track.artist_name || "Unknown Artist";
  ui.timeTotal.textContent = formatDuration(durationSecs);
  // Keep the play/pause button disabled until the backend confirms the
  // track actually started (TrackStarted event). Otherwise a state flicker
  // between send-Play and audio-out makes a second click look like pause.
  ui.playPauseBtn.setAttribute("aria-disabled", "true");
  updateNavButtons();
  updateProgressUI(0);
  ui.timeCurrent.textContent = "0:00";

  if (track.album_id) {
    try {
      const album = await invoke("lib_get_album", { id: track.album_id });
      if (album && album.cover_path) {
        const assetUrl = convertFileSrc(album.cover_path);
        ui.cover.innerHTML = `<img src="${assetUrl}" alt="">`;
        ui.cover.classList.remove("album-cover-empty");
      } else {
        ui.cover.innerHTML = "";
        ui.cover.classList.add("album-cover-empty");
      }
    } catch (_) {
      // album fetch failed — keep empty cover
    }
  }

  invoke("player_play", { path: track.path }).catch((err) =>
    console.error("[player] play failed:", err)
  );

  if (track.id) {
    invoke("lib_record_play", { trackId: track.id })
      .catch((err) => console.error("[history] record_play failed:", err));
  }
}

function formatDuration(secs) {
  if (!secs) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
