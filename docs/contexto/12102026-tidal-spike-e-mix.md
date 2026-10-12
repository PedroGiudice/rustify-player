# Tidal: spike, primeiro mix e o que fica para a fase 3 (12/10/2026)

## Decisões do CEO

- Assinou a Tidal em 12/10/2026 e autorizou o spike.
- **Nada da Tidal vai para o Soulseek.** Mecanismo: marca ` [tidal]` na pasta do álbum
  + `shares.filters: ['\[tidal\]']` no `slskd.yml` da cmr-auto. Verificado pela API depois
  de reescanear: 3363 arquivos antes e depois de 113 FLAC da Tidal entrarem no acervo.
- Links de mix/álbum vêm da aba do Chrome na cmr-auto (Compartilhar > Copiar link).
- O login é aprovado no browser logado, por Claude in Chrome, sem senha no chat.

## O que o spike mediu

| Item | Resultado |
|---|---|
| Conta | `PREMIUM`, `highestSoundQuality = HI_RES` |
| Login por device code (`login_oauth`) | só entrega FLAC em faixa com `HIRES_LOSSLESS`; faixa só `LOSSLESS` vem como `HIGH` (AAC 320), inclusive pedindo `LOSSLESS` (python-tidal #404) |
| Login PKCE (`tidal_login_pkce.py`) | `LOSSLESS` 16/44,1 e `HI_RES_LOSSLESS` 24 bit, ambos DASH/FLAC |
| Entrega | DASH fMP4, remux `ffmpeg -c:a copy` para .flac, sem recodificar |
| Ritmo | 10 a 22 s por faixa com pausa de 2 s |
| streamrip 2.1.0 | 403 HTML no endpoint de token; descartado |

Álbum do spike: DJ K - Pânico no Submundo (15 faixas, 24/44,1), ingerido via
`tidal_dl_spike.py` + `tidal_ingest.sh` (normalize_release), créditos por faixa da Tidal.

## Mix "DJ Petroski" (artist radio), 99 faixas

Relatório: `12102026-tidal-mix-dj-petroski.json`. Script: `scripts/curator/tidal_mix_dl.py`.

- 98 baixadas (1,7 GB): 66 em LOSSLESS 16/44,1; 32 em hi-res (24/44,1, 24/48, uma 24/96).
- 1 pulada por já estar no acervo ("Pump It", DJ GBR). Dedup por título+artista soltos.
- 0 falhas depois do PKCE (a primeira rodada, em OAuth, falhou em 26 faixas só-LOSSLESS).
- Indexação: o watcher só pega as pastas novas com o app aberto; com o app fechado nada
  entra. Com o app aberto, a varredura do boot pegou as 80 que faltavam; MERT fechou
  em ~20 min (113/113).
- Vibe: 98 anotadas em workflow (3 lotes Opus em paralelo, validação de vocabulário em
  código): 67 high, 25 medium, 2 low, 94 anotações distintas. Quatro vieram com o número
  da faixa trocado no caminho; mapeadas pelo número da linha do TSV.
  Arquivo: `data/enrichments/2026-10-12-opus-vibe-annotations-tidal-petroski-98.json`.
- Letra: `lyrics_status` fica `None` em tudo que entra pelo watcher (vale também para o
  Bandcamp de hoje); o backfill do boot é quem fecha. Não é específico da Tidal.

## Cobertura do catálogo sobre o piloto funk BR

`12102026-tidal-cobertura-candidatos.json` (`scripts/curator/tidal_coverage.py`, só busca):
54 dos 121 candidatos do piloto estão na Tidal; dos 23 artistas da brecha, 17 têm
álbuns lá (MC Kevin o Chris 17, RORO 17, MU540 14, Iguana 9, DJ Jeeh FDC 7, DJ Alexia 5,
DJ Arana 5, Adame DJ 5, GORDÃO DO PC 5, DJ Piu 4, DJ K 3, DJ Blakes 3, OO Rubinho 2,
Halc DJ 2, DJ GB Faixa Preta 2, DJ GBR 1, DJ Ramon Sucesso 1) e 6 não têm nada
(Dudu Coupper, L da Vinte, XABLAU, DJ Anderson do Paraíso, Zero de Fato, DJ Ricardo Paiva).

## Gotchas pagos

- A ponte do Chrome redige `code=` das URLs; o code do PKCE sai do histórico do Chrome
  (`~/.config/google-chrome/Default/History`, copiar o SQLite) e entra no tmux por
  `send-keys`, sem imprimir.
- `tmux kill-session` não mata o `uv run` na hora: conferir `pgrep -f "[t]idal_mix_dl"`
  antes de relançar, senão dois processos escrevem na mesma pasta.
- O nome das pastas de ARTISTA novas aparece no share do slskd como diretório vazio
  (ex.: "DJ Zigão"); nenhum arquivo. Cosmético; decisão em CMR-295.

## Pendências

- CMR-295: Tidal como terceira fonte do Crate (fase 3), depois da fase 1 (SoundCloud) e
  da fase 2 (Bandcamp).
- CMR-296: MERT por nome fixo em `desktop.rs` (causa das três semanas de `failed`).
- Levas manuais até a fase 3: `tidal_mix_dl.py <id>` com link do CEO; o `--list` mostra
  o que viria antes de baixar.
