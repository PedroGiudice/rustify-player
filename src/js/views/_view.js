// Shared view builder — every top-level view renders:
//   <article.view>
//     <header.view__header>
//       <h1.view__title>
//       <div.view__stats>
//     <div.view__body>
//       <div.empty-state>
//
// Passing empty stats / empty-body message keeps empty-state first-class
// until IPC wiring replaces them.

export function renderView({ title, stats = [], emptyIcon = "folder-music", emptyTitle, emptyHint }) {
  const view = document.createElement("article");
  view.className = "view";

  const statsHTML = stats.length
    ? stats.map((s, i) => {
        const sep = i < stats.length - 1
          ? `<span class="view__stats-sep">•</span>`
          : "";
        return `<span>${s}</span>${sep}`;
      }).join("")
    : `<span>—</span><span class="view__stats-sep">•</span><span>—</span><span class="view__stats-sep">•</span><span>—</span>`;

  view.innerHTML = `
    <header class="view__header">
      <h1 class="view__title">${title}</h1>
      <div class="view__stats">${statsHTML}</div>
    </header>
    <div class="view__body">
      <div class="empty-state">
        <svg class="empty-state__icon" aria-hidden="true"><use href="#icon-${emptyIcon}"></use></svg>
        <p class="empty-state__title">${emptyTitle}</p>
        <p class="empty-state__hint">${emptyHint}</p>
      </div>
    </div>
  `;

  return view;
}
