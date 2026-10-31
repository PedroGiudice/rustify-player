/* ============================================================
   components/RadioExcluded.tsx — "Fora do rádio" (B9, varredura 31/10).

   As faixas que o autoplay e as stations não tocam, com o motivo em
   números: as que o dono tirou ("nunca no rádio", "fora desta
   station") e as que o motor tirou sozinho (pulada cedo 3+ vezes
   quando ele a serviu, nunca ouvida até o fim, sem curtida). Antes a
   saída era para sempre e a tela nunca dizia.

   Mora na Stations, não na Library: é o que o MOTOR deixa de fora, e
   os escopos das recusas são as próprias stations (o id vira nome aqui).
   A Library lista o que o dono tem; isto lista o que o rádio evita.

   [Devolver ao rádio] tira as recusas e perdoa os pulos cedo, com
   Desfazer no aviso (lib/radioRefusal). A lista relê a cada mudança
   (radioRevision), inclusive as feitas pelo menu de contexto.
   ============================================================ */

import { createResource, For, Show } from "solid-js";
import { coverUrl, libRadioExcluded, type RadioExcludedTrack } from "../tauri";
import { CoverArt } from "./CoverArt";
import { Icon } from "./Icon";
import { EmptyState } from "./EmptyState";
import { openTrackMenu } from "../store/contextMenu";
import { exclusionText } from "../lib/radioWhy";
import { radioRevision, returnToRadio } from "../lib/radioRefusal";
import { settle, peek } from "../lib/loaded";

const ICON_RETURN = "lucide:undo-2";

export interface RadioExcludedProps {
  /** Nome da station pelo id; undefined = station apagada. */
  stationName: (id: string) => string | undefined;
}

export function RadioExcluded(props: RadioExcludedProps) {
  const [res, { refetch }] = createResource(radioRevision, () => settle(libRadioExcluded()));
  const loaded = () => peek(res);
  /** A lista lida; null enquanto carrega ou se falhou. */
  const list = () => { const l = loaded(); return l?.ok ? l.data : null; };

  return (
    <section class="rx" aria-labelledby="rx-title">
      <div class="section__head">
        <h2 class="section__title" id="rx-title">
          Fora do rádio
          <Show when={(list()?.tracks.length ?? 0) > 0}>
            <span class="rx__count"> · {list()!.tracks.length}</span>
          </Show>
        </h2>
        <span class="section__hint">O autoplay e as stations não tocam estas faixas.</span>
      </div>

      <Show
        when={loaded()}
        fallback={<EmptyState compact tone="carregando" title="Lendo o que o rádio deixa de fora…" />}
      >
        {(_) => (
          <Show
            when={list()}
            fallback={
              <EmptyState
                compact
                tone="erro"
                title="Não consegui ler o que está fora do rádio."
                actions={[{ label: "Tentar de novo", onClick: () => void refetch() }]}
              />
            }
          >
            {(list) => (
              <>
                <Show when={!list().familiarity_ready}>
                  <p class="rx__note">
                    O motor ainda está carregando: por enquanto só aparecem as que você tirou.
                  </p>
                </Show>
                <Show
                  when={list().tracks.length > 0}
                  fallback={<p class="rx__note">Nada fora do rádio. Pelo menu de uma faixa dá para tirá-la.</p>}
                >
                  <div class="row-list">
                    <For each={list().tracks}>
                      {(t) => <ExcludedRow track={t} stationName={props.stationName} />}
                    </For>
                  </div>
                </Show>
              </>
            )}
          </Show>
        )}
      </Show>
    </section>
  );
}

function ExcludedRow(props: { track: RadioExcludedTrack; stationName: (id: string) => string | undefined }) {
  const t = () => props.track;
  return (
    <div class="rx-row" onContextMenu={(e) => openTrackMenu(e, t())}>
      <CoverArt
        seed={t().album_title || t().id}
        src={coverUrl(t().album_cover_path)}
        size="sm"
        class="row__cover"
      />
      <div class="rx-row__meta">
        <div class="row__title" data-trunc>{t().title || "—"}</div>
        <div class="row__sub" data-trunc>
          {t().artist_name || "—"}
          {t().album_title && <> · {t().album_title}</>}
        </div>
        <div class="rx-row__why">{exclusionText(t().radio, props.stationName)}</div>
      </div>
      <button
        type="button"
        class="pl-action-btn rx-row__return"
        aria-label={`Devolver “${t().title || "faixa"}” ao rádio`}
        onClick={() => void returnToRadio(t())}
      >
        <Icon name={ICON_RETURN} size={13} />
        <span>Devolver ao rádio</span>
      </button>
    </div>
  );
}
