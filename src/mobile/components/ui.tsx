/* ============================================================
   ui.tsx — peças repetidas do handoff (viewhead, topbar,
   sec-head, empty) + lista incremental.

   LazyList é adição do v0: o acervo tem ~1.7k faixas e o
   protótipo desenhava 8. Montar 1.7k linhas (cada uma com uma
   capa) de uma vez trava o WebView; o crescimento por sentinela
   mantém o scroll fluido sem mudar o desenho da lista.
   ============================================================ */

import { For, Show, createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { Icon } from "../icons";
import { back } from "../nav";

export function ViewHead(props: { title: string; sub?: string; right?: JSX.Element }) {
  return (
    <div class="viewhead">
      <div>
        <h1>{props.title}</h1>
        <Show when={props.sub}>
          <div class="sub">{props.sub}</div>
        </Show>
      </div>
      {props.right}
    </div>
  );
}

export function TopBar() {
  return (
    <div class="topbar">
      <button class="iconbtn back" aria-label="Voltar" onClick={() => back()}>
        <Icon.back />
      </button>
      <span class="sp" />
    </div>
  );
}

export function SecHead(props: { label: string; link?: { label: string; onClick: () => void } }) {
  return (
    <div class="sec-head">
      <div class="eyebrow">{props.label}</div>
      <Show when={props.link}>
        {(l) => (
          <button class="sec-head-link" style={{ background: "none", border: 0, color: "var(--t3)", "font-size": "11px", "font-family": "inherit" }} onClick={l().onClick}>
            {l().label} →
          </button>
        )}
      </Show>
    </div>
  );
}

export function Empty(props: { title: string; hint?: string }) {
  return (
    <div class="empty">
      <div class="e1">{props.title}</div>
      <Show when={props.hint}>
        <div class="e2">{props.hint}</div>
      </Show>
    </div>
  );
}

export function LazyList<T>(props: {
  items: T[];
  chunk?: number;
  children: (item: T, index: () => number) => JSX.Element;
}) {
  const chunk = () => props.chunk ?? 60;
  const [limit, setLimit] = createSignal(chunk());
  let sentinel: HTMLDivElement | undefined;

  createEffect(() => {
    props.items.length;
    setLimit(chunk());
  });

  onMount(() => {
    if (!sentinel || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) setLimit((v) => v + chunk());
    });
    io.observe(sentinel);
    onCleanup(() => io.disconnect());
  });

  return (
    <>
      <For each={props.items.slice(0, limit())}>{(item, i) => props.children(item, i)}</For>
      <div ref={sentinel} style={{ height: "1px" }} aria-hidden="true" />
    </>
  );
}
