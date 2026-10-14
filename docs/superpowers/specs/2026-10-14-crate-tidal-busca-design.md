# Crate > Tidal: busca por texto com prévia e seleção

**Data:** 2026-10-14 · **Status:** aprovado pelo CEO ("pode seguir com a busca da Tidal com prévia")
**Base:** aba Tidal do Crate (0.2.88, CLAUDE.md > Crate > "Aba Tidal no Crate"), fila da VM
(`scripts/curator/tidal_fila.py`), baixador `scripts/curator/tidal_mix_dl.py`.

## 1. Uso

Hoje, para baixar algo da Tidal, o CEO abre a Tidal no Chrome, acha a faixa, copia o link
(Compartilhar > Copiar link) e cola no Crate. Com a busca, ele digita no próprio Crate e baixa.
Playlist, rádio e álbum abrem uma prévia com caixa de marcar por faixa, para não encher o acervo
de faixas que ele nunca escolheu (um rádio da Tidal tem 100 faixas, ~30 min e 3-6 GB).

Funcionou quando: o CEO para de abrir a Tidal no Chrome para baixar; resultado em menos de 1 s
depois que ele para de digitar (busca medida em 262-334 ms na VM em 14/10, mais o salto da tailnet).

Só desktop. Fora de escopo: discografia inteira de um artista em um clique (Orochi tem 14 álbuns e
101 EPs/singles), vídeos, ouvir trecho antes de baixar, CMR-297 (troca por qualidade).

## 2. Fatos medidos (tidalapi 0.8.11, sessão PKCE da VM, 14/10)

- `session.search(q, limit)` devolve `artists`, `albums`, `tracks`, `videos`, `playlists`, `top_hit`.
- Faixa: `audio_quality` sempre `LOSSLESS`; o hi-res aparece em `media_metadata_tags`
  (`HIRES_LOSSLESS`). Uma mesma faixa volta em várias versões (original, coletânea, remaster):
  álbum e ano precisam aparecer para o CEO escolher.
- Rádio não vem na busca. Nasce de artista (`Artist.get_radio_mix()`) ou de faixa
  (`Track.get_radio_mix()`): um `Mix` com id e 100 itens, em ~0,6 s. O baixador já aceita mix.
- Playlist traz `num_tracks` e `duration`.
- O baixador já aceita link de mix, playlist, álbum e faixa (`parse_ref` em `tidal_mix_dl.py`).

## 3. Arquitetura

Mantém a decisão de 13/10: **a aba Tidal fala com a fila da VM**, nunca com a Tidal direto.
Zero Python no desktop, zero host novo no CSP. A fase 3 (CMR-295) troca o motor sem mexer na tela.

```
Crate (Solid) --invoke--> Rust (ureq, tidal_fila.rs) --tailnet--> tidal_fila.py (VM) --tidalapi--> Tidal
                                                                     |
                                                                     +-- fila --> tidal_mix_dl.py --rsync--> cmr-auto ~/Music
```

### 3.1 Fila da VM (`tidal_fila.py`), rotas novas sob `/<token>/api/`

| Rota | Devolve |
|---|---|
| `GET busca?q=` | `{q, top, faixas[], albuns[], artistas[], playlists[]}`; até 10 por tipo; vídeos fora |
| `GET artista/<id>` | `{id, nome, foto, populares[10], albuns[], eps_singles[], radio:{mix_id, n_faixas}}` |
| `GET previa?ref=` | `{tipo, titulo, ref, faixas[], duracao_s}`; `ref` aceita link ou `mix:<id>`, `playlist:<uuid>`, `album:<id>`, `radio-faixa:<id>` |
| `POST fila` | o de hoje `{url, playlist}` **ou** `{faixas:[ids], titulo, origem, playlist}` (máx. 200 ids) |

Faixa: `{id, titulo, artistas[], album, album_id, ano, duracao_s, hires, capa, url}`.
Álbum: `{id, titulo, artista, ano, n_faixas, duracao_s, hires, tipo, capa, url}`.
`capa` = URL da imagem da Tidal (320 px); o app nunca a carrega direto no WebView (ver 3.3).
Erros: sessão inválida -> 503 `{"error": "sessão da Tidal expirada"}`; texto vazio ou com menos de
2 caracteres -> 400. Cache em memória por 5 min (busca, artista, prévia) para não repetir chamada.

### 3.2 Baixador (`tidal_mix_dl.py`)

Modo seleção: `--ids 1,2,3 --titulo "Rádio Orochi"` baixa exatamente essas faixas pelo mesmo
caminho de hoje (pula o que está no acervo ou já na cmr-auto, envio com retry, `.lrc`, `rc=2` para
o que não chegou). COMMENT `source: tidal <tier>; selecao <origem>`. O job da fila guarda
`faixas`, `titulo` e `origem`; o resumo mostra o título.

### 3.3 App: Rust (`src-tauri/src/slsk/tidal_fila.rs`)

Commands novos: `crate_tidal_search(q)`, `crate_tidal_artist(id)`, `crate_tidal_preview(reference)`,
`crate_tidal_cover(url)`; `crate_tidal_enqueue` ganha `track_ids` e `title` opcionais. Capa pelo
padrão do `crate_sc_artwork`: o Rust baixa e devolve `data:` URL (o CSP não ganha
`resources.tidal.com`). Token nunca em log, erro ou evento (`host_port` já redige).
Timeout: 8 s para busca/artista/prévia.

### 3.4 App: tela (aba Tidal do Crate)

O `Crate.tsx` tem 2.377 linhas: a aba vai para componente próprio
(`src/views/crate/TidalTab.tsx`), com helpers puros testados em `src/lib/tidalSearch.ts`.

- **Um campo só.** Link da Tidal -> fluxo de hoje. Texto com 2+ caracteres -> busca 500 ms depois
  da última tecla; Enter busca na hora; Esc limpa. Resposta atrasada de busca antiga é descartada.
- **Resultados** em seções, o "top" primeiro: Faixas (lista densa), Álbuns (lista com capa 40 px),
  Artistas, Playlists. Cada faixa: capa, título, artistas, álbum · ano, duração (`tabular-nums`),
  selo "Hi-Res" discreto, marca "no acervo" (`dedupMatch` do Crate, contra a biblioteca local).
  Ações da faixa: Baixar, Rádio (abre prévia do rádio da faixa). Álbum: Baixar direto; clicar na
  linha abre a prévia. Playlist: clicar abre a prévia.
- **Artista**: página dentro da aba (voltar com Esc ou "Busca" no topo): Populares (10), Álbuns,
  EPs e singles, botão "Rádio do artista".
- **Prévia**: cabeçalho (título, tipo, nº de faixas, duração); lista com caixa de marcar por faixa;
  vêm desmarcadas as que estão no acervo; "Marcar todas", "Desmarcar todas", "Só as novas";
  rodapé "18 de 100 · ~1,1 GB · ~6 min" + pasta de destino (o seletor que a aba já tem) + Baixar.
  Estimativa: 6 MB/min de áudio em qualidade de CD, 12 MB/min em hi-res; 17 s por faixa (medido no
  Peace Piece em 13/10). Barra de espaço marca a faixa focada; Ctrl+A marca todas.
- **Estados desenhados**: vazio ("Cole um link da Tidal ou busque por faixa, álbum, artista ou
  playlist"), carregando (o campo mostra que está buscando, sem pular layout), nada encontrado,
  fila indisponível (como hoje), Tidal sem resposta.
- **Visual**: tokens do `extractor-lab.css`, Instrument Sans, no máximo 3 tamanhos e 2 pesos por
  tela, ícones Lucide, um acento só. Sem seta "->" em botão, sem sobretítulo em caixa-alta.

## 4. Testes

- Python: rotas (busca vazia, sessão inválida, ref inválida), validação do POST com `faixas`,
  modo `--ids` do baixador (`test_tidal_mix_dl.py`).
- Rust: (de)serialização dos tipos, token ausente das mensagens de erro.
- TS: classificação link x texto, estimativa de tamanho/tempo, seleção padrão (desmarca acervo),
  descarte de resposta atrasada.
- QA no app real pela ponte MCP: buscar "Orochi", abrir o artista, abrir o rádio, desmarcar, baixar
  3 faixas e ver chegarem em `~/Music`.

## 5. Ordem de release

A fila da VM sobe primeiro (é retrocompatível: o POST antigo segue valendo); depois o .deb.
