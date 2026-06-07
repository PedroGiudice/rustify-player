# Rustify Player — Claude Project Rules

## Compilacao e release

**Nao compilar ate ter certeza de que nao fara mais edicoes no momento.**
Acumule todas as mudancas pendentes (backend + frontend) e compile/release
uma unica vez no final. Compilacoes intermediarias poluem o contexto e
desperdicam tokens. `cargo check` pontual e ok pra validar sintaxe critica;
`release.sh` so quando for entregar pro usuario testar.

```bash
# Validacao rapida (sem binario, sem bundle)
cargo check --manifest-path src-tauri/Cargo.toml

# Release completo (build + .deb + publish GH)
./scripts/release.sh
```

A cmr-auto puxa com:

```bash
gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber
sudo dpkg -i /tmp/rustify-player_0.1.0_amd64.deb
```

Nao compilar localmente na cmr-auto — i5 8th gen leva minutos. A VM leva
segundos. Release.sh e o unico caminho.

## Branch atual

`fix-playback-race-condition` — ativa ate merge em main.

## TweaksPanel e o hub de customizacao

O painel **Tweaks** (sidebar bottom-left, atalho via evento
`toggle-tweaks`) e a referencia canonica pra customizacoes visuais e
de comportamento do usuario. Antes de criar UI nova ou arquivo YAML
de config pra um knob, avaliar se cabe no Tweaks.

A infra ja resolve:
- Persistencia em localStorage (`kv-tweaks`)
- Reatividade Solid (signals em `src/store/tweaks.ts`)
- Portal overlay + estilos prontos (.tweaks, .segmented, etc)
- Aplicacao no `<html>` via CSS vars (`--lyrics-bg-alpha`,
  `--bg-ink-rgb`, etc) que os componentes consomem sem listener

Pontos de extensao:
- `src/store/tweaks.ts` — adicionar campo no schema + DEFAULTS +
  applyTweaks set da CSS var
- `src/views/Tweaks.tsx` — usar `<NumberSlider>`, `<Segmented>`,
  `<FontSelect>` existentes, ou `<input type="color">` (ver bgInk)
- `src/styles/extractor-lab.css` — consumir a CSS var no
  componente alvo com fallback

So escalar pra YAML / Tauri command novo quando o knob precisar
de preset salvavel, share entre instalacoes, ou hot-reload por
processo externo. Caso contrario o Tweaks resolve.

### Loudness normalization (excecao ao padrao CSS-var)

A normalizacao de loudness e um knob do Tweaks que NAO segue o padrao
CSS-var (applyTweaks e DOM-only). Aplica via IPC pro backend.

- Schema (`src/store/tweaks.ts`): `loudnessNorm` (bool on/off) e
  `loudnessTarget` (LUFS, default -14, range -20..-6 na UI).
- Aplicacao: `createEffect` dedicado (separado do applyTweaks) com
  debounce ~100ms, chama `normSetEnabled`/`normSetTarget` (`src/tauri.ts`).
  No boot, `applyLoudnessState()` em `main.tsx` empurra o estado salvo com
  retry, cobrindo o gap de init do engine.

Cadeia DSP (`crates/audio-engine/src/output/dsp.rs`):
`EQ -> norm_gain (volume) -> Limiter -> Bass`. O `norm_gain` normaliza
cada track pro target LUFS (medido no index, per-track). `NORM_TARGET_LUFS`
deixou de ser const e virou runtime em `NormState` (`lib.rs`): commands
`norm_set_target` (re-aplica na track tocando, lendo `lufs_integrated` do
snapshot) e `norm_get_target`; a `event_loop` per-track le o target dinamico.

Indicador na tela Signal (StatTile "Normalize" + node `norm_gain` da chain)
le do tweaks store — fonte unica. A Signal NAO mantem estado IPC proprio
de norm (foi removido; ficava stale ao mexer no Tweaks).

## Subagente music-curator

Curadoria on-demand de sugestoes musicais. Le o perfil de gosto via
behavioral_signals do Qdrant, pesquisa candidatos na web, valida com
MusicBrainz e devolve lista pra aprovacao humana. NAO baixa nada — o
download e disparado pela sessao principal apos voce aprovar.

Definicao: `.claude/agents/music-curator.md`.

### Como invocar

Pede direto: "sugere musicas novas pra baixar" — a sessao principal
delega ao subagente. Variantes que funcionam: "descobre <genero> pra
expandir minha biblioteca", "deep cuts do <artista que ja tenho>",
"sugere algo novo pro meu gosto".

### Fluxo (reescrito 2026-06 — motor deterministico + curadoria)

A descoberta tem duas camadas e DOIS eixos. O motor faz o trabalho onde o LLM
erra (jq corrompe u64, WebSearch nao tem grafo de similaridade); o subagente cura.

**Eixo ARTISTA** (`scripts/curator/discover.py`): deriva o perfil do Qdrant
(play_events), seleciona artistas-seed, resolve MBID (MusicBrainz, com cache),
busca **similar-artists no ListenBrainz** (collaborative filtering), agrega
cross-seed normalizado, filtra a biblioteca. Pool de ARTISTAS com `agg_score`,
`overlap`, `per_seed`, `library_tracks` (0=novo / 1-5=parcial pra modo album),
`signal_quality`. Usado pra modo album e expansao lateral.

**Eixo FAIXA** (`scripts/curator/discover_tracks.py`): sobe a descoberta pro
nivel de track. Duas fontes enchem UM pool: (A) **similar-recordings** das
faixas mais tocadas + seeds diversos por MERT (co-listening de faixa); (B)
**cauda** dos artistas do grafo (faixas fora do top, via top-recordings). Cada
faixa e rotulada por TIER (hit/mid/deep) pela **popularidade absoluta**
(`/popularity/recording`, batch) no percentil DO POOL — NAO por discografia do
artista (resolver artista por nome pega homonimo: 'Kanye West' tem obscuros que
o MB nao desempata). Composicao estratificada: `--mode mix` (default, 30/40/30),
`deep`, `hit`. Filtro de biblioteca COLLAB-AWARE (`is_owned`): casa titulo +
artista sobreposto ('family ties' de 'Baby Keem & Kendrick Lamar' bate com o
acervo que tem so 'Baby Keem'). Ver `[[project_listenbrainz_recording_fragmentation]]`.

**Curador** (subagente): roda os DOIS motores, cura (corta megapop, respeita
ecletismo, mantem a estratificacao de tier), sugere **album inteiro** pros
parciais (caso Travis/Astroworld, validando `secondary-types` contra mixtape),
e — passo OBRIGATORIO — roda `discover_tracks.py --check` em TODAS as faixas
finais (inclusive curveball/eixo-artista, que NAO passaram pelo is_owned do pool)
e remove o que ja esta no acervo. Entrega lista markdown com query slskd
pre-formada + a meta dos JSONs como prova de execucao.

Comandos do motor:
```bash
python3 scripts/curator/discover.py --top-seeds 8 --pool-size 60 --out /tmp/curator-pool.json
python3 scripts/curator/discover_tracks.py --mode mix --pool-size 50 --out /tmp/curator-tracks.json
# verificacao anti-duplicata (stdin JSON):
echo '[{"artist":"Smino","title":"Anita"}]' | python3 scripts/curator/discover_tracks.py --check
# testes das funcoes puras (filtro collab-aware, tier, compose):
python3 scripts/curator/test_discover_tracks.py
```

Last.fm foi deliberadamente descartado (aversao do usuario + redundante com
ListenBrainz). WebSearch e so contexto/justificativa e fallback pra nicho.

### Como baixar o que voce aprovar

O download roda na **cmr-auto** (NAO na VM): o `baixar_soulseek_teste.py` aponta
pra `/home/cmr-auto/Music` (skip de duplicata) e slskd em `localhost:5030`. A
sessao principal dispara via SSH (`ssh cmr-auto@100.102.249.9`).

O script consome um CSV `Música|Artista` (delimiter `|`, com header — ele faz
`next(leitor)`), gera variantes de query por faixa, baixa 1 FLAC valido por
query (filtro FLAC + tamanho min, diversificacao por peer, 3 tentativas, estado
persistido). E **faixa-orientado**: nao baixa pasta de album.

Fluxo (validado 2026-06):
```bash
# 1. faixas avulsas: montar CSV musica|artista (do que o usuario aprovou)
# 2. albuns inteiros: expandir tracklist via MusicBrainz
printf 'Travis Scott|ASTROWORLD\n' | python3 scripts/curator/expand_albums.py >> /tmp/leva.csv
# 3. CSV final = header + faixas + tracklists; copiar pra cmr-auto
scp /tmp/leva.csv cmr-auto@100.102.249.9:/home/cmr-auto/
# 4. testar e rodar NA cmr-auto (uv resolve deps; python3 puro NAO tem slskd_api)
ssh cmr-auto@100.102.249.9 'bash -lc "cd ~ && uv run --with slskd-api --with mutagen \
  baixar_soulseek_teste.py --csv ~/leva.csv --dry-run"'   # valida sem baixar
ssh cmr-auto@100.102.249.9 'bash -lc "cd ~ && nohup uv run --with slskd-api --with mutagen \
  baixar_soulseek_teste.py --csv ~/leva.csv > ~/leva.log 2>&1 &"'
```

Gotchas:
- **Rodar via `uv run --with slskd-api --with mutagen`** — o python3 puro da
  cmr-auto NAO tem `slskd_api`. `uv` precisa de `bash -lc` (PATH no login shell).
- **Log fica vazio** (block-buffering do Python redirecionado). Monitorar pela
  fonte de verdade: `~/slskd_dados/downloads/` (completos) + `incomplete/`.
- **`|` no titulo da faixa quebra o CSV** (ex: TA13OO 'TABOO | TA13OO'). O
  `expand_albums.py` sanitiza (corta no `|`); CSV manual idem.
- Download fuzzy as vezes pega live/remix/extended em vez do estudio — revisar
  pontualmente depois, nao refazer a leva.

### Limitacoes conhecidas

- `liked_at` esta sempre 0 no Qdrant — likes explicitos nao sao usados.
  Toda inferencia de gosto vem de `play_events` (listen_pct, replays).
- Qualidade da curadoria depende de massa de eventos: com < 30 positives
  qualificadas o subagente sinaliza baixa confianca.
- **Perfil de nicho/BR** (rap BR, funk BR): o grafo do ListenBrainz e esparso
  (score satura ~120 vs ~5000 do mainstream). Nesses casos `signal_quality`
  vem `low` e o curador usa o pool so como recall, re-rankeando via MusicBrainz
  rels/tags + WebSearch curado.
- **Metadata suja** na biblioteca (ex: funk BR com `artist` = URL do ripper,
  `www.ftpdjemilio.com`) e filtrada como seed-lixo no `_is_junk_artist`, mas
  o ideal e limpar na fonte (indexer).
- O motor depende de 2 servicos externos em cadeia (MusicBrainz pra MBID +
  ListenBrainz Labs pro grafo). MusicBrainz tem rate limit 1 req/s (gargalo
  real, ~15-25s por run); ListenBrainz Labs nao publica rate limit (serializado
  com folga). Cache de MBID em `~/.cache/rustify-curator/mbid.json`.
- **`resolve_mbid` (discover.py) desempata homonimo por score do MB** (relevancia
  de busca, nao popularidade) — pode pegar o artista errado ('Kanye West' obscuro).
  Afeta os SEEDS de ambos os motores; os similar-artists do LB trazem mbid
  confiavel. Divida tecnica conhecida, nao critica (a curadoria filtra). O eixo
  FAIXA contorna usando `/popularity/recording` (nao resolve artista pro tier).
- **Eixo FAIXA: tier por popularidade do POOL, nao da discografia.** `deep` =
  faixa obscura entre as candidatas, nao necessariamente deep cut da discografia
  do artista. Fonte A (co-listening) e hit-pesada; a fonte B (cauda) tem cota
  reservada (`SOURCE_B_SHARE`) pra nao ser soterrada.
