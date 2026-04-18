// Player bar — structurally complete, data-wise empty.
// Controls are aria-disabled until an IPC track loads.

export function mountPlayerBar(root) {
  root.innerHTML = `
    <div class="player-bar__block player-bar__block--left">
      <div class="album-cover-empty" aria-hidden="true"></div>
      <div class="player-bar__track-meta">
        <span class="player-bar__track-label">
          <svg class="icon icon--sm" aria-hidden="true"><use href="#icon-music-note"></use></svg>
          No Track
        </span>
        <span class="player-bar__track-title">—</span>
        <span class="player-bar__track-artist">—</span>
      </div>
    </div>

    <div class="player-bar__block player-bar__block--center">
      <div class="player-bar__controls">
        <button class="icon-btn" aria-disabled="true" aria-label="Previous">
          <svg class="icon" aria-hidden="true"><use href="#icon-skip-previous"></use></svg>
        </button>
        <button class="icon-btn icon-btn--primary" aria-disabled="true" aria-label="Play">
          <svg class="icon" aria-hidden="true"><use href="#icon-play"></use></svg>
        </button>
        <button class="icon-btn" aria-disabled="true" aria-label="Next">
          <svg class="icon" aria-hidden="true"><use href="#icon-skip-next"></use></svg>
        </button>
      </div>
      <div class="player-bar__seek">
        <span class="player-bar__time">--:--</span>
        <div class="progress" role="slider" aria-disabled="true" aria-label="Seek">
          <div class="progress__fill" style="width: 0%"></div>
          <div class="progress__thumb" style="left: 0%"></div>
        </div>
        <span class="player-bar__time player-bar__time--right">--:--</span>
      </div>
    </div>

    <div class="player-bar__block player-bar__block--right">
      <div class="player-bar__tech">
        <div class="tech-badge tech-badge--dim">—</div>
        <div class="player-bar__tech-line">— / —</div>
      </div>
    </div>
  `;
}
