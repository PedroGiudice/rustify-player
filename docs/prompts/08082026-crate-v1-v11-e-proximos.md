# Retomada: pós-Crate — bug das lyrics, autoplay, curadoria nova

## Contexto rápido

O Crate (busca + download Soulseek in-app) está SHIPADO e instalado na
cmr-auto: v0.2.62 (v1 completa, etapas A-E), v0.2.63 (fix do cold falso do
pacer — outcome por busca fechada, não por poll), v0.2.64 (v1.1 visual do
handoff claude design) e v0.2.65 (quality_label na Fila). 293 testes Rust +
257 frontend verdes, tudo pushado, releases na tag `dev`. O app roda
NATIVAMENTE na cmr-auto; SSH/túneis são só ferramenta de teste da VM.

Três frentes agora, por ordem: o bug das letras no download do Crate, a
verificação do autoplay (session-awareness), e uma leva nova de curadoria.

## Arquivos principais

- `docs/contexto/08082026-crate-v1-v11-e-proximos.md` — contexto detalhado
- `CLAUDE.md` (seção "Crate") — arquitetura, destino, guard-rails, gotchas
- `src-tauri/crates/library-indexer/src/lyrics_fetch.rs` — worker de letras
- `src-tauri/src/slsk/coordinator.rs` — `send_lyrics_job` no `try_ingest`
- `docs/soulseek/manual-qa.md` — QA manual do Crate (7 casos, rede real)

## Próximos passos (por prioridade)

### 1. Bug: download do Crate veio sem letra ("1010", Djonga)
**Onde:** `lyrics_fetch.rs` (worker `slsk-lyrics`) + `coordinator.rs`
(`send_lyrics_job`) + pipeline de lyrics do indexer.
**O que:** systematic-debugging, hipóteses na ordem:
(H1) o `.lrc` FOI escrito no disco mas `lrc_path`/vetor lyrics só entram no
Qdrant no backfill de STARTUP — o sidecar chega DEPOIS do IngestPaths, letra
só aparece após reiniciar o app. (H2) lrclib não tem a faixa synced (rap BR).
(H3) worker não rodou. (H4) tags ruins na query.
**Por que:** se H1, é gap de design da Etapa E — fix = disparar
`set_payload(lrc_path)`/mini-backfill após `write_sidecar_if_absent`.
**Verificar:**
```bash
# o sidecar existe? (decide H1 vs H2/H3)
ssh cmr-auto@100.102.249.9 'ls -la ~/Music/*/Djonga/*/ | grep -i 1010'
# lrclib tem a faixa?
curl -s "https://lrclib.net/api/get?artist_name=Djonga&track_name=1010" | head -c 400
# logs do worker no app real (túnel 9223 + read_logs, filtrar slsk-lyrics)
```

### 2. Verificar o autoplay (session-awareness v0.2.61)
**Onde:** app real via túnel MCP (`ssh -f -N -L 9223:localhost:9223
cmr-auto@100.102.249.9`; driver_session host=127.0.0.1 port=9223).
**O que:** validar ao vivo: station abre com lote 8, `lib_station_next`
incremental sem overlap, skip <35% trunca cauda + topup, `context_id` nos
play_events, autoplay fora de station.
**Por que:** pedido explícito do usuário; a v0.2.61 validou no lançamento mas
o uso real acumulou dados novos desde então.
**Verificar:** `ipc_execute_command` nos comandos de station + inspeção de
play_events no Qdrant (túnel 16333, collection rustify_tracks/play_events).

### 3. Curadoria nova (leva de sugestões)
**Onde:** subagente `music-curator` + motores `scripts/curator/`.
**O que:** rodar os dois motores e curar. **O SUBAGENTE SÓ SUGERE — NUNCA
BAIXA** (reforço enfático do usuário). Aprovação humana → download: faixas
avulsas pelo próprio Crate (o usuário baixa no app); leva grande via
`baixar_soulseek_teste.py` na cmr-auto (fluxo do CLAUDE.md, conta
`cmr-auto-rp`, limpar searches acumuladas do slskd antes).
**Por que:** acervo em expansão ativa; o usuário pediu mais tracks.
**Verificar:** túnel `ssh -f -N -L 16333:localhost:6333
cmr-auto@100.102.249.9` de pé antes dos motores; pós-leva, fechar o loop
(faixas novas indexadas no Qdrant — gotcha do watcher: touch força rescan).

## Restrições

- Loopback-only na cmr-auto — NUNCA reabrir binds pra 0.0.0.0.
- RTK mangla pipes: `rtk proxy` pra git/cargo raw; sem grep encadeado em gate.
- Subagentes de execução: **Opus com effort low** (via Workflow
  `opts.effort`; Agent tool não tem parâmetro de effort). Reviews: pelo
  coordenador (ordem vigente do usuário).
- Avisar o usuário SÓ com entrega pronta ou bloqueio real.
- Guard-rails do pacer ficam como estão (decisão fechada pós-fix).

## Como verificar (smoke)

```bash
cd /home/opc/rustify-player
npm run typecheck && npx vitest run          # 257 passed
rtk proxy cargo check --manifest-path src-tauri/Cargo.toml
rtk proxy git log --oneline -3               # HEAD = 30df19c (v0.2.65)
```
