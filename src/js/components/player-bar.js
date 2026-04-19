const { listen } = window.__TAURI__.event;
const { invoke, convertFileSrc } = window.__TAURI__.core;

let currentTrack = null;
let trackQueue = []; // tracks from the current view for prev/next
let queueIndex = -1;
let ui = {};

export function setQueue(tracks, startIndex) {
  trackQueue = tracks;
  queueIndex = startIndex;
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
        <span class="player-bar__track-title" id="pb-title">—</span>
        <span class="player-bar__track-artist" id="pb-artist">—</span>
      </div>
    </div>

    <div class="player-bar__block player-bar__block--center">
      <div class="player-bar__controls">
        <button class="icon-btn" id="pb-prev" aria-disabled="true" aria-label="Previous">
          <svg class="icon" aria-hidden="true"><use href="#icon-skip-previous"></use></svg>
        </button>
        <button class="icon-btn icon-btn--primary" id="pb-play-pause" aria-disabled="true" aria-label="Play">
          <svg class="icon" aria-hidden="true"><use href="#icon-play"></use></svg>
        </button>
        <button class="icon-btn" id="pb-next" aria-disabled="true" aria-label="Next">
          <svg class="icon" aria-hidden="true"><use href="#icon-skip-next"></use></svg>
        </button>
      </div>
      <div class="player-bar__seek">
        <span class="player-bar__time" id="pb-time-current">0:00</span>
        <div class="progress" role="slider" id="pb-progress" aria-label="Seek">
          <div class="progress__fill" id="pb-progress-fill" style="width: 0%"></div>
          <div class="progress__thumb" id="pb-progress-thumb" style="left: 0%"></div>
        </div>
        <span class="player-bar__time player-bar__time--right" id="pb-time-total">0:00</span>
      </div>
    </div>

    <div class="player-bar__block player-bar__block--right">
      <div class="player-bar__tech">
        <div class="tech-badge tech-badge--dim" id="pb-tech-badge">—</div>
        <div class="player-bar__tech-line" id="pb-tech-line">— / —</div>
      </div>
    </div>
  `;

  ui = {
    cover: root.querySelector("#pb-cover"),
    label: root.querySelector("#pb-label"),
    title: root.querySelector("#pb-title"),
    artist: root.querySelector("#pb-artist"),
    playPauseBtn: root.querySelector("#pb-play-pause"),
    prevBtn: root.querySelector("#pb-prev"),
    nextBtn: root.querySelector("#pb-next"),
    timeCurrent: root.querySelector("#pb-time-current"),
    timeTotal: root.querySelector("#pb-time-total"),
    progressFill: root.querySelector("#pb-progress-fill"),
    progressThumb: root.querySelector("#pb-progress-thumb"),
    progressBar: root.querySelector("#pb-progress"),
    techBadge: root.querySelector("#pb-tech-badge"),
    techLine: root.querySelector("#pb-tech-line"),
  };

  // Play / Pause
  ui.playPauseBtn.addEventListener("click", () => {
    if (ui.playPauseBtn.getAttribute("aria-disabled") === "true") return;
    const isPlaying = ui.playPauseBtn.dataset.playing === "true";
    if (isPlaying) {
      invoke("player_pause");
    } else {
      invoke("player_resume");
    }
  });

  // Previous
  ui.prevBtn.addEventListener("click", () => {
    if (ui.prevBtn.getAttribute("aria-disabled") === "true") return;
    if (queueIndex > 0) {
      queueIndex--;
      playTrack(trackQueue[queueIndex]);
    }
  });

  // Next
  ui.nextBtn.addEventListener("click", () => {
    if (ui.nextBtn.getAttribute("aria-disabled") === "true") return;
    if (queueIndex < trackQueue.length - 1) {
      queueIndex++;
      playTrack(trackQueue[queueIndex]);
    }
  });

  // Seek
  ui.progressBar.addEventListener("click", (e) => {
    if (!currentTrack || !currentTrack.duration_secs) return;
    const rect = ui.progressBar.getBoundingClientRect();
    const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const seekTo = pct * currentTrack.duration_secs;
    invoke("player_seek", { seconds: seekTo });
  });

  // Engine state events
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
      updatePosition(payload.Position);
    } else if (payload.TrackStarted) {
      const info = payload.TrackStarted;
      updateTechInfo(info);
      if (info.duration && info.duration.secs) {
        ui.timeTotal.textContent = formatDuration(info.duration.secs);
      }
    }
  });
}

function setPlayingState(isPlaying) {
  ui.playPauseBtn.dataset.playing = isPlaying ? "true" : "false";
  ui.playPauseBtn.innerHTML = isPlaying
    ? `<svg class="icon" aria-hidden="true"><use href="#icon-pause"></use></svg>`
    : `<svg class="icon" aria-hidden="true"><use href="#icon-play"></use></svg>`;
}

function updateNavButtons() {
  ui.prevBtn.setAttribute("aria-disabled", queueIndex <= 0 ? "true" : "false");
  ui.nextBtn.setAttribute("aria-disabled", queueIndex >= trackQueue.length - 1 ? "true" : "false");
}

function updatePosition(pos) {
  const currentSecs = pos.samples_played / pos.sample_rate;
  ui.timeCurrent.textContent = formatDuration(currentSecs);

  if (currentTrack && currentTrack.duration_secs > 0) {
    const percent = Math.min(100, (currentSecs / currentTrack.duration_secs) * 100);
    ui.progressFill.style.width = `${percent}%`;
    ui.progressThumb.style.left = `${percent}%`;
  }
}

function updateTechInfo(info) {
  ui.techBadge.textContent = "FLAC";
  ui.techBadge.classList.remove("tech-badge--dim");
  const depth = info.bit_depth != null ? `${info.bit_depth}bit` : "—";
  const rate = info.sample_rate ? `${info.sample_rate / 1000}kHz` : "—";
  ui.techLine.textContent = `${depth} / ${rate}`;
}

export async function playTrack(track) {
  currentTrack = track;

  ui.title.textContent = track.title || "Unknown Title";
  ui.artist.textContent = track.artist_name || "Unknown Artist";
  ui.label.innerHTML = `<svg class="icon icon--sm" aria-hidden="true"><use href="#icon-music-note"></use></svg> Playing`;
  ui.timeTotal.textContent = formatDuration(track.duration_secs || 0);
  ui.playPauseBtn.removeAttribute("aria-disabled");
  updateNavButtons();

  // Reset progress
  ui.progressFill.style.width = "0%";
  ui.progressThumb.style.left = "0%";
  ui.timeCurrent.textContent = "0:00";

  if (track.album_id) {
    try {
      const album = await invoke("lib_get_album", { id: track.album_id });
      if (album && album.cover_path) {
        const assetUrl = convertFileSrc(album.cover_path);
        ui.cover.innerHTML = `<img src="${assetUrl}" style="width: 100%; height: 100%; object-fit: cover; border-radius: inherit;">`;
        ui.cover.classList.remove("album-cover-empty");
      } else {
        ui.cover.innerHTML = "";
        ui.cover.classList.add("album-cover-empty");
      }
    } catch (e) {
      console.error(e);
    }
  }

  invoke("player_play", { path: track.path }).catch((err) =>
    console.error("[player] play failed:", err)
  );

  if (track.id) {
    invoke("lib_record_play", { trackId: track.id }).catch((err) =>
      console.error("[player] record_play failed:", err)
    );
  }
}

function formatDuration(secs) {
  if (!secs) return "0:00";
  const m = Math.floor(secs / 60);
  const s = Math.floor(secs % 60);
  return `${m}:${s.toString().padStart(2, "0")}`;
}
