# Contexto: sessão 12/10/2026 — Tidal como fonte, Crate fase 1 (SoundCloud) por workflow, telemetria

**Data:** 2026-10-12
**Sessão:** branch `feat/crate-soundcloud` (a partir de `feat/gl-webgl2-engine`); sessão Claude `d126da77` (continuação de `bede7b52` e `2b1709f1`)
**Duração:** ~12 h, com workflows em segundo plano

Documentos já consolidados nesta sessão (não repetir aqui): `docs/contexto/12102026-piloto-funk-br.md`
(Bandcamp + SoundCloud, 121 candidatos), `docs/contexto/12102026-tidal-spike-e-mix.md` (spike, PKCE,
primeiro mix, cobertura 54/121), seções "Aquisicao Bandcamp + SoundCloud" e "Aquisicao Tidal" do
`CLAUDE.md`, spec `docs/superpowers/specs/2026-10-12-crate-fontes-soundcloud-bandcamp-design.md` e plano
`docs/superpowers/plans/2026-10-12-crate-soundcloud-fase1.md`.

---

## O que foi feito

### 1. Acervo: de 1786 para 2064 faixas (jazz ainda entrando), cobertura do motor 100 %
- Causa-raiz do `embedding_status=failed` de três semanas: o nó da VM virou `extractlab-1` na
  migração e o app tem o nome `extractlab` fixo (`desktop.rs:2853`). Corrigido na tailnet
  (`~/.claude/rules/vm-tailscale.md`); dívida registrada em CMR-296.
- Vibe anotada por lotes Opus para tudo que faltava: 40 + 35 + 30 + 15 (SoundCloud/Black Alien) +
  15 (DJ K) + 98 (mix DJ Petroski) + 100 (mix Sidoka). Arquivos em `data/enrichments/2026-10-12-*.json`
  (gitignored, `git add -f`). Os dois últimos lotes saíram de **workflow** (3 anotadores em paralelo
  + validação de vocabulário em JS + até 2 rodadas de correção), não de subagente avulso.
- Fontes legítimas novas: Bandcamp NYP (FLAC) + SoundCloud original (token) = 50 faixas do piloto
  funk BR; Tidal = 15 + 98 + 100 + (62 em curso).

### 2. Tidal como fonte (spike aprovado pelo CEO em conversa)
- Login por **PKCE** obrigatório: device code devolve AAC "HIGH" em faixa sem hi-res
  (python-tidal #404). Sessão em `~/.secrets/tidal-pkce.json` nas DUAS máquinas (cmr-auto e VM);
  o refresh não rotaciona o token (testado), as cópias convivem.
- Regra do CEO: **nada da Tidal no Soulseek**. Pasta `<Álbum> [tidal]` + `shares.filters:
  ['\[tidal\]']` no slskd. Share medido antes/depois de 213 faixas: 3363 arquivos, inalterado.
  Só o NOME de pastas de artista novas aparece como diretório vazio (decisão pendente em CMR-295).
- Scripts versionados em `scripts/curator/`: `tidal_login_pkce.py`, `tidal_mix_dl.py` (mix ou
  playlist; `--list`, `--playlist`, `--genre`, `--limit`, `--push`; env `TIDAL_MUSIC_ROOT`,
  `TIDAL_QDRANT`), `tidal_coverage.py`. Cópias de trabalho: `~/tidal-out/` (VM) e
  `~/.cache/tidal-spike/` (cmr-auto, com `tidal_postcheck.py` e `tidal_ingest.sh`).
- **Modo VM** (desde o jazz): baixa em `~/tidal-out`, dedup pelo túnel 16333, rsync por faixa (+capa)
  para `cmr-auto:~/Music`, `touch` remoto no fim. 3,5 MB/s. Não depende da cmr-auto ligada; a
  indexação sim (watcher só com o app aberto; com ele aberto, MERT fecha em minutos).

### 3. Crate fase 1 (SoundCloud) executado por workflow na branch
- Design e plano aprovados em conversa (spec + plano acima). Workflow `crate-soundcloud-fase1`
  (`wf_6b552490-23f`, script em `~/.claude/projects/-home-opc-rustify-player/bede7b52-.../workflows/
  scripts/crate-soundcloud-fase1-wf_6b552490-23f.js`): implementador + revisor adversarial (Opus)
  por task, até 3 rodadas. Retomado de outra sessão copiando o diretório do run para
  `.../d126da77-.../subagents/workflows/wf_6b552490-23f/` (o resume só enxerga a sessão atual).
- Estado no fim desta sessão: tasks 1–8 aprovadas; task 9 (tela do Crate) implementada
  (`0a11229`) e na correção da 1ª revisão (1 alto: faixa `failed` não podia ser baixada de novo;
  4 médios: "0.0 MB" no badge, texto duplicado do MP3 recusado, teste sem prova da edição,
  `target="_blank"` sem opener no WebKitGTK). **Task 10 (QA pela ponte, bump, release) é minha,
  fora do workflow, e não começou.**
- Nada da fase 1 está publicado nem instalado.

### 4. Telemetria para o CEO (fora da tailnet)
- `scratchpad/telemetria.py` (sessão) em tmux `telemetria` na VM: gera HTML a cada 15 s
  (fase 1 por task + últimas ações do agente ativo, outros workflows, logs da Tidal na cmr-auto e
  na VM, índice/MERT/vibe, commits) e serve em `127.0.0.1:8470/<token>`; exposto por
  `tailscale funnel --https=10000`. Token em `~/.secrets/telemetria-token.txt`.
  URL: `https://extractlab.cormorant-alpha.ts.net:10000/<token>`. Temporário: desligar ao fim.
- Monitores de chat (`Monitor`): eventos do diário do workflow e progresso dos logs da Tidal a
  cada 10 faixas; expiram em 30 min e precisam ser rearmados.

## Estado dos arquivos (além do que o workflow commitou)

| Arquivo | Status | Detalhe |
|---|---|---|
| `scripts/curator/tidal_mix_dl.py` | Criado | mix/playlist → FLAC com tags/capa, dedup, `--push`, modo VM |
| `scripts/curator/tidal_login_pkce.py` | Criado | login PKCE em tmux; code vem do histórico do Chrome |
| `scripts/curator/tidal_coverage.py` | Criado | cobertura do catálogo (só busca, sessão OAuth) |
| `scripts/curator/normalize_release.py` + teste | Modificado | `--title`, artista por faixa, capa 1500 px |
| `CLAUDE.md` | Modificado | seções Bandcamp/SoundCloud e Tidal (modo VM, gotchas) |
| `data/enrichments/2026-10-12-*.json` (7 arquivos) | Criados | vibe; gitignored, `git add -f` |
| `docs/contexto/12102026-{piloto-funk-br,tidal-spike-e-mix}.md` + JSONs | Criados | relatórios e dados |
| `docs/superpowers/{specs,plans}/2026-10-12-crate-*` | Criados | design e plano da fase 1 |
| `src-tauri/crates/soundcloud-client/`, `src-tauri/src/slsk/*`, `src/views/Crate*.tsx`, `src/lib/trackMetaGuess.ts` | Criados/modificados pelo workflow | ver commits abaixo; árvore suja = agente da task 9 em curso |
| `docs/metrics/regua-*.{md,jsonl}` | Modificados pelo timer da régua | não commitar à mão sem olhar |

## Commits desta sessão (branch `feat/crate-soundcloud`)

Curadoria e dados: `070672b 4133527 626e086 1627672 22bc63e f94d093 e41c2f3 e9c12fc cbcbf23 6827544 83d70e0
7a54bd9 b1d9f7e f013fe6 094fe8d 4abfbdf 7181c3c`.
Design/plano: `7521380 f46e778`.
Fase 1 (workflow): `0f887e2 6b07d88 2c7d378 bbc985b a65403b c634709 9283d4b 6d3b512 04fd7f7 bcdd87a 9246b88
df36532 08e2083 72767b5 75a6551 50957f9 0b65676 fac7842 0a11229` (+ o fix da task 9 quando sair).

## Decisões tomadas

- **Fase 1 só com fontes gratuitas** (SoundCloud original com token; Bandcamp por link na fase 2; pago só
  "abre a página e espera a compra"). MP3 320 entra marcado `source: lossy mp3`; abaixo é bloqueado.
- **Tidal fora do Soulseek por marca de pasta + filtro do slskd**, não por pasta raiz separada: o app lê
  tags e o layout do acervo fica igual. Descartado: pasta `~/Music-tidal` (quebraria playlist = pasta de 1º nível).
- **PKCE em vez de device code** pelo motivo técnico acima; o CEO aprova no Chrome logado; o `code`
  sai do SQLite do histórico porque a ponte redige parâmetros de URL.
- **Download da Tidal na VM com push por faixa** (pedido do CEO): não depende da cmr-auto; dedup pelo túnel.
- **Vibe por workflow com validação em código**: o vocabulário de 24 moods e 14 atividades é o dos
  arquivos existentes (inclui `confident`, `ethereal`, `social`, `workout`); mapear anotações pelo
  número da linha do TSV, não pelo caminho (anotadores alteram o número da faixa no nome).
- **Subagentes nunca herdam o modelo da sessão**: `model` explícito (opus; sonnet para o mecânico).
- **Bandcamp com e-mail**: `pedrogr1707@gmail.com`, nunca o descartável.
- **Telemetria pública por Funnel 10000 com caminho secreto**, não por Cloudflare (sem DNS novo) nem
  por artifact (sem dado vivo).

## Métricas

| Métrica | Valor |
|---|---|
| Acervo (Qdrant `rustify_tracks`) | 1786 → 2064 (+ jazz em curso, 62 faixas, 27 novas às 11:35) |
| Faixas em pastas `[tidal]` indexadas | 213 (+ jazz); MERT 213/213; vibe 213/213 |
| Share slskd | 3363 arquivos antes e depois da Tidal (955 dirs, nomes de artista vazios) |
| Tidal: tier e ritmo | PREMIUM/HI_RES; 16/44,1 ou 24 bit; cmr-auto ~2 MB/s, VM 3,5 MB/s; 2 s de pausa |
| Mix DJ Petroski | 98/99 (1 já no acervo), 66 LOSSLESS + 32 hi-res, 1,7 GB |
| Mix Sidoka | 100/100, 0 puladas, 0 falhas; vibe 93 high |
| Cobertura Tidal sobre o piloto | 54/121 releases; 17/23 artistas |
| Fase 1 | 8 tasks aprovadas, 1 em correção; ~19 commits; 1 alto por task em média na 1ª revisão |
| Régua (11/10) | skip autoplay 74 % (meta 55 %), n=1575; não tocada nesta sessão |

## Pendências identificadas

1. **Task 9 → fim do workflow** (alta): esperar `review:9` aprovar (ou 3ª rodada). Se o workflow
   morrer com a sessão, retomar com o diretório do run copiado para a sessão nova (ver §3).
2. **Task 10** (alta): `npm run typecheck`, `npm test`, `cargo test` (workspace), bump em
   `tauri.conf.json`, `./scripts/release.sh`, QA no app pela ponte MCP (túnel 9223) seguindo
   `docs/soulseek/manual-qa.md` + a seção de aceitação da spec; atualizar `CLAUDE.md` (seção Crate:
   fontes por job, `sources.json`, token do SoundCloud) e `docs/soulseek/manual-qa.md`. Ordem de
   instalação na cmr-auto: `.deb` com versão por extenso + reabrir o app.
3. **Jazz** (alta, automático): ao `FIM` no `~/tidal-out/mix3.log`, rodar na cmr-auto
   `tidal_postcheck.py --touch`, conferir MERT, montar TSV das novas, vibe por workflow com
   calibração de jazz (energy baixa/média, moods `peaceful/dreamy/nostalgic/groovy/focus`),
   `vibe_apply.py`, commit. Depois limpar `~/tidal-out/Jazz` (5,1 GB na VM).
4. **Telemetria** (média): desligar `tailscale funnel --https=10000 off` e `tmux kill-session -t
   telemetria` quando a fase 1 fechar; ou promover a serviço se o CEO quiser permanente.
5. **CMR-295 fase 3 Tidal no Crate** e **fase 2 Bandcamp** (média): depois da release da fase 1.
6. **CMR-296** (média): MERT por IP + alarme de `failed` + "reprocessar".
7. **`lyrics_status = None` em tudo que entra pelo watcher** (média): confirmar se o backfill do boot
   fecha; a régua pode estar contando errado a cobertura de letra.
8. **Bandcamp pago** (baixa): 6 releases (~US$ 27) aguardando compra do CEO; DJ K já veio da Tidal.
9. **Chrome MCP**: tabs 1618757962 e 1618757982 do CEO na cmr-auto ficaram abertas (dele).
