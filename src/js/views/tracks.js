import { renderView } from "./_view.js";

export function render() {
  return renderView({
    title: "Tracks",
    emptyIcon: "audiotrack",
    emptyTitle: "No tracks indexed yet",
    emptyHint: "Point to a music folder in Settings",
  });
}
