/* ============================================================
   icons.tsx — porte do objeto window.ICONS do handoff
   (docs/design-refs/design_handoff_mobile/data.js) para
   componentes Solid com SVG inline.

   O protótipo também fazia fetch('assets/icons.svg') para um
   sprite escondido, mas NENHUMA tela usava <use href> — todos os
   ícones vinham do objeto ICONS. O sprite foi ignorado.

   Só os ícones que o v0 realmente usa foram portados; os das telas
   cortadas (station/radio/sparkle/trash/heart/repeat/drag/...)
   ficaram de fora de propósito.
   ============================================================ */

interface IcoProps {
  class?: string;
}
const cx = (p: IcoProps, extra?: string) =>
  ["icon", extra, p.class].filter(Boolean).join(" ");

const S = {
  class: "icon",
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  "stroke-width": "1.7",
  "stroke-linecap": "round" as const,
  "stroke-linejoin": "round" as const,
};

export const Icon = {
  home: (p: IcoProps = {}) => (
    <svg {...S} class={cx(p)}>
      <path d="M3 11 12 3l9 8M5 9v12h14V9" />
    </svg>
  ),
  search: (p: IcoProps = {}) => (
    <svg {...S} class={cx(p)}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  ),
  library: (p: IcoProps = {}) => (
    <svg {...S} class={cx(p)}>
      <path d="M4 4h3v16H4zM10 4h3v16h-3zM16 4l5 1.5-3 14.5-5-1.5z" />
    </svg>
  ),
  settings: (p: IcoProps = {}) => (
    <svg {...S} class={cx(p)}>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
    </svg>
  ),
  disc: (p: IcoProps = {}) => (
    <svg {...S} class={cx(p)}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="2" />
    </svg>
  ),
  note: (p: IcoProps = {}) => (
    <svg {...S} class={cx(p)}>
      <path d="M9 18V5l11-2v13" />
      <circle cx="6" cy="18" r="3" />
      <circle cx="17" cy="16" r="3" />
    </svg>
  ),
  person: (p: IcoProps = {}) => (
    <svg {...S} class={cx(p)}>
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21c0-4 4-6 8-6s8 2 8 6" />
    </svg>
  ),
  folder: (p: IcoProps = {}) => (
    <svg {...S} class={cx(p)}>
      <path d="M3 7l3-3h4l2 2h9v13H3z" />
    </svg>
  ),
  play: (p: IcoProps = {}) => (
    <svg {...S} class={cx(p)}>
      <path d="M6 4v16l14-8z" fill="currentColor" stroke="none" />
    </svg>
  ),
  pause: (p: IcoProps = {}) => (
    <svg {...S} class={cx(p)}>
      <rect x="6" y="4" width="4" height="16" fill="currentColor" stroke="none" />
      <rect x="14" y="4" width="4" height="16" fill="currentColor" stroke="none" />
    </svg>
  ),
  next: (p: IcoProps = {}) => (
    <svg {...S} class={cx(p)}>
      <path d="M18 4v16M4 4l12 8-12 8z" fill="currentColor" stroke="currentColor" />
    </svg>
  ),
  prev: (p: IcoProps = {}) => (
    <svg {...S} class={cx(p)}>
      <path d="M6 4v16M20 4 8 12l12 8z" fill="currentColor" stroke="currentColor" />
    </svg>
  ),
  shuffle: (p: IcoProps = {}) => (
    <svg {...S} class={cx(p)}>
      <path d="M16 4h5v5M3 20l18-16M21 15v5h-5M15 14l6 6M3 4l6 6" />
    </svg>
  ),
  queue: (p: IcoProps = {}) => (
    <svg {...S} class={cx(p)}>
      <path d="M3 6h13M3 12h13M3 18h9M19 10v10" />
      <circle cx="16" cy="20" r="2" />
    </svg>
  ),
  back: (p: IcoProps = {}) => (
    <svg {...S} class={cx(p)}>
      <path d="M15 6 9 12l6 6" />
    </svg>
  ),
  chev: (p: IcoProps = {}) => (
    <svg {...S} class={cx(p, "chev")}>
      <path d="m9 6 6 6-6 6" />
    </svg>
  ),
  down: (p: IcoProps = {}) => (
    <svg {...S} class={cx(p)}>
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
};
