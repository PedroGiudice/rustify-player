/* ============================================================
   Cover.tsx — capa com fallback.

   O mock do handoff pintava todo cover/art com um TONE (paleta de
   8 tons escuros). Aqui o TONE continua sendo o fundo/placeholder:
   se a faixa tem album_cover_path, ele é coberto pela imagem real
   (convertFileSrc); se não tem — ou se a imagem falha — fica o tom
   com o ícone, exatamente como no protótipo.
   ============================================================ */

import { Show, createMemo, createSignal } from "solid-js";
import { assetSrc } from "../ipc";
import { toneFor } from "../derive";
import { Icon } from "../icons";

export function Cover(props: {
  path?: string | null;
  seed: string | number;
  cls?: string;
  icon?: "note" | "disc" | "person";
}) {
  // A falha é da CAPA, não da instância (mobile-6): no mini e no NP o Cover
  // sobrevive à troca de faixa (Show não keyed) e só o path muda. Um booleano
  // grudava o placeholder em todas as faixas seguintes.
  const [failedPath, setFailedPath] = createSignal<string | null>(null);
  const src = createMemo(() => {
    const p = props.path ?? null;
    return p && p === failedPath() ? null : assetSrc(p);
  });
  const tone = createMemo(() => toneFor(props.seed));
  const Glyph = () => {
    const k = props.icon ?? "note";
    return k === "disc" ? <Icon.disc /> : k === "person" ? <Icon.person /> : <Icon.note />;
  };
  return (
    <div
      class={props.cls ?? "cov"}
      style={{
        background: `var(--tone-${tone()})`,
        "border-color": `var(--tone-${tone()}-b)`,
      }}
    >
      <Show when={src()} fallback={<Glyph />}>
        <img src={src()!} alt="" loading="lazy" decoding="async" onError={() => setFailedPath(props.path ?? null)} />
      </Show>
    </div>
  );
}
