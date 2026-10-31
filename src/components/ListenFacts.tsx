/* ============================================================
   components/ListenFacts.tsx — escuta viva e qualidade medida no
   cabeçalho de Álbum e Artista (B11, varredura de 31/10).

   "ouvido até o fim 12 vezes · última há 3 dias" e "12 sem corte ·
   1 lossy", com o mesmo ponto do selo de qualidade da barra (verde
   medido, âmbar lossy, neutro sem medição). Dado de `lib_listen_stats`
   (play_events pelo cache do motor), relido depois de mover faixas.

   Informação de apoio: enquanto carrega, ou se a leitura falhar, a
   linha simplesmente não aparece (o cabeçalho e as faixas seguem).
   ============================================================ */

import { createResource, For, Show } from "solid-js";
import { libListenStats } from "../tauri";
import { libraryRevision } from "../store/moveDialog";
import { listenLine, qualityParts } from "../lib/listenSummary";
import { peek, settle } from "../lib/loaded";

export interface ListenFactsProps {
  /** Artista (Artista) ou artista + álbum (Álbum). null = ainda sem chave. */
  query: { artist: string | null; album?: string | null } | null;
}

export function ListenFacts(props: ListenFactsProps) {
  const [res] = createResource(
    () => {
      const q = props.query;
      if (!q || (!q.artist && !q.album)) return false;
      return { artist: q.artist, album: q.album ?? null, rev: libraryRevision() };
    },
    (q) => settle(libListenStats({ artist: q.artist, album: q.album })),
  );
  const stats = () => { const r = peek(res); return r?.ok ? r.data : null; };

  return (
    <Show when={stats()}>
      {(s) => {
        const listen = () => listenLine(s());
        const parts = () => qualityParts(s().quality);
        return (
          <Show when={listen() || parts().length > 0}>
            <p class="lib-hero__facts">
              <Show when={listen()}>{(l) => <span>{l()}</span>}</Show>
              <Show when={listen() && parts().length > 0}>
                <span class="lib-hero__sep">·</span>
              </Show>
              <For each={parts()}>
                {(p, i) => (
                  <>
                    <Show when={i() > 0}><span class="lib-hero__sep">·</span></Show>
                    <span class="lib-hero__q" data-tone={p.tone} title={p.title}>
                      <span class="lib-hero__q-dot" aria-hidden="true" />
                      {p.label}
                    </span>
                  </>
                )}
              </For>
            </p>
          </Show>
        );
      }}
    </Show>
  );
}
