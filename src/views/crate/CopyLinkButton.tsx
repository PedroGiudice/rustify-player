/* ============================================================
   views/crate/CopyLinkButton.tsx — botão "copiar link" do Crate
   (SoundCloud, Bandcamp, jobs da Tidal). Saiu do Crate.tsx para a
   aba Tidal usar sem importar a view.
   ============================================================ */

import { createSignal, onCleanup, Show } from "solid-js";
import { Icon, ICONS } from "../../components/Icon";

/** Link externo (página do SoundCloud, gate de terceiros, compra no
    Bandcamp). O app não abre URL: a capability do opener concede só o
    reveal-item-in-dir (CLAUDE.md, "não alargar"), e um <a target=_blank>
    cai no `open_url` do plugin, negado — o clique morria sem fazer nada.
    O botão copia o link para colar no navegador; sem clipboard, a URL
    aparece selecionável no lugar do botão. Abrir direto no Chrome
    depende de o CEO liberar `opener:allow-open-url` com escopo. */
export function CopyLinkButton(props: { url: string; label: string; hint: string; quiet?: boolean }) {
  const [st, setSt] = createSignal<"idle" | "ok" | "err">("idle");
  let timer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(timer));
  async function copy(e: MouseEvent) {
    e.stopPropagation();
    try {
      if (!navigator.clipboard) throw new Error("sem clipboard");
      await navigator.clipboard.writeText(props.url);
      setSt("ok");
      clearTimeout(timer);
      timer = setTimeout(() => setSt("idle"), 2500);
    } catch (err) {
      console.warn("[crate] não deu pra copiar o link:", err);
      setSt("err");
    }
  }
  return (
    <Show
      when={st() !== "err"}
      fallback={<span class="crate-link-url" title="Copie e cole no navegador">{props.url}</span>}
    >
      <button
        type="button"
        class={`crate-btn${props.quiet ? " crate-btn--quiet" : ""}`}
        title={`${props.hint} · ${props.url}`}
        onClick={copy}
      >
        <Icon name={st() === "ok" ? ICONS.check : ICONS.externalLink} size={12} />
        {st() === "ok" ? "Link copiado" : props.label}
      </button>
    </Show>
  );
}
