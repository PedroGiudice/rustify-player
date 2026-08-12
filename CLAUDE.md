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

## Superfície de rede (hardening 2026-07-17, v0.2.59)

Todas as portas do app na cmr-auto escutam SÓ em 127.0.0.1 — MCP bridge
(:9223), Qdrant sidecar (:6333/:6334), media server (:19876). Spec:
`docs/superpowers/specs/2026-07-17-full-pro-design.md`. NUNCA reabrir
bind pra 0.0.0.0 (o bridge executa JS/IPC arbitrário sem auth = RCE na
LAN). Acesso da VM é por túnel SSH (idempotente — porta local já
respondendo = túnel de pé):

```bash
# Probes MCP no app real:
ssh -f -N -o ExitOnForwardFailure=yes -L 9223:localhost:9223 cmr-auto@100.102.249.9
# driver_session: host=127.0.0.1 port=9223

# Qdrant (curator, scripts de classificação):
ssh -f -N -o ExitOnForwardFailure=yes -L 16333:localhost:6333 cmr-auto@100.102.249.9
# CURATOR_QDRANT default já aponta pra http://127.0.0.1:16333
```

CSP sem hosts externos: Instrument Sans é bundlada
(`src/assets/fonts/` + @font-face no extractor-lab.css) — não
reintroduzir @import/CDN de fontes. JWT + rustify.aidvlabs.com ficaram
RESERVADOS (sem serviço exposto a proteger); gatilho de reabertura na spec.

## Branch atual

`main` — trabalho commitado direto em `main`, com rolling dev release
(tag `dev` no GitHub via `release.sh`). Sem PR para fixes pontuais.

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

## Themes (YAML) e a precedencia com Tweaks

Temas vivem em `~/.local/share/rustify-player/themes/*.yaml` NA CMR-AUTO
(nao no repo). Schema completo (legado + boost 2026-07: `tones`, `glass`,
`radius`, `shadows`, `motion`, `background.ink`, `effects.halo`) em
`docs/superpowers/specs/2026-07-05-themes-boost-design.md`. Parser:
`yaml_key_to_css_prop` em `src-tauri/src/lib.rs` (2 camadas: aliases +
pass-through de tokens). Validador offline que replica o checker WCAG do
backend: `python3 scripts/themes/validate.py <dir|arquivo>` — zero
reprovacoes e pre-condicao pra deploy.

**Criacao/upgrade de tema = subagente `theme-maker`**
(`.claude/agents/theme-maker.md`): recebe descricao/paleta/imagem, deriva
paleta completa, valida e faz deploy de arquivo NOVO com hot-reload.

**Precedencia do ink do bg** (`--bg-ink[-rgb]`, resolver unico em
`store/tweaks.ts`): usuario (knob tocado, dirty-flag persistida em
`kv-tweaks.__dirty`) > capa do album (`adaptiveInk`, default ON, via
`get_track_color` + `src/lib/adaptiveInk.ts`) > tema (`background.ink`) >
default. `bgInk` e `lyricsGlass` sao regidos por tema: o valor do Tweaks
so vale se dirty; botao "↺ tema" limpa. Ao aplicar tema, `applyTheme`
dispara `rustify:theme-applied` e o store re-asserta os overrides.

**Derivacao da cor da capa (v3, desde v0.2.39)**: `deriveInk`/`deriveAccent`
em `src/lib/adaptiveInk.ts` sao contrast-driven — alvo >= 4:1 contra o
canvas do tema (a v2 ancorava na "profundidade do tema" e produzia ink
invisivel, ja que todos os temas declaram `background.ink` = canvas).
Extracao no Rust (`cover.rs dominant_color`) = eleicao de familia de hue
wrap-aware + nucleo saturado; enrichment `dominant_color_v3` (versoes
antigas ignoradas, recalcula lazy no 1o play).

**Transicao suave de cor (v0.2.58 — regra dura)**: as vars de cor
(`--bg-ink`, familia `--primary`/`--blue-*`) SALTAM pro alvo; NUNCA
declarar `transition` de custom property no `:root`. A v0.2.41 fazia
isso (crossfade nativo via props registradas) e foi REVERTIDA em
2026-07-17: animar custom property herdada no root forca restyle da
arvore inteira POR FRAME no WebKitGTK — medido no app real: 60fps ->
29fps durante os 480ms, stall de 382ms ("mudanca de cores cai fps").
A suavidade e LOCAL: SpectrumCanvas e EqCanvas fazem lerp exponencial
por frame (`src/lib/rgbLerp.ts`, tau 350ms; ciclo da paleta anuncia tau
longo via `--bg-ink-morph`); consumidores DOM usam transition nas
propriedades CONCRETAS (background/color/border), que disparam quando o
valor da var muda, sem custo global. O registro CSS.registerProperty
(`animatedColorProps.ts`) permanece so pelo initialValue. Tambem nao
reintroduzir animacao via setTimeout no store (stepper antigo banido).

**Enforcement de visibilidade do ink (v0.2.40)**: duas camadas com a MESMA
matematica WCAG. Backend: `load_theme` corrige `--bg-ink` < 3:1 vs canvas
na saida (`ensure_bg_ink_contrast`, lib.rs) — nenhum tema entrega ink
invisivel. Frontend: `resolveInk` (tweaks.ts) aplica piso 3:1 via
`ensureInkContrast` (`src/lib/color.ts`, modulo unico de conversores —
CMR-112 item 1) cobrindo knob manual e default. O knob mantem o valor
escolhido; o APLICADO e o corrigido.

**Accent adaptativo** (`adaptiveAccent`, default ON): `--primary`,
`--primary-container/fixed-dim`, `--on-primary[-container]` e
`--blue-fg/bg/ring` seguem o hue da capa (chips, halos, botoes). Capa
acromatica => accent do tema permanece. Restaurar o tema exige os valores
originais: `applyTheme` (tauri.ts) guarda snapshot acessivel via
`themeVar(name)`; `removeProperty` cairia nos defaults do :root, nao no
tema. Checker `load_theme` valida os pares `on-primary/primary` e
`on-primary/container` (buraco historico: Uvinha shipava 1.46:1);
`validate.py` replica como erro e emite avisos semanticos de curadoria
(colapso sig-ok/warn/err, fg-2==fg-3) que NAO gateiam — temas
monocromaticos legitimos os disparariam.

**Bg persistente: shapes x renderers (18x5, desde v0.2.39)**: campo
escalar (`src/shapes.ts`, 18 shapes) x estrategia de pintura
(`src/renderers.ts`, 5: mesh/columns/weave/dots/contour; mesh = default =
visual antigo). Dispatch no `SpectrumCanvas` (`useShape()`/`useRenderer()`,
persistidos em localStorage), seletores empilhados no NowPlaying e teclas
`[`/`]` (shape) `,`/`.` (renderer). Spec: `docs/design-refs/
design_handoff_persistent_background/` (HTML = fonte da verdade dos
numeros).

So escalar pra YAML / Tauri command novo quando o knob precisar
de preset salvavel, share entre instalacoes, ou hot-reload por
processo externo. Caso contrario o Tweaks resolve.

### Volume (preferencia, nao sessao)

Volume persiste em localStorage `kv-volume` (NAO no state.json, que expira
em 6h). Fonte unica de mudanca: `changeVolume()` em `src/store/player.ts`
(store + persistencia + IPC); boot restaura via `applyPersistedVolume()`
em main.tsx. Handlers de UI nunca chamam o IPC `setVolume` direto.

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

Comandos do motor (o Qdrant da cmr-auto escuta SÓ em 127.0.0.1 desde o
hardening 2026-07-17 — o túnel SSH é pré-requisito; idempotente: se a
porta 16333 já responde, o túnel está de pé):
```bash
ssh -f -N -o ExitOnForwardFailure=yes -L 16333:localhost:6333 cmr-auto@100.102.249.9
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
- **Conta Soulseek atual: `cmr-auto-rp`** (desde 2026-08-07; creds SO em
  `~/slskd_dados/slskd.yml` na cmr-auto, chmod 600 — a conta antiga `cmr-auto`
  morreu com a senha no incidente abaixo). O yml tambem ativa share de `/music`
  (cidadania na rede; peers recusam leecher).
- **Incidente 2026-07-28: `~/slskd_dados` foi deletado na cmr-auto.** O Docker
  recria o bind mount vazio como root:root e o container entra em crash-loop
  ("/app is not readable and/or writable"). Fix: `sudo chown 1000:1000
  ~/slskd_dados` + restart; a config renasce DEFAULT (sem creds Soulseek, sem
  shares) — reconfigurar o yml e restartar. Backup das creds nao existe fora
  do yml: se sumir de novo, e criar conta nova na rede.
- **Copia canonica do `baixar_soulseek_teste.py` e a da VM**
  (`/home/opc/baixar_soulseek_teste.py`) — a da cmr-auto sumiu no mesmo
  incidente; restaurar com `scp` da VM se faltar.
- **Rodar via `uv run --with slskd-api --with mutagen`** — o python3 puro da
  cmr-auto NAO tem `slskd_api`. `uv` fora de `bash -lc` exige caminho absoluto
  (`~/.local/bin/uv`; o PATH do login shell nao cobre ssh nao-interativo).
- **slskd acumula searches persistidas e passa a devolver 409 Conflict** em
  TODA busca nova quando o historico enche (incidente 2026-07-17: 1270
  acumuladas de runs interrompidas → leva inteira varrida em vazio). ANTES de
  qualquer leva grande, limpar via API: `c.searches.get_all()` +
  `c.searches.delete(id)` (auth user/senha slskd/slskd). Restart do container
  NAO limpa (persiste em disco).
- **A rede Soulseek penaliza burst de searches** (centenas em sequencia →
  respostas zeram mesmo com server Connected/LoggedIn; ate busca manual volta
  vazia). Sintoma: "sem candidatos" em faixas onipresentes (Deep Purple, James
  Brown). Diagnostico: 1 busca manual via API com sleep 12s — 0 responses =
  throttled; esperar (dezenas de min/horas) antes de re-rodar com --retry-all.
  Mitigacao futura: pacing/lotes entre buscas.
- **`pkill -f` via ssh se auto-mata** (o pattern casa com a cmdline do proprio
  shell remoto) — usar o truque do colchete: `pkill -f "[b]aixar_soulseek"`.
- **Log fica vazio** (block-buffering do Python redirecionado). Monitorar pela
  fonte de verdade: `~/slskd_dados/downloads/` (completos) + `incomplete/`.
- **`|` no titulo da faixa quebra o CSV** (ex: TA13OO 'TABOO | TA13OO'). O
  `expand_albums.py` sanitiza (corta no `|`); CSV manual idem.
- Download fuzzy as vezes pega live/remix/extended em vez do estudio — revisar
  pontualmente depois, nao refazer a leva.

### Limitacoes conhecidas

- `liked_at` vive em `track_enrichments` (76+ likes reais desde 07/2026;
  a afirmacao antiga "sempre 0" valia pro campo fossil de rustify_tracks).
  O discover.py ainda nao consome likes; behavioral_signals v3 sim.
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

## Motor de inteligencia — sinal v3 (v0.2.66, 2026-08-12)

Vistoria completa + redesign do sinal em
`docs/contexto/12082026-autoplay-vistoria-sinal-v3.md` (regua, dados,
decisoes). O que importa pro dia-a-dia:

- **behavioral_signals v3** (`qdrant_client.rs`, derivacao pura testavel
  `derive_behavioral_signals`): BALANCO LIQUIDO por track — cada evento
  vira peso continuo `clamp((lp-0.30)/0.50, -0.6, 1.0)` (60% de escuta =
  +0.6; skip imediato = -0.6; decisoes de produto do CEO 2026-08-12, nao
  voltar a threshold binario nem a listas independentes), piso de
  atencao 90s no lado positivo (full de skit nao vale full de musica),
  desconto 0.6 pra origens passivas (`autoplay`/`station`/`playlist`;
  skips sem desconto), decay 14d sobre TUDO, e o saldo decide o lado:
  positives = saldo>0 + peso positivo >= 0.55 (top 25 + likes top-10);
  negatives = saldo <= -0.30 (skip unico expira sozinho em ~2 semanas,
  aversao recorrente fica). Positives DISTINTOS (weight por repeticao e
  inocuo sob `best_score` — nao reintroduzir). Tunables sao as consts no
  topo da funcao.
- **Regua automatica**: `scripts/metrics/autoplay_regua.py` roda DIARIO
  09:00 (systemd user timer `rustify-regua.timer` na VM), grava
  `docs/metrics/regua-latest.md` + historico `.jsonl`; o hook
  SessionStart do repo (`.claude/settings.json`) injeta o ultimo
  veredito em TODA sessao — a promessa "medir depois" nao depende mais
  de memoria de ninguem. Desde v0.2.69 reporta tambem a COBERTURA do
  motor (MERT / letra / vibe): o gap reabre a cada leva do Crate e nao
  havia alarme nenhum. A cobertura de letra e medida contra as
  ALCANCAVEIS (total menos `lyrics_status` none/instrumental) — perseguir
  100% e impossivel: instrumental nao tem letra.
- **Origins**: continuacoes de fila radio logam `autoplay` (contOrigin,
  PlayerBar.tsx), playlist loga `playlist`, repeat-one loga `repeat`.
  `album_seq` segue FORA dos sinais. NAO comparar skip-rate por origin
  cru com dados pre-v0.2.66 — o significado mudou.
- **record_play roda 1x por play** (no playTrack; nunca re-adicionar no
  TrackEnded — dobrava play_count).
- **Anotacao de vibe NAO e automatica**: leva nova do Crate entra sem
  energy/valence/moods (neutro 0.5 no re-rank) ate rodar o batch
  (CMR-178; processo replicavel na doc de contexto). Cobertura em
  2026-08-12: 1746/1746. E o unico dos tres vetores/anotacoes que
  continua manual — MERT e letra fecham sozinhos no ingest desde
  v0.2.69. Nenhum script commitado produz as anotacoes em uso: as tres
  levas (372, 72, 368) sairam de subagentes LLM, e o processo e prosa em
  doc, nao codigo. Decisao pendente do CEO: batch periodico agendado vs
  chamada LLM no ingest (custo recorrente + latencia por faixa).
- Deferidos rastreados: CMR-177 (double-load gapless), CMR-178
  (anotacao automatica + GC orfaos), CMR-179 (aversion list, station
  Mood, restore de queueSource).

## Crate — busca + download Soulseek in-app (v0.2.62)

Aba **Crate** (sidebar abaixo de Search, rota `/crate`, entrada pelo ⌘K):
busca na rede Soulseek via slskd local da cmr-auto e baixa direto pro
acervo, com validacao, dedup e indexacao automatica. Substitui o fluxo
CSV+scp+script pra **faixas avulsas**; levas grandes de curadoria continuam
no `baixar_soulseek_teste.py`. Spec (fonte da verdade, com adendo do spike
da API real): `docs/superpowers/specs/2026-08-07-crate-in-app-downloads-design.md`.
QA manual roteirizado: `docs/soulseek/manual-qa.md`.

- **Backend**: `src-tauri/crates/slskd-client` (protocolo puro, fixtures
  reais) + `src-tauri/src/slsk/` (coordinator em thread unica `slsk-coord`,
  JobBoard escritor unico com 11 estados tagged `kind`, staging em
  `.rustify-incoming` + rename atomico pro layout canonico
  `~/Music/<playlist>/<Artista>/<Album>/`). Indexacao deterministica via
  `IndexerCommand::IngestPaths` (devolve track_id por path).
- **Letras junto**: worker paralelo `slsk-lyrics`
  (`library-indexer/src/lyrics_fetch.rs`) consulta lrclib.net pos-download.
  Canal bounded(64), try_send — nunca bloqueia o coordinator. Desde
  v0.2.69 ele FECHA O CICLO via `LyricsSink` (`QdrantLyricsSink`, injetado
  por `IndexerHandle::lyrics_sink`): grava payload + vetor `lyrics` na hora,
  em vez de esperar o `backfill_lyrics` do proximo boot. Sidecar `.lrc` so
  nasce de letra SINCRONIZADA (a view de letra depende dos timestamps);
  letra `plain` vai pro payload `embedded_lyrics` e alimenta so o vetor —
  ~60% do que o lrclib tem e so plain, e descartar isso custava o vetor.
  Sidecar preexistente nunca e sobrescrito, mas ainda fecha o ciclo.
- **Destino**: playlist = pasta de 1o nivel. Precedencia (spec §4.5):
  override da toolbar > artista ja no acervo (`suggested_dest`) > ultimo
  usado (`kv-crate-dest`) > seletor obrigatorio. NUNCA semear o override
  com o ultimo usado (bug IM-D1, corrigido em 63ec14f).
- **Guard-rails de rede**: pacer (min 4s entre buscas, cap 40/h), cold-down
  com banner + "buscar mesmo assim", sweep de searches persistidas no boot.
  Nao contornar — a rede Soulseek pune burst (gotcha documentado acima).
- **Config**: `http://127.0.0.1:5030` default; api key via
  `RUSTIFY_SLSKD_API_KEY` ou config file no data dir do app. Creds do
  Soulseek SO em `~/slskd_dados/slskd.yml` na cmr-auto (0600) — nunca em
  log ou disco do app. CSP nao ganha `:5030` (o HTTP e feito no Rust).
- **Opener**: capability restrita a `opener:allow-reveal-item-in-dir`
  (estado `manual` abre o gerenciador de arquivos). Nao alargar.
- **v1.1 pendente**: handoff visual do claude design (usuario itera a tela);
  popovers fechando em clique fora; Fase 2 = album inteiro.
