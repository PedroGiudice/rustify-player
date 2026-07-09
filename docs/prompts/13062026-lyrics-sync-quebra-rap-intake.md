# Retomada: Lyrics (sync + quebra de verso) e intake de rap

## Contexto rapido

Sessao tocou tres frentes no Rustify Player. **Frente A (feita, released):** o
fallback de `get_lyrics` exibia `embedded_lyrics` cru (sem sync, com `[mm:ss]` no
texto) — corrigido pra parsear o LRC; v0.2.32 publicada. **Frente B (codigo
pronto, NAO executada):** a quebra de verso do wav2vec2 usava heuristica de
maiuscula quebrada; trocada por quebra pela estrutura do `scraped-texts`. Falta
re-alinhar as ~150 tracks, o que depende de decisao de infra (audio sumiu).
**Intake (feito):** 181 faixas de rap movidas de `~/slskd_dados/downloads` pra
`~/Music/Rap & Hip-Hop`, indexadas (Qdrant 1124→1303), playlist arrumada.

O app na cmr-auto ja roda o 0.2.32 (fix de lyrics ativo). Tudo commitado e
pushado em `origin/main`.

## Arquivos principais

- `src-tauri/crates/library-indexer/src/lyrics.rs` — `lyrics_from_embedded()` + parser LRC
- `src-tauri/crates/library-indexer/src/query.rs` — `get_lyrics` (fallback corrigido)
- `scripts/align_lyrics.py` — `segment_by_verses()` (le `data/scraped-texts/`, escreve `data/lyrics-v2/`)
- `scripts/test_align_lyrics.py` — testes da segmentacao (sem GPU)
- `scripts/curator/stage_downloads.py` — intake/dedup de downloads → playlist
- `docs/contexto/13062026-lyrics-sync-quebra-rap-intake.md` — contexto detalhado desta sessao

## Proximos passos (por prioridade)

### 1. Re-align das ~150 tracks wav2vec2 (frente B) — DECISAO DE INFRA primeiro
**Onde:** `scripts/align_lyrics.py` (codigo pronto). Insumos na cmr-auto.
**O que:** re-alinhar contra `data/scraped-texts/` pra gerar LRCs com quebra
correta. Stems vocais sumiram → escolher: (A) audio full na VM [recomendado:
instalar torch+torchaudio CPU, baixar modelo MMS, alinhar sobre o FLAC full,
qualidade levemente menor] ou (B) re-separar stems via Modal (BS-Roformer, GPU).
**Por que:** ~150 tracks tem timestamps certos mas versos mal-segmentados.
**Verificar:** rodar 2-3 piloto (101 We Are Scientists, Eminem "My Name Is"),
inspecionar o `.lrc` antes/depois, so entao a leva. Depois re-ingerir os LRCs.
**Antes de codar:** alinhar a decisao A vs B com o usuario (custo/qualidade).

### 2. Validar fix de lyrics no app (frente A)
**Onde:** app na cmr-auto (0.2.32 ja instalado).
**O que:** abrir Nina Simone / Smino "Anita" / Noname "Ace" e conferir.
**Por que:** confirmar que o fallback corrigido sincroniza as 9 tracks.
**Verificar:** `[mm:ss]` sumiu do corpo da letra e o highlight acompanha.

### 3. Monitorar MERT das novas (automatico)
**Onde:** Qdrant `rustify_tracks`, payload `embedding_status`.
**O que:** confirmar `pending` → 0 (eram 57 no fim da sessao).
**Por que:** sem MERT, as novas ficam fora do grafo de recomendacao.
**Verificar:** comando em "Como verificar" abaixo (deve dar `pending: 0`).

### 4. (Opcional) corrigir ingestao `lrc_path=None`
**Onde:** pipeline de ingestao (`src-tauri/crates/library-indexer/src/pipeline.rs`).
**O que:** garantir que tracks novas com lyrics gravem sidecar/`lrc_path`.
**Por que:** raiz do bug A; hoje so mitigado pela exibicao.

## Restricoes / cuidados

- **NAO classificar genero por genre tag** — sao lixo (A$AP=Dubstep, Coolio=Blues). Usar artista. Boom bap e trap = rap.
- **NAO consolidar pastas-album** sem pedido — cosmetico, sem efeito no app.
- Compilar/release: so `./scripts/release.sh` na VM (nao na cmr-auto). `align_lyrics.py` e offline, NAO precisa de release.
- Intake: `stage_downloads.py` nao deleta; sobras vao pra `~/_descartados_musica/`. Apos mover, `touch` num flac vigiado pra forcar `run_scan` (watcher tem race com subpasta nova).

## Como verificar

```bash
# build/testes Rust (na VM)
cd /home/opc/rustify-player/src-tauri && cargo test -p library-indexer --lib 2>&1 | tail -1   # "74 passed"
# testes da segmentacao Python
cd /home/opc/rustify-player && .venv/bin/python scripts/test_align_lyrics.py 2>&1 | tail -1   # "todos os testes passaram"
# estado do acervo + embeddings (cmr-auto via ssh)
ssh cmr-auto@100.102.249.9 'curl -s http://localhost:6333/collections/rustify_tracks | python3 -c "import sys,json;print(json.load(sys.stdin)[\"result\"][\"points_count\"])"'  # ~1303
ssh cmr-auto@100.102.249.9 'curl -s -X POST http://localhost:6333/collections/rustify_tracks/points/scroll -H "Content-Type: application/json" -d "{\"limit\":2000,\"with_payload\":[\"embedding_status\"],\"with_vector\":false}" | python3 -c "import sys,json;from collections import Counter;print(dict(Counter(p[\"payload\"].get(\"embedding_status\") for p in json.load(sys.stdin)[\"result\"][\"points\"])))"'  # pending → 0
```
