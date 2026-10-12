# Crate — roteiro de QA manual (Soulseek)

Roteiro da spec (`docs/superpowers/specs/2026-08-07-crate-in-app-downloads-design.md`
§9, "Só com slskd de verdade"). Automatizado é impossível por definição: exige a
rede Soulseek real, o slskd real da cmr-auto (`cmr-auto-rp`) e o acervo real em
`~/Music`. Rodar **uma vez por release** que toca `src/slsk/**`, `src/views/Crate.tsx`,
`store/crate.ts` ou o crate `slskd-client`.

## Pré-requisitos

1. Release publicada e instalada na cmr-auto:
   ```bash
   gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber
   sudo dpkg -i /tmp/rustify-player_*.deb
   ```
   Fechar e reabrir o app depois do `dpkg -i` — hot-reload não cobre binário novo.
2. slskd rodando na cmr-auto (`docker ps | grep slskd`), conta `cmr-auto-rp` logada
   e `network: Connected` (confirmar no app: badge da Crate no verde, ou
   `slsk_status` via MCP bridge).
3. Túnel SSH pro MCP bridge (inspeção do app real, se for usar):
   ```bash
   ssh -f -N -o ExitOnForwardFailure=yes -L 9223:localhost:9223 cmr-auto@100.102.249.9
   # driver_session: host=127.0.0.1 port=9223
   ```
4. Anotar o estado do acervo ANTES de começar (`Library` → contagem total) — os
   casos de download real vão mudar esse número; serve de baseline pra conferir
   que o `IngestPaths` funcionou.

## Casos

### 1. Busca com resultado

- Abrir Crate (sidebar ou `⌘K` → "Procurar ... na rede →").
- Digitar uma query com resultado esperado (artista conhecido, faixa popular).
  Confirmar: **nada dispara ao digitar** — só ao apertar `⏎` ou clicar `[Buscar]`.
- Esperar os resultados aparecerem progressivamente (poll de 800ms). Confirmar:
  - Linhas agrupadas por faixa (não por arquivo/peer) — `N fontes ▾` > 1 quando
    múltiplos peers têm a mesma faixa.
  - Badge de formato (`FLAC NN/NN`) presente.
  - Clicar `N fontes ▾` expande a lista de peers com caminho remoto completo,
    `livre`/`fila N`, e eventual `⚠` de warn (live/duração destoante).
  - Coluna de duração preenchida quando o slskd reporta `length`.

### 2. Busca vazia

- Buscar algo praticamente garantido de não existir (string aleatória, ex.
  `zzqxvimprovavel123`).
- Confirmar: empty-state claro (`Nada encontrado`), sem erro no console, sem
  travar o campo de busca pra buscas seguintes.

### 3. Download completo até tocar

- Buscar uma faixa que **não** está no acervo.
- Confirmar precedência de destino (spec §4.5): se o artista já tem pasta no
  acervo, o chip já vem preenchido (`→ <Playlist> ▾`); senão, `→ escolher ▾`
  em âmbar e `[Baixar]` abre o seletor em vez de baixar.
- Escolher/confirmar destino, clicar `[Baixar]`.
- Acompanhar a transição de estados na linha (ou na aba Fila): `aguardando
  vaga` → `na fila do peer` → progresso (`%` + `MB/s`) → `organizando…` →
  `indexando…` → `✓ em <Playlist>` com botão `[▸ Tocar]`.
- Clicar `[▸ Tocar]` — confirmar que a faixa toca de verdade (não só troca de
  estado visual).
- Confirmar no disco: `~/Music/<Playlist>/<Artista>/<Ano - Álbum>/<NN - Título>.flac`
  (layout canônico de 4 níveis, spec §5.4) — **não** a pasta bruta do peer.
- Confirmar que `~/Music/.rustify-incoming/` está vazio depois (staging
  atômico não deixou resíduo).
- Conferir contagem da Library: subiu em 1 desde o baseline.

### 4. Faixa que já está no acervo (dedup)

- Buscar uma faixa que **já** está no acervo local.
- Camada 1 (confiável): banner `ⓘ Já tens no acervo: <Artista> — <Título>` com
  `[▸ Tocar]` deve aparecer logo após a busca (usa a string digitada, Qdrant
  local — sem round-trip de rede).
- Camada 2 (advisory, por linha): a linha correspondente mostra chip `no
  acervo` + `[▸ Tocar]`, **sem** botão `[Baixar]` — mas o menu/expansão
  continua acessível pra "baixar mesmo assim" se o usuário insistir (versão
  alternativa, remaster).
- Confirmar que nada é baixado automaticamente — dedup é aviso, nunca bloqueio
  silencioso.

### 5. Troca de fonte (peer com fila longa)

- Buscar algo com pelo menos 2 fontes visíveis na expansão, uma delas com
  `fila N` alto (ou provocar isso escolhendo deliberadamente a fonte mais
  lenta/enfileirada na expansão em vez do `best`).
- Baixar dessa fonte. Esperar a linha entrar em `stalled` (sem progresso por
  ~2 min) ou observar `enqueued` com posição não decrescendo.
- Clicar `[Trocar fonte]`. Confirmar: o job volta pra fila local com uma fonte
  diferente (`tried_source_ids` não deixa repetir a mesma), sem precisar
  buscar de novo (troca de fonte é `enqueue`, não consome o pacer de busca).
- Confirmar que depois de 1 falha automática + 1 troca manual falha de novo,
  o job vira `Failed` visível com `[Tentar outra fonte]` (não trava calado).

### 6. slskd derrubado no meio

- Com pelo menos 1 download em `downloading`/`enqueued`, parar o container:
  ```bash
  ssh cmr-auto@100.102.249.9 'docker stop slskd'
  ```
- Confirmar: badge de status vai pra "não responde em 127.0.0.1:5030" (sem
  crash do app, boot intacto se reiniciar o app agora). Jobs ativos viram
  `Failed{retryable}` em vez de ficarem girando pra sempre.
- Subir o slskd de novo:
  ```bash
  ssh cmr-auto@100.102.249.9 'docker start slskd'
  ```
- Confirmar: badge volta pro verde sozinho (poll de status, sem precisar
  reiniciar o app). Buscar de novo funciona.
- Fechar e reabrir o app com o slskd ainda fora do ar — confirmar que o boot
  **não trava** (o padrão "nunca panic por slskd fora do ar" da spec §3.3).

### 7. Leva de 20 faixas

- Baixar ~20 faixas em sequência rápida (de buscas diferentes, ou expandindo
  uma busca com múltiplos resultados e baixando vários).
- Confirmar: cap de 3 downloads concorrentes respeitado (o resto fica
  `Queued` visível, não silencioso) — olhar a aba Fila.
- Confirmar: nenhum 409 do slskd (histórico de searches cheio) — se acontecer,
  a mensagem deve ser humana ("o slskd estava com o histórico cheio — limpei
  o que deu, tenta em instantes"), nunca um código HTTP cru vazando pra UI.
- Ao final, `[Limpar concluídos]` (se presente) ou reload da view remove os
  terminais da lista sem afetar os ativos.
- Conferir a Library: a leva inteira apareceu, sem duplicata, sem faixa
  "sumida" (comparar contagem antes/depois com o número de sucessos).

## Casos da fase 1: SoundCloud in-app (v0.2.87)

Pré-requisitos extras na cmr-auto: `~/.secrets/soundcloud-oauth.txt` (token do
Chrome, 0600), `ffmpeg` no PATH. O status das fontes aparece no topo do Crate
(SoundCloud: token ok / sem token / API fora; ffmpeg; uv).

### SC-1. Busca com seção SoundCloud

- Buscar "mandelão". Confirmar: a seção SoundCloud responde em até 2 s, com
  chips de formato (WAV / FLAC / MP3 320 / MP3 128) e o Soulseek vai
  preenchendo embaixo, sem bloquear.

### SC-2. Download de original WAV até tocar

- DJ WIN "Vou Voltar Nada" (WAV, ~24 MB). Clicar Baixar: card pré-preenchido
  (artista, título, ano, playlist sugerida) com "WAV · 23 MB". Confirmar.
- Confirmar: progresso, `Processing` (conversão para FLAC + tags + capa),
  `Ready`, a faixa toca. Arquivo em `~/Music/<playlist>/DJ WIN/<ano> - Vou
  Voltar Nada (MC Braz e Rick)/01 - Vou Voltar Nada (MC Braz e Rick).flac` com
  tags e `cover.jpg` na pasta; no Qdrant, `embedding_status: done` em até 2 min.

### SC-3. MP3 128 recusado

- DJ Piu "Bumbum na Nuca" (MP3 128). Confirmar: chip "MP3 128 · não entra",
  Baixar desabilitado, texto do motivo sem duplicação. MP3 320 entra, marcado
  `source: lossy mp3` no COMMENT.

### SC-4. Sem token

- Renomear `~/.secrets/soundcloud-oauth.txt` temporariamente e reabrir o Crate.
  Confirmar: status "sem token", card explica, nada baixa. Restaurar o arquivo;
  o status volta sem reiniciar o app.

### SC-5. Comandos durante download

- Enquanto SC-2 baixa, pela ponte MCP: `slsk_jobs` responde em menos de 2 s
  (o coordinator não bloqueia no worker externo).

### SC-6. Duplo clique e falha recuperável

- Duplo clique em Baixar: um job só na Fila.
- Derrubar a rede no meio de um download: o job vai a `Failed` e "Tentar de
  novo" aparece na linha; ao clicar, o job volta a `Queued`.

Nunca: `[tidal]` na fila do Soulseek; token do SoundCloud em log ou na UI
(`read_logs` pela ponte sem o valor); portas do app fora de 127.0.0.1.

## Registro

Depois de rodar, anotar no PR/commit ou em comentário do issue Linear (CMR-XX
correspondente): quais dos 7 casos (e dos 6 SC) passaram, o que falhou, e se algo exigiu
`dpkg -i` de novo no meio do teste (indicaria mudança de contrato Rust não
coberta pelo `.deb` já instalado).
