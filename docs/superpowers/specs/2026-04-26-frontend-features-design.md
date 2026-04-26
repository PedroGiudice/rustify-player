# Frontend Features: Stations, Like, Search

Date: 2026-04-26
Status: Approved

## 1. Stations (Mood Radios)

**Route:** `#/stations` | **File:** `src/js/views/stations.js`

**Sidebar:** new "Stations" item with radio icon (Iconify), between Playlists and Queue.

**Card grid (list view):**
- Responsive grid: `auto-fill, minmax(320px, 1fr)`
- Each card uses `accent_color` via inline CSS custom property `--station-color`
- Left border 3px in accent_color
- Play button circle in accent_color (not `--primary`)
- Background gradient at ~8% opacity
- Hover: border-color at 50% accent_color

**Detail view (tracks):**
- Back button + station title + track count
- Standard track table (reuse existing classes)
- Click track: `setQueue(tracks, idx)` + `playTrack()`
- Play button on card: shuffle station tracks and play

**IPC:** `lib_list_moods()` for grid | `lib_list_mood_tracks({ moodId })` for table

**Reference:** `~/Downloads/rustify-stations-preview.html` — layout, state pattern, event delegation.

## 2. Like / Favorites

**Icon:** Vectorized flame from `firemusic.jpg` pixel art, added to SVG sprite.

**Player bar:** like button next to track title. Toggle via `lib_toggle_like({ trackId })`.
Visual: stroke when not-liked, filled + `--primary` when liked.

**Track rows:** flame icon at end of row, toggle on click.

**"Liked Songs":** special entry at top of `/playlists` view with flame icon + count.
Opens list via `lib_list_liked()`.

**State:** `lib_is_liked({ trackId })` called on track change in player bar.

## 3. Search (Titlebar Global)

**Position:** input in titlebar, next to "Kinetic Vault", activated by `Ctrl+K` or click.

**Context-switching by route:**

| Route | Backend | Display |
|---|---|---|
| `/home`, `/tracks`, `/artists`, `/albums` | `lib_search({ query })` | Dropdown: tracks, albums, artists sections |
| `/playlists` | `lib_search_playlists({ query })` | Dropdown: folders grouped |
| `/queue`, `/history`, inside playlist | Client-side filter | Filter table in-place |
| `/stations` | Client-side filter | Filter cards by name |

**UX:** debounce 250ms, dropdown below input, click result navigates or plays. `Esc` closes.
Placeholder changes by context. Remove local search input from `tracks.js`.

## 4. Iconify (new icons)

**Hybrid approach:** existing sprite SVG stays. New icons (stations radio, search, flame)
are SVGs downloaded from Iconify or custom, added to sprite in `index.html`.

## Implementation Order

1. Stations (reference HTML exists, mostly porting)
2. Like / Favorites
3. Search
