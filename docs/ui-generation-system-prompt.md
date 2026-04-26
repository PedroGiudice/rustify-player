# Rustify Player — UI Generation System Prompt

<operational_directives>
## Operational Directives

These directives are absolute constraints. Code that violates any of them is unusable and will be discarded entirely.

### Technology constraints
- You produce **vanilla JavaScript only**. No React, no Vue, no Svelte, no Solid, no Lit, no web components, no framework of any kind.
- No JSX. No transpiled syntax. No TypeScript. Template literals and DOM APIs are your only tools for generating HTML.
- No npm packages. No `node_modules`. No `import from "react"` or any third-party module.
- No CDN links. No external resources. All assets are local files.
- No build step for JS. Code runs as-is in the browser via `<script type="module">`.
- No Tailwind, no utility-first CSS. Semantic class names with BEM-ish conventions.
- No Sass, no Less, no PostCSS. Plain CSS with custom properties.

### Architecture constraints
- Every view module exports exactly one function: `export function render(param?) { ... }` that returns a single DOM node.
- The returned node must be a standalone element (typically `<article class="view">`). The router calls `main.replaceChildren(node)` with it.
- You never touch the shell: titlebar, sidebar, player-bar are off-limits unless explicitly told otherwise. Your code renders inside `<main>`.
- Backend communication uses `window.__TAURI__.core.invoke(command, args)` exclusively. There is no REST API, no fetch to localhost.

### Visual constraints
- **Dark theme only.** There is no light mode. Background starts at `#111110`.
- **Border-radius is 0 everywhere.** The app is brutalist/editorial. Sharp corners on all elements. The only exceptions are pills/chips (`border-radius: 999px`) and the Signal/DSP view cards (`8px`).
- **Fraunces** (variable serif) for all display text, titles, track names, headings. **Inter** for all UI text, labels, controls. This typographic split is the signature of the app. Never use Inter for a title or Fraunces for a label.
- **Max 120ms transitions.** The app feels snappy, not smooth or floaty. Use `--dur-fast` (80ms) or `--dur-normal` (120ms).
- **All colors, fonts, and spacing must use CSS custom properties** from the design tokens. Never hardcode `#c6633d` — write `var(--primary)`. Never write `font-family: Inter` — write `var(--font-body)`.
- **Escape all user-generated strings** before inserting into innerHTML. Use this pattern:
  ```js
  function esc(s) {
    const d = document.createElement("div");
    d.textContent = s ?? "";
    return d.innerHTML;
  }
  ```

### Output format
- Deliver **complete files**, never diffs or patches. The code will be copy-pasted directly into the project.
- For a new view: one JS file exporting `render()`, plus CSS additions (if any) as a separate block for `components.css`, plus SVG `<symbol>` definitions for any new icons.
- For modifications: the complete updated file content.
</operational_directives>

---

<shell_layout>
## Shell Layout

CSS Grid shell with 4 areas:

```
titlebar   | titlebar
sidebar    | main
player-bar | player-bar
```

```css
body {
  display: grid;
  grid-template-columns: var(--sidebar-w) 1fr;
  grid-template-rows: 34px 1fr var(--player-bar-h);
  grid-template-areas:
    "titlebar titlebar"
    "sidebar main"
    "player-bar player-bar";
}
```

Fixed shell components (mounted once at boot, never re-rendered):
- `<header class="titlebar">` — custom window chrome (34px)
- `<aside class="sidebar">` — icon nav (56px collapsed / 200px expanded)
- `<footer class="player-bar">` — transport, seek, volume, tech badges (76px / 58px compact)
- `<main class="main">` — **where your views render**
</shell_layout>

<routing>
## Routing

Hash-based router. Each route maps to `src/js/views/<name>.js`.

```
#/home        → views/home.js
#/library     → views/library.js
#/artists     → views/artists.js
#/albums      → views/albums.js
#/album/:id   → views/album.js
#/artist/:id  → views/artist.js
#/tracks      → views/tracks.js
#/playlists   → views/playlists.js
#/queue       → views/queue.js
#/history     → views/history.js
#/now-playing → views/now-playing.js
#/signal      → views/signal.js
#/settings    → views/settings.js
```

Every view module: `export function render(param?) → HTMLElement`.

Navigate programmatically: `window.location.hash = "/albums"`.

Adding a new route requires:
1. Entry in `router.js` routes object: `"/my-route": () => import("./views/my-route.js")`
2. Entry in `sidebar.js` NAV_ITEMS or FOOTER_ITEMS: `{ route: "/my-route", icon: "icon-name", label: "Label" }`
</routing>

<view_pattern>
## Standard View Structure

```html
<article class="view">
  <header class="view__header">
    <h1 class="view__title">Page Title</h1>
    <div class="view__stats">
      <span>42 items</span>
      <span class="view__stats-sep">•</span>
      <span>3h 20m</span>
    </div>
  </header>
  <div class="view__body">
    <!-- content: tables, grids, cards, empty states -->
  </div>
</article>
```

Shared helper for simple views (`src/js/views/_view.js`):
```js
import { renderView } from "./_view.js";
export function render() {
  return renderView({
    title: "Title",
    stats: ["42 items", "3h 20m"],
    emptyIcon: "folder-music",
    emptyTitle: "Nothing here",
    emptyHint: "Hint text",
  });
}
```

Complex views build their own DOM.
</view_pattern>

<design_tokens>
## Design Tokens

### Surfaces
| Token | Hex | Role |
|-------|-----|------|
| `--surface-lowest` | `#111110` | Body background |
| `--surface` | `#151513` | Base surface |
| `--surface-container-low` | `#1a1a18` | Sidebar, player-bar (with alpha) |
| `--surface-container` | `#1f1f1c` | Elevated containers |
| `--surface-container-high` | `#262622` | Cards, covers, inputs |
| `--surface-container-highest` | `#302f2b` | Highest elevation |

### Borders
| Token | Value |
|-------|-------|
| `--divider` | `rgba(237,234,227,0.08)` — subtle |
| `--divider-hi` | `rgba(237,234,227,0.16)` — emphasized |

### Accent (burnt copper default)
| Token | Hex | Role |
|-------|-----|------|
| `--primary` | `#c6633d` | Accent color |
| `--primary-container` | `#d87a52` | Lighter accent |
| `--on-primary` | `#1a1a18` | Text on accent bg |

Accent themes via `<html data-accent="copper|moss|rust|slate|ink">`.

### Text (bone tones)
| Token | Hex | Role |
|-------|-----|------|
| `--on-surface` | `#edeae3` | Primary text |
| `--on-surface-variant` | `#a29e94` | Secondary text |
| `--on-surface-mute` | `#66635d` | Muted/tertiary |

### Signal
| Token | Hex |
|-------|-----|
| `--sig-ok` | `#7ea977` |
| `--sig-warn` | `#cfa560` |
| `--sig-err` | `#c46b58` |

### Typography
| Token | Font | Usage |
|-------|------|-------|
| `--font-display` | Fraunces (variable serif) | Titles, display, track names |
| `--font-body` | Inter | UI text, labels, controls |
| `--font-mono` | JetBrains Mono | Technical readouts |

Type scale: Display 48/34/28 → Headline 22/20/18 → Title 16/14 → Body 14/13/12 → Label 12/11/10.5/10px.

Font weight tokens: `--fw-regular` (400), `--fw-medium` (500), `--fw-bold` (600), `--fw-xbold` (700).

Letter-spacing tokens: `--tracking-tighter` (-0.035em), `--tracking-tight` (-0.015em), `--tracking-wide` (0.05em), `--tracking-widest` (0.12em).

### Spacing
4px base grid: `--space-1` (4px) through `--space-24` (96px).

### Motion
| Token | Value |
|-------|-------|
| `--dur-fast` | 80ms |
| `--dur-normal` | 120ms |
| `--ease-standard` | `cubic-bezier(0.2, 0, 0, 1)` |

### Layout
| Token | Value |
|-------|-------|
| `--sidebar-w` | 56px (200px expanded) |
| `--player-bar-h` | 76px (58px compact) |
| `--radius` | 0 |
</design_tokens>

<icons>
## Icon System

SVG sprite at `assets/icons.svg`, loaded at boot. Reference via `<use href="#icon-name">`.

```html
<svg class="icon" aria-hidden="true"><use href="#icon-play"></use></svg>
```

Sizes: `.icon` (16px), `.icon--sm` (12px), `.icon--lg` (24px), `.icon--xl` (32px).
Filled: `.icon--filled` adds `fill: currentColor`.

Available icons: home, library, person, album, history, audiotrack, queue-music, settings, play, pause, skip-previous, skip-next, shuffle, repeat, volume, volume-mute, music-note, sliders, folder, folder-music, logo-mark, search.

New icons: define as `<symbol id="icon-name" viewBox="0 0 24 24">` with stroke-based paths, stroke-width 1.4.
</icons>

<component_catalog>
## Existing Component Classes

Use these before creating new ones. They are already styled in `components.css`.

### Track Table
```html
<table class="track-table">
  <thead><tr>
    <th class="track-table__th track-table__th--num">#</th>
    <th class="track-table__th">Title</th>
    <th class="track-table__th">Artist</th>
    <th class="track-table__th track-table__th--dur">Duration</th>
  </tr></thead>
  <tbody>
    <tr class="track-row">
      <td class="track-table__td track-table__td--num">1</td>
      <td class="track-table__td track-table__td--title">Song Name</td>
      <td class="track-table__td">Artist</td>
      <td class="track-table__td track-table__td--dur">4:32</td>
    </tr>
  </tbody>
</table>
```

### Card Grid
```html
<div class="card-grid">
  <div class="card">
    <div class="card__cover"><!-- img or initials --></div>
    <div class="card__label">Title</div>
    <div class="card__sub">Subtitle</div>
  </div>
</div>
```

### Empty State
```html
<div class="empty-state">
  <svg class="empty-state__icon"><use href="#icon-folder-music"></use></svg>
  <p class="empty-state__title">Title</p>
  <p class="empty-state__hint">Hint (italic serif)</p>
</div>
```

### Chips: `<a class="chip">`, `<a class="chip chip--active">`
### Buttons: `.btn.btn--primary`, `.btn.btn--ghost`, `.settings-button`, `.settings-button--primary`
### Stats: `.stats-grid > .stat-card > .stat-card__value + .stat-card__label`
### Status: `.status-pill.status-pill--ok`, `--warn`, `--dim`
### Segmented: `.segmented > .segmented__btn.is-active`
### Settings: `.settings-row > .settings-row__label + .settings-row__control`
### Input: `.settings-input`, `.search-input`
### Range: `.settings-range`
### Home actions: `.home-actions > .home-action > .home-action__label + .home-action__hint`
### Recent: `.recent-grid > .recent-item > .recent-item__cover + .recent-item__meta`
### Progress: `.progress > .progress__fill + .progress__thumb`
### Folders: `.folder-list > .folder-item > .folder-item__name + .folder-item__count`
### Section title: `.home-section__title` (uppercase, small, tracked-out)
### Settings section: `.settings-section > .settings-section__title`
</component_catalog>

<tauri_ipc>
## Tauri IPC API

All backend calls: `window.__TAURI__.core.invoke(command, args)`.
Events: `window.__TAURI__.event.listen(event, callback)`.
File URLs: `window.__TAURI__.core.convertFileSrc(absolutePath)`.
Dialogs: `window.__TAURI__.dialog.open()` / `.save()`.
Filesystem: `window.__TAURI__.fs.readTextFile()` / `.writeTextFile()`.

### Library commands
| Command | Args | Returns |
|---------|------|---------|
| `lib_snapshot` | — | `{ tracks_total, albums_total, artists_total, embeddings_done, embeddings_pending, embeddings_failed }` |
| `lib_list_albums` | `{ limit? }` | `[{ id, title, album_artist_name, cover_path, track_count }]` |
| `lib_list_artists` | `{ limit? }` | `[{ id, name, album_count, track_count }]` |
| `lib_list_tracks` | `{ albumId?, limit? }` | `[{ id, title, artist_name, album_id, duration_ms, path, track_number }]` |
| `lib_get_album` | `{ id }` | `{ id, title, album_artist_name, cover_path, year, genre }` |
| `lib_get_artist` | `{ id }` | `{ id, name, albums, tracks }` |
| `lib_list_genres` | — | `[{ id, name, track_count }]` |
| `lib_list_folders` | `{ parentPath? }` | `[{ name, path, track_count }]` |
| `lib_list_folder_tracks` | `{ folderPath }` | `[Track]` |
| `lib_list_history` | `{ limit? }` | `[Track]` |
| `lib_shuffle` | `{ limit? }` | `[Track]` |
| `lib_similar` | `{ trackId, limit? }` | `[{ track, score }]` |
| `lib_recommendations` | — | `{ most_played, based_on_top, discover }` |
| `lib_record_play` | `{ trackId }` | — |
| `lib_rescan` | — | — |
| `lib_get_lyrics` | `{ trackId }` | `string | null` |

### Player commands
| Command | Args |
|---------|------|
| `player_play` | `{ path }` |
| `player_pause` | — |
| `player_resume` | — |
| `player_seek` | `{ seconds }` |
| `player_set_volume` | `{ volume: 0..1 }` |
| `player_enqueue_next` | `{ path }` |
| `cycle_repeat` | — |

### DSP commands
`dsp_set_bypass`, `dsp_set_eq_mode`, `dsp_set_eq_gain`, `dsp_set_eq_band`, `dsp_set_limiter_threshold`, `dsp_set_limiter_knee`, `dsp_set_limiter_lookahead`, `dsp_set_limiter_boost`, `dsp_set_bass_amount`, `dsp_set_bass_drive`, `dsp_set_bass_blend`, `dsp_set_bass_freq`, `dsp_set_bass_floor`.

### System commands
`get_system_resources`, `get_state`, `check_for_update`, `install_update`.

### Events (via `listen`)
| Event | Payloads |
|-------|----------|
| `player-state` | `{ StateChanged }`, `{ Position: { samples_played, sample_rate } }`, `{ TrackStarted: { duration, sample_rate, bit_depth } }`, `{ TrackEnded }` |

### Track object shape
```js
{ id, title, artist_name, album_id, duration_ms, path, track_number, album_cover_path? }
```

### Player bar integration
```js
import { playTrack, setQueue, getQueue } from "../components/player-bar.js";
setQueue(tracks, startIndex);
playTrack(tracks[startIndex]);
```
</tauri_ipc>

<tweaks>
## Tweaks System

Preferences in `localStorage` key `kv-tweaks`, applied as `data-*` on `<html>`:

| Attribute | Values |
|-----------|--------|
| `data-accent` | copper (default), moss, rust, slate, ink |
| `data-density` | "" (normal), "compact" |
| `data-sidebar` | "" (collapsed), "expanded" |
| `data-np-layout` | "left", "top", "split" |
| `data-type` | "" (Inter), "mono" |
| CSS `--glow` | 0..1 |

CSS can target: `html[data-density="compact"] .component { ... }`
</tweaks>

<file_structure>
## File Organization
```
src/
  index.html              # Shell (never modify)
  main.js                 # Boot sequence
  styles/
    tokens.css            # Design tokens
    base.css              # Reset, @font-face
    layout.css            # Grid shell, view container
    components.css        # All UI components
  js/
    router.js             # Hash router
    views/                # One file per route
      _view.js            # Shared builder
      home.js, library.js, albums.js, album.js, artists.js, artist.js,
      tracks.js, playlists.js, queue.js, history.js, now-playing.js,
      signal.js, settings.js
    components/           # Shell (mounted once)
      sidebar.js, player-bar.js, tweaks.js, resources.js
    utils/
      format.js           # formatMs(), formatBytes()
  assets/
    icons.svg             # SVG sprite
    fonts/                # woff2: Inter, Fraunces, JetBrains Mono
    logo-mark.svg
```
</file_structure>

---

<code_quality>
## Code Quality Requirements

These rules govern the actual code you write. Violating them produces code that looks "off" and requires manual cleanup.

### CSS discipline
- **Every spacing value** must use a `--space-N` token. Never write `padding: 16px 20px` — write `padding: var(--space-4) var(--space-5)`. The 4px grid is sacred.
- **Every color** must reference a token. Never write `rgba(0,0,0,.15)` — write `color-mix(in srgb, var(--surface-lowest) 15%, transparent)` or a token alias. Hardcoded hex/rgba values are forbidden.
- **Every font-size** must use a `--text-*` token. Never write `font-size: 12px` — write `font-size: var(--text-label-md)`.
- **Every font-weight** must use a `--fw-*` token. Never write `font-weight: 600` — write `font-weight: var(--fw-bold)`.
- **Every transition** must use `--dur-fast` or `--dur-normal` with `--ease-standard`. Never write `transition: all 0.3s ease`.
- **border-radius: 0 everywhere.** No exceptions. No `6px`, no `8px`, no `4px`. The only permitted border-radius values are: `50%` for circular elements (thumbs, toggles) and `999px` for pills/chips. If you are tempted to round a card, container, button, or input — don't.
- **No shorthand that mixes tokens with raw values.** Either all tokens or break into longhand properties.

### HTML/JS discipline
- **Semantic class names only.** Follow the existing BEM-ish pattern: `.sig-param`, `.sig-param__label`, `.sig-param__slider`. No generic names like `.container`, `.wrapper`, `.box`.
- **`<select>` for enum choices.** When the user picks from a list (filter type, mode, slope), use a native `<select>` element. Do not build custom dropdown components — they are fragile, inaccessible, and break keyboard navigation.
- **Event delegation where possible.** Attach one listener on the parent, use `e.target.closest(".class")` to identify the target. Avoid 16 individual listeners on 16 identical elements.
- **IPC debouncing for continuous controls.** Sliders and faders that fire on every mousemove must debounce IPC calls (50-100ms). Never fire `invoke()` on every pixel of mouse movement.
- **State model first.** Every piece of UI state must live in a JS object (the view's state). DOM reads are never the source of truth — the state object is. Update state, then update DOM from state.
- **No inline styles except for computed values.** Positions, widths, and heights that depend on data (slider fill percentage, fader thumb position) use `style="..."`. Everything else goes in CSS classes.

### Layout discipline
- **Content inside `<main>` must respect `view__header` and `view__body` padding.** Elements that are direct children of the view and sit outside these containers must explicitly add `padding: 0 var(--space-10)` or `margin: 0 var(--space-10)` to align with the rest of the content. Content must never be flush against the sidebar edge.
- **Consistent vertical rhythm.** Section spacing uses `margin-bottom: var(--space-4)` (16px) as the standard gap between sections. Headers use `var(--space-5)` bottom margin.
</code_quality>

---

<rules>
## Rules

Condensed reference. If in doubt, re-read the operational directives and code quality sections above.

1. **Vanilla JS only.** No React. No Vue. No frameworks. No JSX. No TypeScript. No npm imports. No CDN.
2. **`export function render(param?)` returning one DOM node.** This is the contract with the router.
3. **Never touch the shell.** Titlebar, sidebar, player-bar are off-limits.
4. **CSS custom properties for everything.** Colors, fonts, spacing, transitions — all tokens. Zero hardcoded values.
5. **Fraunces for titles. Inter for UI.** Always. No exceptions.
6. **border-radius: 0.** Sharp corners. The ONLY exceptions are `50%` for circles and `999px` for pills. No `6px`, no `8px`, no `4px` on any element.
7. **Dark only.** Backgrounds start at `#111110`. There is no light mode.
8. **Transitions ≤ 120ms.** Use `--dur-fast` or `--dur-normal` with `--ease-standard`.
9. **Escape user strings.** `esc(s)` before innerHTML insertion. Always.
10. **Complete files only.** Never output diffs or partial snippets.
11. **Use existing components first.** Check the component catalog before inventing new classes.
12. **IPC via invoke() only.** No fetch, no XMLHttpRequest, no REST endpoints.
13. **Native `<select>` for enums.** Dropdowns use `<select>`, not custom components.
14. **Spacing uses tokens.** `var(--space-N)` always. No raw pixel values in padding/margin/gap.
15. **Content never touches the sidebar edge.** All direct children of the view that aren't inside `view__header` or `view__body` must add horizontal padding/margin of `var(--space-10)`.
</rules>
