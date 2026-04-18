# Design System Documentation

## 1. Overview & Creative North Star: "The Kinetic Vault"

The creative direction for this design system is **The Kinetic Vault**. It reimagines the audiophile experience as a high-end, monolithic piece of hardware—silent, heavy, and permanent—that comes to life through sharp, amber-lit instrumentation. 

By rejecting the "softness" of modern consumer web design (rounded corners, soft shadows, and pastel blurs), we embrace a **Brutalist-Minimalist** aesthetic. The interface is defined by raw structural integrity, high-contrast typography, and an "editorial" layout that treats album art and track metadata with the reverence of a gallery exhibition. We move beyond templates by using intentional asymmetry and a "No-Line" architecture to maximize performance and visual clarity.

---

## 2. Colors: Depth Through Tonal Shift

This system utilizes a "Deep Dark" palette to minimize eye strain and maximize the "glow" of the amber accents.

### The "No-Line" Rule
**Borders are prohibited.** To separate a sidebar from a main content area or a player bar from a tracklist, designers must use background color shifts only. Structural definition comes from the juxtaposition of `surface` against `surface_container_low` or `surface_container_highest`. This reduces DOM complexity and creates a more sophisticated, seamless look.

### Color Tokens
- **Background/Surface:** `#131313` (The primary canvas)
- **Primary (The Glow):** `#ffb87b` (Amber accent for active states, play buttons, and progress)
- **Surface Container Lowest:** `#0e0e0e` (Used for the main "pit" or background of the player)
- **Surface Container High:** `#2a2a2a` (Used for elevated interaction states like hovered rows)
- **On-Surface:** `#e5e2e1` (High-contrast white for primary text)

### Signature Textures
While the aesthetic is minimalist, CTAs and active progress bars should utilize a subtle linear gradient transitioning from `primary` (#ffb87b) to `primary_container` (#ff8f00). This mimics the warm, uneven glow of a vacuum tube or a vintage LED display, providing "soul" to the digital interface.

---

## 3. Typography: Editorial Authority

We use **Inter** as a functional, high-readability sans-serif. The hierarchy is designed to feel like a premium music journal.

- **Display Scale (`display-lg` to `display-sm`):** Reserved for Artist names or Album titles in immersive views. Use `display-lg` (3.5rem) with tight letter-spacing to create a "masthead" effect.
- **Headline & Title Scale:** Used for section headers (e.g., "Jump Back In"). These must be set in `headline-sm` (1.5rem) to maintain a bold, authoritative structure.
- **Label Scale:** `label-md` (0.75rem) should be used for metadata like bitrates, file formats (FLAC/WAV), and timestamps. These should be uppercase with a +5% letter-spacing to mimic technical instrumentation.

---

## 4. Elevation & Depth: Tonal Layering

Traditional shadows and 3D effects are replaced by **The Layering Principle**. Depth is achieved by "stacking" the surface tiers.

- **Stacking Logic:** 
    - **Level 0 (Canvas):** `surface_container_lowest` (#0e0e0e)
    - **Level 1 (Navigation/Sidebar):** `surface` (#131313)
    - **Level 2 (Active Cards/Modals):** `surface_container_high` (#2a2a2a)
- **The "Ghost Border" Fallback:** If a distinction is visually impossible (e.g., a floating context menu), use the `outline_variant` (#564334) at **15% opacity**. This creates a "barely-there" edge that maintains the Brutalist silhouette without adding heavy visual weight.
- **Glassmorphism:** For the Player Bar, use `surface` at 80% opacity with a `backdrop-blur: 20px`. This allows the album art colors to bleed through subtly as the user scrolls, creating a sense of environmental immersion.

---

## 5. Components

All components adhere to a **0px Roundedness Scale**. Sharp corners are non-negotiable.

### Buttons
- **Primary:** Background `primary` (#ffb87b), Text `on_primary` (#4c2700). Square edges. No shadow.
- **Secondary:** Background `surface_container_highest`, Text `on_surface`.
- **States:** On hover, the primary button should shift to `primary_fixed_dim`. No movement or lifting; only a color state change.

### Lists & Tables (The Tracklist)
- **Layout:** Forbid the use of divider lines. 
- **Separation:** Use `body-md` typography with generous vertical padding (16px).
- **Active State:** The currently playing track should not have a background highlight; instead, use the `primary` amber color for the Track Title and a "Glow" icon.

### Progress & Seek Bars
- **Track:** `surface_container_highest`.
- **Active Fill:** Linear gradient from `primary` to `secondary`.
- **Thumb:** A sharp, 2px wide vertical line (no circles), mimicking a needle on a gauge.

### Input Fields
- **Styling:** Transparent background with a `surface_container_highest` bottom-border only (2px).
- **Focus State:** Bottom-border shifts to `primary` (#ffb87b).

---

## 6. Do’s and Don’ts

### Do
- **Do** use `0px` border radius on every single element.
- **Do** leverage high-contrast pairings (Amber on Black) for critical navigation.
- **Do** use CSS Grid to keep DOM node counts low; avoid "div-soup" for layout containers.
- **Do** use asymmetrical layouts (e.g., a massive album cover on the left with a minimalist tracklist on the right) to create a premium feel.

### Don’t
- **Don't** use 1px solid borders to separate sections. Use color blocks.
- **Don't** use "Soft Grey" for secondary text. Use `on_surface_variant` (#dcc1ae) to maintain the warm, organic tonal range.
- **Don't** use standard "Drop Shadows." If an element must float, use a high-contrast tonal shift behind it.
- **Don't** use transitions longer than 150ms. Audiophile gear should feel "instant" and mechanical.