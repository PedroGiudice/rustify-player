# Contexto: Busca, Lyrics sync, Ícones offline + limpeza de títulos

**Data:** 2026-06-27
**Sessão:** main
**Duração:** sessão longa (multi-tema)

---

## O que foi feito

Quatro frentes, partindo de dois bugs reportados (busca "amari" não acha; lyrics
das músicas novas dessincronizadas) que se desdobraram.

### 1. Busca de tracks reescrita client-side (v0.2.33/0.2.34)

`query::search` usava filtro Qdrant `match:{text}` em title/artist/album. Diagnóstico
INICIAL (errado p/ o ambiente real): atribuí o bug a fallback case-sensitive por
falta de índice — reproduzido num Qdrant local SEM índice. **Mas na cmr-auto o índice
existe e cobre os 1303 pontos**, e a busca antiga já era case-insensitive e
multi-palavra order-independent. O bug real (descoberto só ao validar no ambiente
real): o título da faixa "Amari" é **`a m a r i`** (letras espaçadas — formatação do
rip do álbum The Off-Season). Nenhuma busca textual casava.

Fix em camadas (todas em `query.rs`):
- `norm()` (lowercase Unicode + strip acento PT-BR) + `match_score()` com tokenização
  AND order-independent (busca "artista faixa" em qualquer ordem, cross-field).
- `squish()` fallback: quando o token-match falha, casa ignorando espaços/pontuação
  (`squish("a m a r i") == "amari"`). Resolve qualquer título estilizado.
- `QdrantClient::scroll_all_full` (qdrant_client.rs): scroll paginado de payload
  completo, excluindo `embedded_lyrics` do hot path.
- `CommandPalette.tsx`: debounce 150ms no input.
- 13 testes (single + multi-palavra + título espaçado). Validado no pool real:
  `amari`→`a m a r i`, `my life`, `kendrick lamar` (4000 score), `saba`→`SABÁKI`.

### 2. Lyrics sincronizadas via lrclib (`scripts/curator/sync_lyrics.py`)

As ~180 faixas de rap novas nunca passaram pelo alignment. Novo script roda NA
cmr-auto (Qdrant local + FLACs): detecta sem-sync, recupera sidecars órfãos, busca
LRC synced no **lrclib.net** (HTTP, sem GPU). Grava sidecar `<flac>.lrc` +
`set_payload` lrc_path no Qdrant (app lê em runtime via `get_lyrics`, sem re-scan).
`destyle()` desfaz título estilizado pro lrclib casar. **Aplicado: 374 sem-sync →
131 synced** (91 de rap). 184 misses = instrumental/eletrônica/jazz/funk-BR.

### 3. Ícones Iconify bundle offline (v0.2.35)

Dívida adiada em 06/06, nunca feita. Ícones vinham de `code.iconify.design` (web
component) + `api.iconify.design` (SVGs sob demanda). Sem internet → custom element
não registra → TODOS invisíveis. Diagnóstico ao vivo via tauri-mcp:
`customElements.get('iconify-icon')`=false, 0/30 com SVG. Fix: `src/icons-offline.ts`
(addCollection lucide inteiro + addIcon ph:heart-fill hardcoded), removido `<script>`
da CDN e os domínios iconify do CSP. Confirmado pelo usuário ("corrigiu").

### 4. Limpeza de títulos The Off-Season (`scripts/curator/clean_titles.py`)

12 títulos estilizados → legíveis (`a m a r i`→`amari`, `punchin' the clock`),
fiéis ao álbum oficial. Reescreve tag FLAC (mutagen) + title no Qdrant. Agora a
busca acha por match normal além do squish.

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src-tauri/crates/library-indexer/src/query.rs` | Modificado | search reescrita + norm/match_score/field_score/squish + 13 testes |
| `src-tauri/crates/library-indexer/src/qdrant_client.rs` | Modificado | +scroll_all_full (exclui embedded_lyrics) |
| `src/components/CommandPalette.tsx` | Modificado | debounce 150ms (debouncedQuery) |
| `src/icons-offline.ts` | Criado | registro offline iconify (lucide + ph:heart-fill) |
| `src/main.tsx` | Modificado | import "./icons-offline" no topo |
| `index.html` | Modificado | removido `<script src=code.iconify.design>` |
| `src-tauri/tauri.conf.json` | Modificado | CSP sem domínios iconify; version 0.2.32→0.2.35 |
| `package.json` / `package-lock.json` | Modificado | +iconify-icon +@iconify-json/lucide |
| `scripts/curator/sync_lyrics.py` | Criado | sync lyrics via lrclib |
| `scripts/curator/clean_titles.py` | Criado | des-estiliza títulos |

cmr-auto (não versionado): 131 sidecars `.lrc` + lrc_path no Qdrant; 12 títulos do
The Off-Season reescritos (FLAC tag + Qdrant). App instalado: v0.2.35.

## Commits desta sessão

```
1c18f58 fix(icons): bundle Iconify offline, remove dependência de CDN
3328c4b feat(curator): clean_titles.py — des-estiliza títulos com letras espaçadas
172fc9f feat(lyrics): sync_lyrics.py — busca LRC synced no lrclib pras faixas sem sync
34af3d8 fix(search): casa títulos estilizados com letras espaçadas (J. Cole "a m a r i")
bb32f23 fix(search): busca client-side case/acento-insensitive + multi-palavra
```
Todos em `origin/main` (push feito). 3 releases dev: 0.2.33→0.2.34→0.2.35.

## Decisões tomadas

- **Busca client-side, não corrigir o índice Qdrant** | robusta contra estado do índice + dá substring/acento/squish. Espelha `query::search_playlists` que já era client-side. Descartado: depender do `match:{text}`.
- **squish como fallback, não normalização sempre** | só quando token-match falha; evita falsos positivos. Needle mín. 3 chars.
- **Lyrics via lrclib, não wav2vec2** | HTTP sem GPU, cobre o grosso (131/374). wav2vec2 (cauda instrumental) é desproporcional.
- **Ícones: coleção lucide inteira (556K), não subset** | carrega do disco, não rede — tamanho irrelevante; subset adicionaria script de build + manutenção. ph:heart-fill hardcoded (evita 4MB da coleção ph).
- **Limpar títulos (tag+Qdrant), não renomear arquivos** | sidecar .lrc casa por filename; mudar só tag+title preserva o casamento.
- **VALIDAR NO AMBIENTE REAL (cmr-auto), não em proxy** | erro caro desta sessão: diagnóstico de case-sensitivity feito em Qdrant local sem índice não refletia o real.

## Métricas

| Métrica | Valor |
|---------|-------|
| Testes library-indexer | 91 pass (era 74) |
| Lyrics sync | 374 sem-sync → 131 synced (945→1060 synced_any) |
| Rap com sync | 302 → 393 |
| Títulos limpos | 12 (The Off-Season) |
| Bundle frontend | 72KB → 666KB (lucide local) |
| Versão | 0.2.32 → 0.2.35 (instalada na cmr-auto) |

## Pendências identificadas

1. **Right-click (context menu) não abre no resultado da busca** (ALTA — próximo foco).
   `CommandPalette.tsx` renderiza os items com `onClick` (play) mas SEM `onContextMenu`.
   Os TrackRow normais usam `openTrackMenu(e, track, {list, onPlay})` de
   `store/contextMenu.ts`; o `<TrackContextMenu/>` é singleton montado no App
   (App.tsx:98). Falta wirar no palette. Pontos de atenção no prompt de retomada.
2. **Algumas faixas não tocam** (ALTA) — ex confirmado: "5% TINT" (Travis Scott,
   ASTROWORLD). Não é só uma; padrão não caracterizado. Playback é GStreamer
   (`crates/audio-engine/`); suspeita de formato/sample-rate na pipeline. NÃO investigado
   (abortado a pedido do usuário). Roteiro de diagnóstico no prompt de retomada.
3. **184 lyrics misses** (baixa) — instrumental/eletrônica/jazz/funk-BR sem cobertura
   lrclib. Cauda precisaria wav2vec2/GPU (ver `project_lyrics_scraping_pipeline`).
4. **Bundle 666KB** (baixa, cosmético) — lucide inteiro; subset cortaria ~540K. Irrelevante p/ desktop.
