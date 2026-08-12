# Retomada: Crate catálogo (busca "como o Spotify") + automação de embeddings

## Contexto rápido

A sessão de 2026-08-12 fechou o ciclo do sinal do autoplay (v0.2.68,
publicada na tag `dev`): coleta consertada (origins reais), behavioral
signals por BALANÇO LÍQUIDO com peso contínuo de listen_pct e piso de
atenção 90s, régua automática diária (timer na VM + hook SessionStart que
injeta o veredito em toda sessão deste repo). Detalhes:
`docs/contexto/12082026-sinal-v3-fechado-crate-catalogo.md` e
`docs/contexto/12082026-autoplay-vistoria-sinal-v3.md`.

O próximo trabalho, combinado com o CEO, tem DUAS frentes acopladas:

**A. Crate catálogo** — a busca do Crate hoje é literal contra arquivos de
peers Soulseek. O desenho aprovado em espírito: buscar num CATÁLOGO
(MusicBrainz: artista → release-groups → recordings; capas via Cover Art
Archive por MBID — o CEO notou que capas são fáceis, e são: URL direta
`https://coverartarchive.org/release-group/<mbid>/front-250`, sem
scraping), badge "no acervo"/"faltando" contra rustify_tracks, e o
Soulseek vira só backend de aquisição (busca slskd com query canônica ao
clicar). Fase 1 = artista/faixa + discografia + capas + badge + download 1
clique. Fase 2 = similares (ListenBrainz), popularidade, álbum inteiro.

**B. Automação de embeddings ("crucial", palavra do CEO)** — track baixada
precisa entrar no motor COMPLETA e sozinha: vetor MERT (768d, áudio),
letra (.lrc) + embedding de letra (1024d), anotação de vibe
(energy/valence/moods). Estado: MERT 1746/1746 (aparenta automático);
lyrics vector 1233/1746 = 70,6% (embedding depende de
RUSTIFY_LYRICS_EMBED_URL → cogmem :3939 na VM = dependência de tailnet,
provável causa do gap); vibe é batch manual (CMR-178). Sem a frente B, a
frente A degrada o motor a cada download (track sem vetor não é
recomendável; sem vibe compete com 0.5 neutro no re-rank).

## Arquivos principais

- `docs/contexto/12082026-sinal-v3-fechado-crate-catalogo.md` — contexto desta sessão
- `docs/superpowers/specs/2026-08-07-crate-in-app-downloads-design.md` — spec do Crate v1 (fonte da verdade; a Fase 2 "álbum inteiro" pendente conversa com o catálogo)
- `src-tauri/src/slsk/` + `src-tauri/crates/slskd-client/` — máquina de download existente (coordinator, JobBoard, staging, IngestPaths)
- `src-tauri/crates/library-indexer/src/pipeline.rs` e `embed_client.rs` — ingest e embedding MERT (auditar aqui o automático vs manual)
- `src-tauri/crates/library-indexer/src/lyrics_fetch.rs` — worker de .lrc via lrclib (pós-download do Crate)
- `src/views/Crate.tsx` — UI atual da busca literal
- `scripts/curator/discover.py` — referência de uso de MusicBrainz/ListenBrainz (resolve_mbid, rate limit, cache)

## Próximos passos (por prioridade)

### 1. Auditar o pipeline de embeddings de track nova (frente B, diagnóstico)
**Onde:** `pipeline.rs`/`embed_client.rs` (MERT), `lyrics_fetch.rs` +
busca por `RUSTIFY_LYRICS_EMBED_URL` no `lib.rs` (letra), e no Qdrant da
cmr-auto (túnel :16333) contar tracks com vetor mert/lyrics vs total.
**O que:** mapear o que roda sozinho no ingest, o que falha silencioso, o
que é manual. Em particular: por que 513 tracks não têm vetor de letra
(sem .lrc? embed indisponível? nunca re-tentado?).
**Por que:** "crucial" (CEO) — sem isso o catálogo degrada o motor a cada download.
**Verificar:** números de cobertura por vetor + lista de causas.

### 2. Fechar a automação (frente B, implementação)
**Onde:** conforme o passo 1; provável: retry/fila de embedding pendente no
indexer (tracks com embedding_status != done re-tentadas no boot e após
IngestPaths), fallback/health do embed de letras, e gancho de anotação de
vibe (CMR-178 — decidir com o CEO: batch periódico vs LLM no ingest).
**O que:** track nova → MERT + .lrc + embedding de letra + vibe sem ação manual.
**Por que:** fecha o "entra no motor completa e sozinha".
**Verificar:** baixar 1 track de teste via Crate na cmr-auto e conferir no
Qdrant os 2 vetores + enrichment em minutos, sem intervenção.

### 3. Spec da Fase 1 do catálogo (frente A)
**Onde:** `superpowers:brainstorming` → spec em `docs/superpowers/specs/`.
**O que:** cliente MusicBrainz no backend Rust (rate limit 1 req/s,
User-Agent obrigatório, cache local de discografias com TTL longo), Cover
Art Archive pras capas, comandos Tauri (busca artista/faixa, discografia),
UI no Crate (entidades com badge de acervo, clique → busca slskd
pré-formada reaproveitando o coordinator atual). NÃO tocar no pacer
Soulseek (a rede pune burst; o catálogo REDUZ buscas na rede por design).
**Por que:** é a "sensação Spotify" pedida; o desenho foi aprovado em espírito.
**Verificar:** spec aprovada pelo CEO antes de codar (decisões de UI dele).

### 4. Implementar Fase 1 + gates + release
**Onde:** conforme spec; release única no final (`./scripts/release.sh`),
lembrar o CEO do `dpkg -i` + restart na cmr-auto.
**Verificar:** `cargo test --workspace`, `npm run typecheck`, `npx vitest run`.

## Restrições

- NÃO comparar skip-rate por origin com dados pré-v0.2.66 (origins mudaram
  de significado). A régua injetada no início da sessão já usa o cutoff certo.
- NÃO reintroduzir: threshold binário de listen_pct, weight por repetição
  nos positives (inócuo sob best_score), transition de CSS var no `:root`.
- Pacer/cold-down do Soulseek são invioláveis.
- Verificar se a v0.2.68 foi instalada na cmr-auto (`dpkg -l rustify-player`
  via SSH) — se não, lembrar o CEO antes de qualquer análise da régua.

## Como verificar (ambiente)

```bash
# Túnel Qdrant cmr-auto (idempotente)
ssh -f -N -o ExitOnForwardFailure=yes -L 16333:localhost:6333 cmr-auto@100.102.249.9
curl -s http://127.0.0.1:16333/collections | head -c 200   # 3 collections

# Gates
cargo check --manifest-path src-tauri/Cargo.toml
npm run typecheck

# Régua (roda sozinha 09:00; à mão:)
python3 scripts/metrics/autoplay_regua.py
```
