# Contexto: Lyrics (sync fallback + quebra de verso) e intake de ~180 faixas de rap

**Data:** 2026-06-13
**Sessao:** main
**Duracao:** sessao longa (multi-tema)

---

## O que foi feito

Tres frentes, partindo de uma pergunta sobre lyrics e evoluindo pra intake de musica.

### 1. Auditoria de cobertura de lyrics (diagnostico, via Qdrant)

O payload `embedded_lyrics` (Qdrant `rustify_tracks`) guarda o LRC completo COM
timestamps inline — o Qdrant e a fonte unica pra auditar (artista/genero junto).
A distincao "alinhado de verdade vs chutado" sai da **regularidade dos
timestamps**: delta variavel = alinhamento real; delta constante = distribuicao
uniforme (fake).

Resultado (1124 tracks): 596 sem lyrics, 325 alinhado_real (≈175 lrclib synced
da fonte + ≈150 nosso wav2vec2), 202 plain sem sync, 1 resquicio Whisper.
A separacao 175/150 e inferida pela assinatura do bug (linha-monstro /
quebra-curta-maiuscula), nao por metadado — nao ha campo `source`.

### 2. Frente A — fix do fallback de exibicao de lyrics (Rust, RELEASED)

**Bug:** `query.rs::get_lyrics`, quando `lrc_path` nao e arquivo no disco, caia
num fallback que exibia `embedded_lyrics` cru (`.lines()` com `t=0.0`). Como
`embedded_lyrics` E um LRC com timestamps, o sintoma era letra SEM sync + com
`[mm:ss]` literal no texto. Afetava 9 tracks (`lrc_path=None` apos ingestao sem
sidecar: Smino, Noname "Ace", Saba, Baby Keem, Chet Baker, Howlin' Wolf, etc).

**Fix (TDD):** nova `lyrics::lyrics_from_embedded(text)` — parseia via `parse_lrc`
quando ha timestamps (sync + texto limpo); so cai pra texto plano quando nao ha
(preserva as 35 plain). `get_lyrics` passou a chama-la. 3 testes novos
(regressao do bug + nao-regressao plain). Released **v0.2.32** (`dev` rolling).

### 3. Frente B — fix da quebra de verso no wav2vec2 (Python, NAO EXECUTADO)

`align_lyrics.py` quebrava versos por heuristica `raw_words[i][0].isupper()`:
quebrava em nome proprio/"I"/"DJ" e nao quebrava nada em texto lowercase
(linha-monstro). Trocado por `segment_by_verses()`, que respeita as quebras de
verso ja presentes no `scraped-texts/` (letras.com versejado) e cola o timestamp
real da 1a palavra de cada verso. Fonte trocada de `output-v2` (Whisper, lixo)
para `scraped-texts`. Funcao pura testavel (sem GPU); propriedade de
consistencia de tokenizacao validada nos 240 scraped-texts reais.

**Bloqueio:** re-alinhar as ~150 exige audio. Os stems vocais (`stems-v2/`)
SUMIRAM (so no Modal). E o audio foi alinhado contra `output-v2` (Whisper) que
DIVERGE de `scraped-texts` — entao a correcao exige re-alinhar contra
`scraped-texts`. Decisao de infra pendente (ver Pendencias #1).

### 4. Intake de ~180 faixas de rap + arrumacao da playlist

193 flac estavam em `~/slskd_dados/downloads/` (cmr-auto), fora de `~/Music`.
`stage_downloads.py` (mutagen + Qdrant) classificou: 5 ja_no_acervo, 7
dup_interno (mantem maior bitrate), 181 novo → movidos pra
`~/Music/Rap & Hip-Hop/<album>/`. Indexados via `run_scan` (Qdrant 1124→1303).
Arrumacao: 3 nao-rap realocados (ASOT→Trance, Odelay+Bloodiest→Rock); downloads
restante (12 + restos) → `~/_descartados_musica/` (nao deletado).

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src-tauri/crates/library-indexer/src/lyrics.rs` | Modificado | +`lyrics_from_embedded()` + 3 testes |
| `src-tauri/crates/library-indexer/src/query.rs` | Modificado | `get_lyrics` fallback usa `lyrics_from_embedded` |
| `scripts/align_lyrics.py` | Modificado | +`segment_by_verses`/`count_norm_tokens`, fonte→scraped-texts, removida heuristica maiuscula + `GAP_THRESHOLD` |
| `scripts/test_align_lyrics.py` | Criado | 11 checks, runner asserts-puros (padrao do projeto) |
| `scripts/curator/stage_downloads.py` | Criado | dedup interno + vs Qdrant; dry-run/`--apply` |

Filesystem cmr-auto (nao versionado): `~/Music/Rap & Hip-Hop` 274→452 flac;
Trance 100→101; Rock 97→99; `~/slskd_dados/downloads` zerado.

## Commits desta sessao

```
2938e72 fix(lyrics): fallback de embedded_lyrics parseia LRC (sync + texto limpo)
c0dc34c fix(lyrics): quebra de verso pela estrutura do texto-fonte, nao maiuscula
c5a12a3 feat(curator): stage_downloads.py — move slskd downloads -> playlist com dedup
```
Tudo em `origin/main` (push feito; main estava ahead 30, fast-forward).

## Decisoes tomadas

- **Fallback de lyrics: parsear, nao exibir cru** | embedded_lyrics e LRC valido; reusar `parse_lrc` resolve sync+texto. Descartado: tratar como plain (mantinha o bug).
- **Quebra de verso pela estrutura do texto-fonte** | scraped-texts ja vem versejado; timestamp por palavra do wav2vec2 e real. Descartado: "gap + pontuacao" (heuristica fraca); heuristica maiuscula (a origem do bug).
- **Re-align via audio full (recomendado), nao re-separar stems** | stems sumiram; re-separar via Modal e desproporcional pra corrigir quebra de linha. NAO executado.
- **Playlist = pasta 1o nivel; intake move pra Rap & Hip-Hop** | modelo do `list_folders`. Genero classificado por ARTISTA, nao genre tag (tags sao lixo: A$AP=Dubstep, Coolio=Blues). Boom bap/trap = rap.
- **NAO consolidar pastas-album fragmentadas** | cosmetico: playlist e por 1o nivel, todas contam como Rap & Hip-Hop. Risco de colisao, zero efeito no app.
- **Forcar scan via `touch`** | watcher recursivo tem race com subpasta recem-criada; touch num flac vigiado dispara `run_scan` full.

## Metricas

| Metrica | Valor |
|---------|-------|
| Qdrant points | 1124 → 1303 |
| Rap & Hip-Hop (flac) | 274 → 452 |
| Faixas movidas / dedup | 181 movidas, 5 ja_acervo, 7 dup_interno |
| Nao-rap realocados | 3 (ASOT, Odelay, Bloodiest) |
| MERT embedding pending (fim) | 57 (decrescendo, era 130) |
| Testes | library-indexer 74 pass; align_lyrics 11 checks |
| Lyrics bug fallback corrigidas | 9 tracks |
| Release | v0.2.32 (`dev`) |

## Pendencias identificadas

1. **Re-align das ~150 wav2vec2** (alta, decisao de infra) — codigo pronto; executar exige audio. Opcoes: (A) audio full na VM (recomendado), (B) re-separar stems via Modal. Stems locais nao existem; FLACs estao na cmr-auto. Rodar 2-3 piloto antes da leva.
2. **MERT pending** (baixa, automatico) — ~57→0 sozinho; so monitorar `embedding_status` no Qdrant.
3. **Consolidacao de pastas-album** (baixa, cosmetico) — IGOR x4, blkswn x3, etc. Opcional.
4. **Dedup fino vs acervo** (baixa) — `stage_downloads` foi conservador (artist+title); pode ter escapado duplicata por tag divergente.
5. **`lrc_path=None` na ingestao** (media) — raiz do bug das 9; fix A tornou inofensivo pra exibicao, mas a ingestao das tracks novas nao gravou sidecar/lrc_path.
6. **Validacao do usuario** — confirmar no app (0.2.32) que as 9 tracks sincronizam (`[mm:ss]` sumiu do texto, highlight acompanha).
