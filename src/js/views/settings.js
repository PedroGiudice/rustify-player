import { renderView } from "./_view.js";

export function render() {
  return renderView({
    title: "Settings",
    emptyIcon: "settings",
    emptyTitle: "Settings not wired yet",
    emptyHint: "Controls for library path, output device, and theme will live here",
  });
}
