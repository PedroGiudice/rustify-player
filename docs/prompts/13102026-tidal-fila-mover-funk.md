# Retomada: QA do mover (0.2.90), separação do funk por MERT (CMR-299), upgrade por qualidade (CMR-297)

<session_metadata>
branch: feat/crate-soundcloud
last_commit: c0dcdeb
releases_publicadas: 0.2.88, 0.2.89, 0.2.90 (instalada na cmr-auto: 0.2.88)
servicos_vm: tmux telemetria (fila Tidal + API, Funnel :10000), rustify-lyrics.timer 08:30, rustify-regua.timer 09:00
issues: CMR-297 (backlog), CMR-298 (in progress, aguarda QA), CMR-299 (proposta aprovada parcialmente)
</session_metadata>

## Contexto rápido

Rustify Player (Tauri 2.11 + Rust + SolidJS; app na cmr-auto, dev na VM). Nesta sessão: o download da
Tidal passou a terminar em `~/Music` da cmr-auto sem flag (VM reconhece o hostname, túnel sozinho,
retry, staging limpo, letra `.lrc` junto); a fila do CEO virou aba "Tidal" no Crate (0.2.88, aprovada);
o embed de letra apontava para a VPS desligada e foi corrigido (0.2.89) com varredura diária de letras
pelo lrclib; o "Mover para playlist…" com migração de histórico (CMR-298) foi implementado e revisado em
2 rodadas (0.2.90, publicada, não instalada). A separação do Funk Brasileiro (CMR-299) tem proposta por
artista commitada; o CEO corrigiu: bruxaria é Funk Brasileiro, e pediu classificação por MERT.

Leia antes de agir: `docs/contexto/13102026-tidal-fila-mover-funk.md` e, no `CLAUDE.md`, as seções
"Mover para playlist (CMR-298)", "Aquisicao Tidal" e "Crate" > "Aba Tidal".

## Arquivos principais

- `src-tauri/crates/library-indexer/src/relocate.rs` — mover com histórico; `tests/relocate_qdrant.rs`
- `src-tauri/src/desktop.rs` — `lib_move_tracks`, `lib_list_playlists`, thread `indexer-events`, `LYRICS_EMBED_DEFAULT`
- `src/components/MoveToPlaylistDialog.tsx`, `src/store/moveDialog.ts`, `src/lib/moveToPlaylist.ts`
- `scripts/curator/funk_split_plan.py` — proposta JSON -> `{dest: [ids]}` para o `lib_move_tracks`
- `docs/contexto/13102026-funk-classificacao-proposta.{md,json}` — proposta (bruxaria já corrigida)
- `scripts/curator/tidal_mix_dl.py`, `tidal_fila.py`, `sync_lyrics.py` — aquisição e letras

## Próximos passos (por prioridade)

### 1. QA do mover na cmr-auto (depende do CEO instalar a 0.2.90 e reabrir o app)
**Onde:** app na cmr-auto; ponte MCP (túnel `-L 9223:localhost:9223` ou 9224, ver `ss -tlnp | grep rustify` lá)
**O que:** roteiro: faixa curtida com plays -> "Mover para playlist…" -> conferir like, letra, similares, `track_enrichments` e `play_events` no id novo (túnel 16333), `.lrc` e capa na pasta nova, pastas vazias removidas; álbum para pasta nova (nome final mostrado, progresso); artista; faixa tocando (segue tocando, próxima toca); pasta `[tidal]` mantém a marca; destino já ocupado -> "falhou" sem mexer.
**Por que:** 0.2.90 só foi validada contra o Qdrant da VM e por testes; o CEO só vê o instalado.
**Verificar:** `dpkg -l rustify-player` = 0.2.90; pela ponte `read_logs` sem erro de `relocate`; `move-journal.json` ausente no data dir após o lote.

### 2. Reclassificar o funk por MERT antes de executar (pedido do CEO)
**Onde:** novo `scripts/curator/funk_mert_classify.py` (túnel 16333; vetor `mert` em `rustify_tracks`, filtro `path` contém `Funk Brasileiro`)
**O que:** âncoras = linhas de confiança alta da proposta já aprovadas pelo CEO (bruxaria/mandelão = Funk Brasileiro; Dubdogz/Vintage Culture/KVSH = Eletrofunk; Petroski/TAIDigital = Mega Funk); para cada faixa restante, k-NN por cosseno nas âncoras (k=7), destino por voto ponderado, confiança pela margem; emitir tabela de DIVERGÊNCIAS contra a proposta atual + `json` no mesmo formato para o `funk_split_plan.py`. Apresentar ao CEO só as divergências e os 41 casos de confiança baixa.
**Por que:** o CEO rejeitou classificação por nome/web; MERT é o sinal acústico que o app já tem.
**Verificar:** âncoras batem com elas mesmas em leave-one-out >= 90%; contagens por destino na saída.

### 3. Executar o lote do funk (depois de 1 e 2, com lista aprovada)
**Onde:** pela ponte, `webview_execute_js` -> `window.__TAURI__.core.invoke('lib_move_tracks', {trackIds: [...], destPlaylist: '...'})` em lotes de 10 (ids como STRING), por destino, a partir de `funk_split_plan.py --out`.
**O que:** rodar com o app aberto e nada tocando; conferir o `MoveReport` de cada lote (ok/falhou/pending); ao fim, `export_manifest.py --deploy` + `phone_push_retry.sh` (CLAUDE.md > Android) para o S24 não gravar plays nos ids antigos; conferir share do slskd inalterado (3363 + só o que entrou fora de `[tidal]`).
**Por que:** mover à mão perde histórico; o lote pelo comando preserva.
**Verificar:** `funk_split_plan.py` rodado de novo devolve 0 a mover; `track_enrichments` com `energy` nos ids novos; Bring Me The Horizon movido à mão para `Rock` via o próprio diálogo.

### 4. CMR-297 passo 1: detecção de upgrade no download da Tidal
**Onde:** `scripts/curator/tidal_mix_dl.py`, ramo `JÁ NO ACERVO`
**O que:** comparar `bit_depth`/`sample_rate` do índice com `get_stream()` da Tidal; se melhor (16 -> 24 bit), baixar para `~/tidal-out/upgrades/<Artista>/<Álbum> [tidal]/` (fora do rsync) e contar `UPGRADES n` no resumo (`tidal_fila.py` mostra). Troca em si espera a tabela de apelidos.
**Por que:** o CEO quer ver quantos upgrades existem de fato antes de decidir a política.
**Verificar:** teste puro da comparação em `test_tidal_mix_dl.py`; rerun do mix DJ Petroski lista candidatos sem mover nada.

### 5. Tabela de apelidos old_id -> new_id (fecha a dívida do S24 e habilita CMR-297 troca)
**Onde:** `library-indexer` (collection ou arquivo no data dir) consultada em `insert_synced_event`, `apply_synced_like`, `log_event`; alimentada pelo `relocate.rs`.

### 6. Telemetria: desligar o Funnel quando o CEO dispensar a página (manter o processo: a aba Tidal usa a API na tailnet)
`sudo tailscale funnel --https=10000 off`; a página fica acessível só na tailnet.

## Como verificar

```bash
cd /home/opc/rustify-player && git status --short && git log --oneline -5
```
```bash
ssh -f -N -o ExitOnForwardFailure=yes -L 16333:localhost:6333 cmr-auto@100.102.249.9; curl -s http://127.0.0.1:16333/collections/rustify_tracks | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['points_count'])"
```
```bash
ssh cmr-auto@100.102.249.9 'dpkg -l rustify-player | tail -1; pgrep -c rustify-player; ss -tlnp | grep rustify'
```
```bash
tmux ls; systemctl --user list-timers rustify-lyrics.timer rustify-regua.timer --no-pager; curl -s -o /dev/null -w "%{http_code}\n" "http://127.0.0.1:8470/$(cat ~/.secrets/telemetria-token.txt)/api/fila"
```
```bash
cd /home/opc/rustify-player && npm run typecheck && cargo check --manifest-path src-tauri/Cargo.toml
```

## Restrições

- NUNCA mover faixa à mão (`mv`): o id é o hash do caminho; só pelo `lib_move_tracks`.
- Nada da Tidal sai do padrão `<Álbum> [tidal]`; o mover preserva a marca e nunca a cria.
- Não compilar no meio de uma leva; `release.sh` só com bump feito. Uma release por leva.
- Subagentes com `model` explícito e "REGRA ZERO: você executa, não delega" no brief; `rustify-player-dev` não serve como executor.
- Segredos (`~/.secrets/*`) nunca em log, chat ou commit. `pgrep -f` via ssh em chamada separada.
- `docs/metrics/regua-*` são do timer: não commitar à mão.
