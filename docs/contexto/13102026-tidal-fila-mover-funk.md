# Contexto: sessão 13/10/2026 — Tidal direto para a cmr-auto, aba Tidal no Crate, letras, mover faixa (CMR-298), separação do funk (CMR-299)

**Data:** 2026-10-13 (madrugada de 14/10)
**Sessão:** branch `feat/crate-soundcloud`; continuação de `docs/contexto/12102026-sessao-tidal-crate-fase1.md`
**Duração:** ~8 h, com 4 subagentes (2 implementadores, 1 revisor em 2 rodadas, 1 analista)

Baseline não repetido aqui: `CLAUDE.md` (seções "Aquisicao Tidal", "Crate" > "Aba Tidal", "Mover para
playlist (CMR-298)"), `docs/contexto/12102026-*.md`.

---

## O que foi feito

### 1. Download da Tidal termina em `~/Music` da cmr-auto sem flag (371b6a2, 92816f9, c80165e)
- `scripts/curator/tidal_mix_dl.py`: `vm_defaults(hostname, env)` decide por hostname (`extractlab` =
  staging `~/tidal-out`, Qdrant pelo túnel 16333, push `cmr-auto@100.102.249.9:Music`); `ensure_tunnel`
  abre o túnel SSH sozinho; `remote_rels` lista por SSH os FLAC `[tidal]` já na cmr-auto (dedup na janela
  app-fechado) e ABORTA antes de baixar se a cmr-auto não responder; `push_one` com 4 tentativas
  (0/5/20/60 s); `drop_local` apaga o staging só do que chegou; `remote_touch` no fim; `rc=2` +
  `NÃO ENVIADAS` para o que ficou; `JÁ BAIXADA, reenviando` em rerun. `TIDAL_PUSH=off`/`--no-push`.
  Testes: `scripts/curator/test_tidal_mix_dl.py` (6, rodar via `uv run --with tidalapi --with mutagen`).
- Fila do CEO movida do scratchpad para `scripts/curator/tidal_fila.py` (tmux `telemetria`, Funnel
  :10000, token em `~/.secrets/telemetria-token.txt` lido de arquivo). Chama o script do repo sem flag;
  estados `fila|baixando|ok|parcial|falhou`; API JSON `GET/POST /<token>/api/fila`, bind também em
  `100.64.242.118:8470`. Cópias em `~/tidal-out/*.py` removidas (única fonte: repo).
- Validado: Peace Piece (Bill Evans) baixou na VM e chegou na cmr-auto com capa em 17 s; faixa já lá
  pulou como `JÁ NA CMR-AUTO`.

### 2. Aba Tidal no Crate (0.2.88; 7c2cde7, fe19f91, ef9689f)
- Sonnet implementou (um `rustify-player-dev` só delegou em círculo e foi descartado; `general-purpose`
  com "REGRA ZERO: não delegue" funcionou). `src-tauri/src/slsk/tidal_fila.rs` (ureq, `host_port`
  redige o token), `sources.rs` (+`tidal_fila_url`, `tidal_fila_token_file`, `tidal` em
  `SourcesStatus`), commands `crate_tidal_jobs`/`crate_tidal_enqueue`, `src/lib/tidalFila.ts`,
  terceira aba em `Crate.tsx`, poll 10 s. Token copiado para `cmr-auto:~/.secrets/telemetria-token.txt`.
- QA pela ponte (porta 9224): 7 jobs "na cmr-auto", `tidal: token_ok`, token ausente do log. CEO:
  "funcionou". Screenshot indisponível (html2canvas ausente no WebKitGTK).

### 3. Defeito das letras e correção (0.2.89; f1ff396)
- Log da cmr-auto: `lyrics backfill: embed falhou ... http://100.123.73.128:3939` (VPS desligada em
  18/09). Toda letra nova falhava em silêncio com timeout de 30 s. `LYRICS_EMBED_DEFAULT` em
  `desktop.rs` = `http://100.64.242.118:3939`; `scripts/embed_lyrics.py` idem. Anotado em CMR-296.
- O app só consulta o lrclib no fluxo do Crate; Tidal/Bandcamp/cópia manual nasciam sem texto. Dois
  remédios (5dd6e9e): `tidal_mix_dl.py` busca letra SINCRONIZADA (`fetch_lrc`) e envia o `.lrc` com o
  FLAC; `sync_lyrics.py` passou a gravar `lyrics_text` (letra sem tempo) e `lyrics_status`
  (synced/plain/instrumental/none), roda NA cmr-auto (`~/sync_lyrics.py`, deploy por scp) todo dia
  08:30 pelo timer `rustify-lyrics.timer` da VM (ssh). Aplicado em 13/10 sobre 729 faixas sem letra:
  61 synced, 35 plain, 11 instrumental, 622 miss. Acervo: 1459 -> 1540 com texto.

### 4. CMR-298 "Mover para playlist…" (0.2.90; 12 commits dbcdd26..3cc5502)
- Opus implementou; Opus revisou em 2 rodadas (2 altos + 5 médios + 8 baixos na 1ª; 4 menores na 2ª;
  tudo corrigido). Detalhes do mecanismo na seção "Mover para playlist (CMR-298)" do CLAUDE.md.
  Essência: move na thread do coordinator, ponto novo com os mesmos vetores, enrichment por PUT,
  play_events reapontados (+ 2ª passada), `move-journal.json` (lista) com replay no boot, EXDEV
  recusado, snapshot do player remapeado pela thread `indexer-events`, preload gapless refeito.
- Gates finais: typecheck limpo; vitest 978; cargo 270 (app) + 238 (library-indexer, 2 ignorados);
  `relocate_qdrant --ignored` contra o Qdrant da VM: passa.
- Dívida permanente registrada: plays/likes do S24 com id antigo se perdem até existir tabela de
  apelidos old_id -> new_id (reexportar manifest logo após mover).

### 5. CMR-299 proposta de separação do funk (eefbea0, c0dcdeb)
- Sonnet analisou disco + Qdrant + web: `docs/contexto/13102026-funk-classificacao-proposta.{md,json}`
  (442 faixas, 150 pastas, 156 linhas). 1ª versão pôs bruxaria (DJ K, DJ Arana, DJ Blakes...) em
  Techfunk; **CEO: bruxaria é Funk Brasileiro** e a classificação deveria ter usado MERT. Corrigido
  (13 linhas voltaram). Plano regenerado por `scripts/curator/funk_split_plan.py` (07439b3): 442 no
  índice; a mover: Eletrofunk 46, Techfunk 16, Mega Funk 10, Eletrônica 4, MPB 2, Rap 2, Country 1
  (81); 361 ficam. NADA foi movido.

### 6. Issues criadas: CMR-297 (upgrade por qualidade: detectar antes de baixar, trocar só com id
   preservado), CMR-298 (In Progress), CMR-299 (decisão do CEO: pastas Funk Brasileiro / Eletrofunk /
   Mega Funk / Techfunk; subgênero = pasta).

## Estado dos arquivos (além dos listados acima)

| Arquivo | Status | Detalhe |
|---|---|---|
| `scripts/curator/tidal_mix_dl.py`, `test_tidal_mix_dl.py` | Mod/Criado | envio automático, letra, 6 testes |
| `scripts/curator/tidal_fila.py` | Criado | fila do CEO + API JSON (antes no scratchpad) |
| `scripts/curator/sync_lyrics.py` | Modificado | plain -> `lyrics_text`, `lyrics_status`, `SYNC_QDRANT` |
| `scripts/curator/funk_split_plan.py` | Criado | proposta JSON -> `{dest: [ids]}` |
| `scripts/embed_lyrics.py` | Modificado | IP do cogmem |
| `src-tauri/src/desktop.rs` | Modificado | `LYRICS_EMBED_DEFAULT`, `lib_move_tracks`, `lib_list_playlists`, thread `indexer-events` |
| `src-tauri/src/slsk/{tidal_fila.rs,sources.rs,mod.rs}` | Criado/Mod | aba Tidal |
| `src-tauri/crates/library-indexer/src/relocate.rs` (+ `tests/relocate_qdrant.rs`) | Criado | mover com histórico |
| `src-tauri/crates/library-indexer/src/{qdrant_client,pipeline,lib,types}.rs` | Modificado | `MoveTracks`, eventos, helpers de migração |
| `src/views/Crate.tsx`, `src/lib/tidalFila.ts`, `src/tauri.ts` | Modificado | aba Tidal |
| `src/lib/moveToPlaylist.ts`, `src/store/moveDialog.ts`, `src/components/MoveToPlaylistDialog.tsx`, `TrackContextMenu.tsx`, views Album/Artist/Playlist(s), `store/player.ts`, `App.tsx`, `Icon.tsx` | Criado/Mod | UI do mover |
| `~/.config/systemd/user/rustify-lyrics.{service,timer}` (VM) | Criado | 08:30 diário, ssh -> cmr-auto |
| `cmr-auto:~/sync_lyrics.py`, `cmr-auto:~/.secrets/telemetria-token.txt` | Deploy | cópias de trabalho |
| `CLAUDE.md` | Modificado | Tidal (envio auto, letras), Crate (aba Tidal), nova seção "Mover para playlist" |
| `docs/metrics/regua-*` | Mod pelo timer | não commitar à mão |

## Decisões tomadas

- **Comparar antes de baixar, não "baixar tudo e separar"** (CMR-297): a Tidal informa bit depth/taxa
  pelo `get_stream()` sem download; baixar custa 17 s e 30-60 MB por faixa sem ganho de informação.
  O passo 1 é só detecção + pasta de revisão `~/tidal-out/upgrades/`; a troca espera a migração de id.
- **Aba Tidal = fila da VM atrás, não cliente nativo**: zero Python no desktop, zero CSP nova; fase 3
  (CMR-295) troca o motor sem mudar a tela. Se a VM cair, a aba diz "fila indisponível".
- **CMR-298 antes de CMR-295** (CEO): destrava organização e upgrade por qualidade.
- **Bruxaria é Funk Brasileiro** (CEO, 14/10). Techfunk só para funk com base techno/trance de fato.
- **Subagentes**: implementação Sonnet quando o brief é fechado (aba Tidal), Opus quando a corretude
  destrói dado (mover); revisor Opus separado, 2 rodadas; `rustify-player-dev` não serve como
  executor (delega). Brief sempre com "REGRA ZERO: você executa, não delega".
- **Telemetria pública segue ligada** até o CEO dispensar a página (a aba Tidal já cobre o uso).

## Métricas

| Métrica | Valor |
|---|---|
| Releases | 0.2.88 (aba Tidal + SC), 0.2.89 (letras), 0.2.90 (mover) publicadas; **instalada 0.2.88** |
| Acervo | 2199 faixas; `[tidal]` 348/348 MERT done; vibe 2164/2199 |
| Letra | com texto 1459 -> 1540; status: synced 61, plain 35, instrumental 113, none 638, found 177, None 1175 |
| Funk a mover (plano atual) | 81 de 442 (Eletrofunk 46, Techfunk 16, Mega Funk 10, outras 9) |
| Régua 13/10 | skip autoplay 74% (meta 55%), n=1582; letra 96% das alcançáveis |
| Tokens de subagentes | ~2,0 M (impl. mover 3 rodadas ~1,15 M; revisor 0,5 M; Tidal 0,3 M; funk 0,27 M) |

## Pendências identificadas

1. **CEO instalar 0.2.90 e testar o mover** (alta) — roteiro na última mensagem da sessão: faixa curtida,
   álbum para pasta nova, artista, faixa tocando, pasta `[tidal]`.
2. **Executar a separação do funk** (alta, depende de 1 e da aprovação final da lista) — pela ponte,
   `lib_move_tracks` em lotes de 10 a partir de `funk_split_plan.py`; conferir antes com o CEO os casos
   de confiança baixa (41) e os individuais (Gal Costa remix, CyberKills, Mulú, "[2025] Radio
   libertadora!", "Various Artists", Bring Me The Horizon em "Humildes"). Depois: reexportar manifest
   (`scripts/android/export_manifest.py --deploy`) e `phone_push_retry.sh`.
3. **Refazer a classificação por MERT** (média, pedido do CEO) — âncoras aprovadas por pasta, vizinhança
   MERT (`rustify_tracks` vetor `mert`) para o resto, confiança por margem; comparar com a proposta atual.
4. **CMR-297 passo 1** (média) — detecção de upgrade no `tidal_mix_dl.py` + pasta de revisão.
5. **Tabela de apelidos old_id -> new_id** (média) — fecha a dívida do S24 no mover e viabiliza a troca
   por qualidade.
6. **Telemetria** (baixa) — desligar `tailscale funnel --https=10000 off` + tmux `telemetria` quando o
   CEO dispensar a página (a API na tailnet continua necessária para a aba Tidal: manter o processo,
   só o Funnel sai).
7. **CMR-296** (média) — endpoints da VM por IP + alarme de `failed` + "reprocessar" (MERT ainda por
   hostname).
8. **vitest intermitente**: `ReferenceError: document is not defined` do `iconify-icon` após
   `Stations.test.tsx`, anterior a esta sessão.
