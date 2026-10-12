# Retomada: Crate fase 1 (SoundCloud) → task 10 e release; Tidal (jazz) → vibe; telemetria

<session_metadata>
branch: feat/crate-soundcloud
base: feat/gl-webgl2-engine (main ainda sem o motor WebGL2)
last_commit_sessao: 0a11229 (task 9 impl) + fix da task 9 pendente
workflow_fase1: wf_6b552490-23f (script em ~/.claude/projects/-home-opc-rustify-player/bede7b52-64fb-43d7-9b18-a0b0ef7c2967/workflows/scripts/crate-soundcloud-fase1-wf_6b552490-23f.js)
tidal_jazz_log: ~/tidal-out/mix3.log (VM)
telemetria: tmux telemetria + funnel 10000 (desligar ao fim)
</session_metadata>

## Contexto rápido

Rustify Player (Tauri 2.11 + Rust + SolidJS; app roda na cmr-auto, dev na VM). Nesta sessão o CEO
assinou a Tidal e ela virou fonte lossless do acervo, sempre fora do Soulseek (pasta `[tidal]` +
filtro do slskd): 15 + 98 + 100 faixas já no app com MERT e vibe, e a playlist de jazz (62) baixando
pela VM com envio por faixa para a cmr-auto. Em paralelo, a fase 1 do Crate com fontes
(SoundCloud de ponta a ponta) foi implementada por workflow na branch `feat/crate-soundcloud`:
tasks 1–8 aprovadas por revisor adversarial, task 9 (tela) em correção. Nada da fase 1 está
publicado. O CEO acompanha por um painel público temporário (Funnel 10000).

Leia antes de agir: `docs/contexto/12102026-sessao-tidal-crate-fase1.md` (estado e decisões),
`docs/contexto/12102026-tidal-spike-e-mix.md`, e no `CLAUDE.md` as seções "Crate", "Aquisicao
Bandcamp + SoundCloud" e "Aquisicao Tidal".

## Arquivos principais

- `docs/superpowers/plans/2026-10-12-crate-soundcloud-fase1.md` — plano (task 10 = QA/docs/release)
- `docs/superpowers/specs/2026-10-12-crate-fontes-soundcloud-bandcamp-design.md` — spec (aceitação no fim)
- `src-tauri/src/slsk/{board,coordinator,sc_worker,sources,stage,mod}.rs`, `src-tauri/crates/soundcloud-client/`,
  `src-tauri/crates/library-indexer/src/{transcode,tagwrite}.rs`, `src/views/Crate.tsx`, `src/lib/trackMetaGuess.ts`
- `scripts/curator/tidal_mix_dl.py` — Tidal (modo VM: `TIDAL_MUSIC_ROOT`, `TIDAL_QDRANT`, `--push`)
- `~/.cache/tidal-spike/tidal_postcheck.py` (cmr-auto) — índice/MERT/vibe/share pós-download
- `docs/soulseek/manual-qa.md` — roteiro de QA do Crate (atualizar com as fontes)

## Próximos passos (por prioridade)

### 1. Fechar a task 9 e o workflow
**Onde:** diário `~/.claude/projects/-home-opc-rustify-player/<sessão>/subagents/workflows/wf_6b552490-23f/journal.jsonl`
**O que:** se o workflow ainda roda, esperar `review:9` aprovar. Se morreu com a sessão, copiar o
diretório do run (`.../bede7b52-.../subagents/workflows/wf_6b552490-23f` ou o da sessão `d126da77`)
para `.../<sessão nova>/subagents/workflows/` e relançar `Workflow({scriptPath, resumeFromRunId:
"wf_6b552490-23f", args: {plan, spec}})` com os caminhos absolutos do plano e da spec.
**Por que:** o resume só enxerga o diário na pasta da sessão atual; sem cópia ele recomeça do zero.
**Verificar:** `git log --oneline -3` mostra o fix da task 9; `review:9` com `approve` no diário.

### 2. Task 10: gates, QA pela ponte, release
**Onde:** VM (build) + cmr-auto (app aberto, túneis 9223 e 16333)
**O que:** `npm run typecheck && npm test && cargo test --manifest-path src-tauri/Cargo.toml`;
bump em `src-tauri/tauri.conf.json`; `./scripts/release.sh`; CEO instala o `.deb` (versão por
extenso) e reabre; QA pela ponte MCP seguindo `docs/soulseek/manual-qa.md` + seção de aceitação
da spec (busca SoundCloud, card pré-preenchido, MP3 320 aceito/128 bloqueado, `[tidal]` nunca na
fila do Soulseek, token nunca em log); atualizar `CLAUDE.md` (seção Crate) e `manual-qa.md`.
**Por que:** o CEO só vê o que está instalado; sem QA no app real a fase 1 não existe para ele.
**Verificar:** screenshots pela ponte; `read_logs` sem token; `ss -tlnp | grep rustify` só loopback.

### 3. Jazz: fechar o lote
**Onde:** `~/tidal-out/mix3.log` (VM) → cmr-auto
**O que:** ao `FIM`: na cmr-auto `~/.local/bin/uv run --with slskd-api --with mutagen python3
~/.cache/tidal-spike/tidal_postcheck.py --touch`; montar TSV das novas (mesmo padrão de
`rap_vibe_in.tsv`: n, path, artist, albumartist, album, year, title, dur_s); vibe por workflow
(script `vibe-lote-tidal-wf_3288aa51-6de.js` da sessão `d126da77`, args com `chunks`, `total`,
`contexto` calibrado para jazz); `python3 scripts/curator/vibe_apply.py <saída> <tsv> data/enrichments/2026-10-12-opus-vibe-annotations-tidal-jazz-NN.json`;
`git add -f` + commit. Depois `rm -rf ~/tidal-out/Jazz` na VM.
**Por que:** faixa sem vibe entra neutra no re-rank; 5 GB de staging na VM.
**Verificar:** `tidal_postcheck.py` com "sem vibe: 0", share do slskd em 3363.

### 4. Desligar a telemetria temporária
**Onde:** VM
**O que:** `sudo tailscale funnel --https=10000 off`; `tmux kill-session -t telemetria`;
remover `~/.secrets/telemetria-token.txt`. Se o CEO quiser permanente, virar serviço com auth.
**Por que:** página pública com caminho secreto não é para ficar para sempre.
**Verificar:** `sudo tailscale funnel status` sem a 10000.

### 5. Depois da release: fase 2 (Bandcamp por link) e fase 3 (Tidal no Crate, CMR-295); CMR-296 (MERT por IP)

## Como verificar

```bash
cd /home/opc/rustify-player && git status --short && git log --oneline -5
```
```bash
ssh -f -N -o ExitOnForwardFailure=yes -L 16333:localhost:6333 cmr-auto@100.102.249.9; curl -s http://127.0.0.1:16333/collections/rustify_tracks | python3 -c "import json,sys; print(json.load(sys.stdin)['result']['points_count'])"
```
```bash
tail -n 3 ~/tidal-out/mix3.log; tmux ls; sudo tailscale funnel status
```
```bash
cd /home/opc/rustify-player && npm run typecheck && cargo check --manifest-path src-tauri/Cargo.toml
```

## Restrições

- Não compilar no meio de uma leva de edições; `release.sh` só com bump feito e QA planejado.
- Nada da Tidal sai do padrão `<Álbum> [tidal]`; nunca mexer no filtro do slskd sem conferir o share.
- Subagentes com `model` explícito (opus/sonnet), nunca o da sessão; PT-BR com acentos, sem emoji.
- Segredos (`~/.secrets/*`) nunca em log, chat ou commit; `pgrep -a` não durante downloads com token.
- `pkill -f` por ssh mata o próprio shell; conferir processos por pid (o servidor tmux carrega o argv
  do primeiro comando e engana `pgrep -f`).
