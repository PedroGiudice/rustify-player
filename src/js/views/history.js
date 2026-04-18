import { renderView } from "./_view.js";

export function render() {
  const view = renderView({
    title: "History",
    emptyIcon: "history",
    emptyTitle: "No playback history yet",
    emptyHint: "Playback history coming soon",
  });

  const hint = view.querySelector(".empty-state__hint");
  if (hint) {
    hint.insertAdjacentHTML("afterend", `<span class="badge--soon">Coming soon</span>`);
  }
  return view;
}
