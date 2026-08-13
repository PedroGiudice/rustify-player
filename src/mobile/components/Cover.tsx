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
  const [failed, setFailed] = createSignal(false);
  const src = createMemo(() => (failed() ? null : assetSrc(props.path)));
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
        <img src={src()!} alt="" loading="lazy" decoding="async" onError={() => setFailed(true)} />
      </Show>
    </div>
  );
}
