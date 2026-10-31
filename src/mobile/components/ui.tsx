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
import { libError, libReady, reloadLibrary, toast } from "../store";

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
          <button class="sec-head-link" onClick={l().onClick}>
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

/** Falha de carga: diz o que houve e oferece tentar de novo. Uma falha NUNCA
 *  pode aparecer como "vazio" ou "não encontrado" (mobile-12/13/14). */
export function LoadError(props: { title: string; detail?: string | null; onRetry: () => void }) {
  return (
    <div class="empty" role="alert">
      <div class="e1">{props.title}</div>
      <Show when={props.detail}>
        <div class="e2">{props.detail}</div>
      </Show>
      <button class="btn empty__retry" onClick={() => props.onRetry()}>
        Tentar de novo
      </button>
    </div>
  );
}

/** Só mostra o conteúdo com o acervo carregado. Antes disso, "Carregando
 *  biblioteca…"; com a carga em falha, o erro com "tentar de novo" — e não
 *  o "acervo vazio"/"não encontrado" que o conteúdo diria sem dados. */
export function LibGate(props: { children: JSX.Element }) {
  return (
    <Show when={libReady()} fallback={<Empty title="Carregando biblioteca…" />}>
      <Show
        when={!libError()}
        fallback={
          <LoadError
            title="Não deu para carregar a biblioteca"
            detail={libError()}
            onRetry={() => void reloadLibrary()}
          />
        }
      >
        {props.children}
      </Show>
    </Show>
  );
}

/** Toast das confirmações. A região role=status existe SEMPRE e só o texto
 *  entra e sai: live region criada junto com a mensagem não é anunciada de
 *  forma confiável pelo TalkBack (mobile-20). O wrapper é estático e sem
 *  tamanho — o .toast continua posicionado contra o .device. */
export function Toast() {
  // Entrada por keyframe e saída esperando a animação (A61): antes o .toast
  // nascia já com data-on e a transição do CSS nunca corria.
  const [shown, setShown] = createSignal<string | null>(null);
  const [leaving, setLeaving] = createSignal(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  createEffect(() => {
    const msg = toast();
    clearTimeout(timer);
    if (msg) {
      setShown(msg);
      setLeaving(false);
    } else if (shown()) {
      setLeaving(true);
      timer = setTimeout(() => {
        setShown(null);
        setLeaving(false);
      }, TOAST_EXIT_MS);
    }
  });
  onCleanup(() => clearTimeout(timer));
  return (
    <div role="status" aria-live="polite">
      <Show when={shown()}>
        {(msg) => (
          <div class="toast" attr:data-leaving={leaving() ? "" : undefined}>
            {msg()}
          </div>
        )}
      </Show>
    </div>
  );
}

/** --dur-med do tokens.css: a saída do toast. */
const TOAST_EXIT_MS = 180;

/** Subtítulo das telas de acervo: contagens só quando elas são verdade. */
export function libSub(ok: () => string): string {
  if (!libReady()) return "carregando acervo…";
  if (libError()) return "acervo indisponível";
  return ok();
}

/** Lista que cresce por sentinela. `tail`: mostra as ÚLTIMAS N e cresce
 *  para cima (sentinela no topo) — o histórico da fila, onde as vizinhas da
 *  faixa atual são as do fim (A57). O índice entregue é o da lista inteira.
 *  Crescer para cima não pula a tela: o WebView ancora a rolagem. */
export function LazyList<T>(props: {
  items: T[];
  chunk?: number;
  tail?: boolean;
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

  const offset = () => (props.tail ? Math.max(0, props.items.length - limit()) : 0);
  const shown = () => (props.tail ? props.items.slice(offset()) : props.items.slice(0, limit()));
  const mark = <div ref={sentinel} style={{ height: "1px" }} aria-hidden="true" />;

  return (
    <>
      {props.tail ? mark : null}
      <For each={shown()}>{(item, i) => props.children(item, () => offset() + i())}</For>
      {props.tail ? null : mark}
    </>
  );
}
