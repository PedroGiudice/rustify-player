---
paths:
  - "src/views/Crate.tsx"
  - "src/views/crate/**"
  - "src/store/crate.ts"
  - "src/lib/tidal*.ts"
  - "src/lib/dedup.ts"
  - "src/lib/trackMetaGuess.ts"
  - "src-tauri/src/slsk/**"
  - "src-tauri/crates/slskd-client/**"
  - "src-tauri/crates/soundcloud-client/**"
  - "scripts/curator/tidal_fila.py"
---

# Crate: busca e download in-app (Soulseek, SoundCloud, Tidal)

Movido do CLAUDE.md em 31/10/2026 (o mapa ficou com uma linha apontando para cá).

## Desde a v0.2.62

Aba **Crate** (sidebar abaixo de Search, rota `/crate`, entrada pelo ⌘K):
busca na rede Soulseek via slskd local da cmr-auto e baixa direto pro
acervo, com validacao, dedup e indexacao automatica. Substitui o fluxo
CSV+scp+script pra **faixas avulsas**; levas grandes de curadoria continuam
no `baixar_soulseek_teste.py`. Spec (fonte da verdade, com adendo do spike
da API real): `docs/superpowers/specs/2026-08-07-crate-in-app-downloads-design.md`.
QA manual roteirizado: `docs/soulseek/manual-qa.md`.

- **Backend**: `src-tauri/crates/slskd-client` (protocolo puro, fixtures
  reais) + `src-tauri/src/slsk/` (coordinator em thread unica `slsk-coord`,
  JobBoard escritor unico com 11 estados tagged `kind`, staging em
  `.rustify-incoming` + rename atomico pro layout canonico
  `~/Music/<playlist>/<Artista>/<Album>/`). Indexacao deterministica via
  `IndexerCommand::IngestPaths` (devolve track_id por path).
- **Letras junto**: worker paralelo `slsk-lyrics`
  (`library-indexer/src/lyrics_fetch.rs`) consulta lrclib.net pos-download.
  Canal bounded(64), try_send — nunca bloqueia o coordinator. Desde
  v0.2.69 ele FECHA O CICLO via `LyricsSink` (`QdrantLyricsSink`, injetado
  por `IndexerHandle::lyrics_sink`): grava payload + vetor `lyrics` na hora,
  em vez de esperar o `backfill_lyrics` do proximo boot. Sidecar `.lrc` so
  nasce de letra SINCRONIZADA (a view de letra depende dos timestamps);
  letra `plain` vai pro payload **`lyrics_text`** e alimenta so o vetor —
  ~60% do que o lrclib tem e so plain, e descartar isso custava o vetor.
  Sidecar preexistente nunca e sobrescrito, mas ainda fecha o ciclo.

  **Nunca gravar letra externa em `embedded_lyrics`** (regra dura, v0.2.71):
  aquele campo e a letra das TAGS do arquivo (`metadata.rs` le LYRICS/
  UNSYNCEDLYRICS/USLT, costuma trazer LRC completo) e a aba de letra o
  renderiza como LRC — texto sem timestamp volta com t=0 em todas as linhas
  e o card trava no ultimo verso a musica inteira. Precedencia em
  `resolve_lyrics`: tags > `lyrics_text` > `lrc_path` > sidecar novo no disco.
  No frontend, `isSynced` (NowPlaying.tsx) detecta t=0 em tudo e desliga
  auto-scroll/linha ativa, rotula "unsynced" e torna o viewport rolavel.

  `lyrics_text`/`lyrics_status` NAO vem do arquivo, entao o re-ingest
  (retag muda mtime => `upsert_tracks` faz PUT e reescreve o ponto inteiro)
  os apagaria junto com o vetor; os dois caminhos de ingest preservam esses
  campos e também `indexed_at`, a hora da PRIMEIRA chegada: retag não faz a faixa voltar
  como chegada na Home (`preserved_fields` + `merge_preserved`, `PRESERVED_ON_REINGEST` no
  `pipeline.rs`).
- **Destino**: playlist = pasta de 1o nivel. Precedencia (spec §4.5):
  override da toolbar > artista ja no acervo (`suggested_dest`) > ultimo
  usado (`kv-crate-dest`) > seletor obrigatorio. NUNCA semear o override
  com o ultimo usado (bug IM-D1, corrigido em 63ec14f). Desde 31/10 o
  `kv-crate-dest` é a memória ÚNICA de pasta do Crate inteiro (Soulseek,
  SoundCloud e Tidal); o antigo `kv-crate-tidal-dest` só é lido, como legado.
  Seletor de pasta único: `src/views/crate/FolderPicker.tsx`.
- **Guard-rails de rede**: pacer (min 4s entre buscas, cap 40/h), cold-down
  com banner + "buscar mesmo assim", sweep de searches persistidas no boot.
  Nao contornar — a rede Soulseek pune burst (gotcha na seção music-curator do CLAUDE.md).
- **Config**: `http://127.0.0.1:5030` default; api key via
  `RUSTIFY_SLSKD_API_KEY` ou config file no data dir do app. Creds do
  Soulseek SO em `~/slskd_dados/slskd.yml` na cmr-auto (0600) — nunca em
  log ou disco do app. CSP nao ganha `:5030` (o HTTP e feito no Rust).
- **Opener**: capability restrita a `opener:allow-reveal-item-in-dir`
  (estado `manual` abre o gerenciador de arquivos). Nao alargar.
- **Fontes por job (fase 1, v0.2.87, spec
  `docs/superpowers/specs/2026-10-12-crate-fontes-soundcloud-bandcamp-design.md`,
  plano `docs/superpowers/plans/2026-10-12-crate-soundcloud-fase1.md`)**: o job
  carrega `Source` (`Soulseek{username,remote_filename,size}` |
  `SoundCloud{track_id,permalink_url}` | `Bandcamp{...}`, fase 2), meta confirmada
  pelo CEO no card (artista, título, ano, playlist) e o estado `waiting` (compra ou
  link por e-mail, fase 2). O coordinator roteia por origem: Soulseek segue no slskd;
  fontes externas vão a um worker próprio (`sc_worker.rs`, teto 2 por vez, pacer),
  que baixa o ORIGINAL do SoundCloud (API v2 em `crates/soundcloud-client`, token de
  `~/.secrets/soundcloud-oauth.txt` lido sob demanda, nunca em log/Debug/evento),
  converte para FLAC (`library-indexer/src/transcode.rs`, ffmpeg com teto de tempo),
  escreve tags (`tagwrite.rs`, lofty) e capa JPEG <=1500 px, e entrega ao mesmo
  staging/ingest do Soulseek. Política (CEO, 15/10/2026): só lossless de verdade. MP3
  é recusado já no card (`probe_verdict`: "MP3 320 · não entra (só lossless)") e no
  worker (`RejectReason::LossyFormat`); FLAC com corte espectral de lossy é recusado no
  `stage_file`, que vale para o Soulseek E para o original do SoundCloud
  (`LossyInside`, quarentena `lossy_inside`; no Soulseek, [Trocar fonte] pega outro
  peer). Abaixo de 16 bit/44,1 kHz (pelo cabeçalho, antes da medição) é `BelowCd`;
  mu-law/A-law e PCM 8 bit do SoundCloud são recusados no worker. A medição é injetável no coordinator (`stage::QualityCheck`): os testes de
  tempo dele não medem (`new_sem_medicao`); a medição tem testes no `stage.rs`.
  Config em `sources.json` no data dir (só CAMINHOS de segredo) ou env `RUSTIFY_*`
  (`sources.rs`); status das fontes no topo do Crate (`crate_sources_status`).
  Comandos: `crate_sc_search/resolve/probe/artwork`, `crate_download`,
  `crate_sources_status`; sugestão de artista/título/ano em `src/lib/trackMetaGuess.ts`.
  `canonical_dest` troca `" * : < > ? \ |` por `_` (storage do Android). Desvio
  declarado da spec §5.1/5.3: links externos no Crate são "Copiar link", não "Abrir"
  (capability do opener restrita; abrir URL exige `opener:allow-open-url` com
  allowlist, decisão para a fase 2).
- **Aba Tidal no Crate (v0.2.88, 13/10)**: terceira aba do Crate, "colar link + pasta +
  Baixar". NÃO é cliente Tidal nativo: o app fala com a FILA DA VM (`scripts/curator/
  tidal_fila.py`, API `GET/POST /<token>/api/fila` em `100.64.242.118:8470`) por `ureq` no
  Rust (`src-tauri/src/slsk/tidal_fila.rs`, commands `crate_tidal_jobs`/`crate_tidal_enqueue`);
  a VM baixa e envia para `~/Music` da cmr-auto (seção "Aquisicao Tidal" do CLAUDE.md). Config em
  `sources.rs`: `tidal_fila_url` (env `RUSTIFY_TIDAL_FILA_URL`) e `tidal_fila_token_file`
  (default `~/.secrets/telemetria-token.txt`, só o caminho; o token nunca sai em log/erro,
  `host_port` redige). Estados do job: na fila / baixando / na cmr-auto / parcial / falhou.
  O poll mora no `store/crate.ts` (não na view): `TIDAL_POLL_OPEN_MS` 10 s com a aba Fila ou
  Tidal à vista ou job andando, `TIDAL_POLL_CLOSED_MS` 60 s fora disso, parado com a janela
  oculta ou a VM fora. Helpers puros em `src/lib/tidalFila.ts`.
  Se a VM cair, a aba diz "fila indisponível"; a cmr-auto nunca baixa sozinha. Fase 3
  (CMR-295) troca o motor por download nativo sem mudar a tela.
- **Busca por texto na aba Tidal (v0.2.91, spec
  `docs/superpowers/specs/2026-10-14-crate-tidal-busca-design.md`)**: o mesmo campo aceita link
  (fluxo antigo) ou texto (busca 500 ms após a última tecla; resposta atrasada descartada).
  Resultados Faixas/Álbuns/Artistas/Playlists com "Hi-Res" e "no acervo"; página de artista
  (populares, álbuns, EPs e singles, rádio do artista); prévia de playlist/rádio/álbum com caixa
  por faixa (o que está no acervo vem desmarcado; teto de 200 por PEDIDO no Rust e na fila;
  desde 31/10 a tela divide uma seleção maior em vários pedidos de até 200) e rodapé com tamanho/tempo estimados. Tela em `src/views/crate/TidalTab.tsx` (o
  `Crate.tsx` já tinha 2.377 linhas), helpers em `src/lib/tidalSearch.ts`, `dedupMatch` em
  `src/lib/dedup.ts`. Commands: `crate_tidal_search/artist/preview/cover/resend` e
  `crate_tidal_enqueue` com `track_ids`/`title`/`origin`. Capa da Tidal só via Rust
  (`crate_tidal_cover`, prefixo `https://resources.tidal.com/images/`, `data:` URL): o CSP NÃO
  ganha host da Tidal. A aba fica MONTADA e oculta ao trocar de aba do Crate (preserva busca,
  prévia e página de artista): não voltar a desmontá-la com `<Show>`. Ordem de release: a fila
  da VM sobe antes do .deb (é retrocompatível com o app antigo).
- **v1.1 pendente**: handoff visual do claude design (usuario itera a tela);
  popovers fechando em clique fora; Fase 2 = album inteiro e Bandcamp por link
  (spec §6: NYP/free por `bcdl-free`, pago abre a página e espera a compra).

## Leva Impeccable de 31/10 (varredura 2)

- Jobs da Tidal aparecem na aba **Fila** do Crate junto com os do Soulseek e do SoundCloud,
  e contam no "baixando" e nas chegadas da barra lateral (`store/crate.ts`; antes só na aba
  Tidal).
- Busca guardada por 10 min (`SEARCH_CACHE_MS`) e não cancelada ao sair da tela.
- `TryOtherSource`: Soulseek falhado sem alternativa refaz a fonte atual.
- Erros da fila da VM sem host nem IP no texto; 401/403 = "A fila da Tidal recusou a chave de acesso."
  A frase de fila fora do ar existe em DOIS lugares que precisam ficar iguais: `OFFLINE_MSG`
  (`src-tauri/src/slsk/tidal_fila.rs`) e `FILA_OFFLINE` (`src/views/crate/TidalTab.tsx`).
- Tidal: seleção em massa (arrastar nas caixas, Shift+clique), cartaz de 120 px, artista com foto.
- O Crate é container `crate` com cortes em 1050 e 760 px (largura do container, não da viewport).
- Polls da view (status, fontes, relógio) passam por `pollWhileVisible` (`src/lib/poll.ts`).
- Âmbar no Crate tem papéis: espera normal ("na fila", "baixando") NÃO é âmbar; âmbar é
  "travou" ou pede ação (DESIGN.md, pontos de estado). Um primário por linha
  (`crate-btn--lead`).
