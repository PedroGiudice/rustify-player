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

**release.sh NAO bumpa versao** — le `tauri.conf.json` e sobe o asset com
`--clobber`. Bump manual (`chore: bump X.Y.Z`) ANTES de rodar, senao o .deb
publicado da versao anterior e sobrescrito por um binario diferente com o
mesmo nome (aconteceu na 0.2.72→0.2.73, 13/08).

A cmr-auto puxa com:

```bash
# A tag `dev` acumula TODOS os .deb ja publicados (69 em 08/2026) — baixar
# com '*.deb' puxa a colecao inteira. Sempre nomear a versao:
V=0.2.69
gh release download -R PedroGiudice/rustify-player -p "rustify-player_${V}_amd64.deb" -D /tmp --clobber
sudo dpkg -i /tmp/rustify-player_${V}_amd64.deb
```

Nao compilar localmente na cmr-auto — i5 8th gen leva minutos. A VM leva
segundos. Release.sh e o unico caminho.

## Superfície de rede (hardening 2026-07-17, v0.2.59)

Todas as portas do app na cmr-auto escutam SÓ em 127.0.0.1 — MCP bridge
(:9223), Qdrant sidecar (:6333/:6334), media server (:19876). Spec:
`docs/superpowers/specs/2026-07-17-full-pro-design.md`. EXCECAO deliberada
(v0.2.73): o **sync receiver** (`src/sync_receiver.rs`) escuta em
`<ip-tailscale>:19878` — e o alvo do sync de play_events do S24 e so a
tailnet alcanca (WireGuard e o canal cifrado; sem tailnet ele nem sobe).
Nao "corrigir" pra loopback: quebraria o sync mobile. NUNCA reabrir
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
- **Proveniencia dos eventos (v0.2.72, spec 2026-08-13-event-provenance)**:
  todo ponto novo em `play_events` sai estampado com `device_id` (slug do
  hostname, persistido em `device.json` no data dir — IMUTAVEL depois de
  criado), `app_version` (autoridade: tauri.conf.json via `package_info()`)
  e `signal_schema` (const `SIGNAL_SCHEMA` em `qdrant_client.rs`). Like
  grava `liked_device`. O backend estampa POR CIMA do que vier do frontend
  (`log_event`). Mudou a semantica dos sinais/origins? Incrementar
  `SIGNAL_SCHEMA` — a regua le o campo e o `V3_CUTOFF` por timestamp e so
  fallback pra eventos legados. Sem migracao retroativa (padrao context_id).
  E o pre-requisito do sync multi-dispositivo (uniao de conjuntos dos logs;
  fase futura na spec). Eventos de dispositivo novo aparecem sozinhos na
  regua (breakdown por device quando houver 2+).
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
  (anotacao automatica + GC orfaos), CMR-179 (restam station Mood e
  restore de queueSource).
- **Consciencia de sessao no RADIO (v0.2.75, 2026-08-18)**: a parte de
  aversao do CMR-179 foi confirmada como causa-raiz do skip 68% da regua
  (forense: 3 sessoes de martelo 88-96% dominavam o agregado; o picker
  semeava o proximo pick pela faixa RECEM-REJEITADA e re-servia skipadas
  alem do FIFO-30 — mesma faixa 12x). Fix = paridade com a station:
  `radioSession` generalizado (rodada `radio:<ts>`, `lastAcceptedId`),
  skip cedo (<35%) trunca a cauda e re-fetcha semeado pela ultima ACEITA,
  seen da rodada e hard-filter, `lib_autoplay_next` ganha
  `session_negative_ids` (uniao com negativos globais) e filtro
  `is_junk_artist` (URL no campo artista). NAO regredir: semear re-fetch
  pos-skip pela faixa skipada e o anti-pattern que causou o colapso.

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
  letra `plain` vai pro payload **`lyrics_text`** e alimenta so o vetor —
  ~60% do que o lrclib tem e so plain, e descartar isso custava o vetor.
  Sidecar preexistente nunca e sobrescrito, mas ainda fecha o ciclo.

  **Nunca gravar letra externa em `embedded_lyrics`** (regra dura, v0.2.71):
  aquele campo e a letra das TAGS do arquivo (`metadata.rs` le LYRICS/
  UNSYNCEDLYRICS/USLT, costuma trazer LRC completo) e a aba de letra o
  renderiza como LRC — texto sem timestamp volta com t=0 em todas as linhas
  e o card trava no ultimo verso a musica inteira. Precedencia em
  `resolve_lyrics`: tags > `lyrics_text` > `lrc_path` > sidecar novo no disco.
  No frontend, `isSynced` (NowPlaying.tsx) detecta t=0 em tudo e desliga
  auto-scroll/linha ativa, rotula "unsynced" e torna o viewport rolavel.

  `lyrics_text`/`lyrics_status` NAO vem do arquivo, entao o re-ingest
  (retag muda mtime => `upsert_tracks` faz PUT e reescreve o ponto inteiro)
  os apagaria junto com o vetor; os dois caminhos de ingest preservam esses
  campos (`external_lyrics_fields` + `merge_external_lyrics`).
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

## Android (v0 — tocar + registrar, 2026-08-13)

O mesmo repo produz o app Android (S24). Escopo v0: reproduzir o acervo
local e gerar `play_events` com proveniencia — SEM motor de inteligencia,
SEM Qdrant, SEM Crate no aparelho. Contexto e decisoes:
`docs/contexto/13082026-rustify-android-v0.md`; contrato IPC pra UI:
`docs/android/ipc-contrato-v0.md`.

### Arquitetura (dispatch por target)

- `src/lib.rs` = raiz fina: mods cross + `#[path]` dispatch pra
  `desktop.rs` (corpo antigo integral) ou `mobile.rs` (shell Android).
  Deps desktop-only (audio-engine/PipeWire, souvlaki, mcp-bridge,
  library-indexer, slskd-client) sao target-gated no Cargo.toml.
- Playback Android = plugin proprio `crates/tauri-plugin-rustify-audio`
  (Kotlin: Media3/ExoPlayer + MediaSessionService, fila NATIVA com
  auto-advance sem JS, EventJournal JSONL com fsync). README do crate =
  contrato. Regra dura: command novo no plugin DEVE ser `async fn` com
  `AppHandle<R>` (State sincrono deadlocka a main thread). Segunda regra
  dura: NUNCA dropar o future de um IPC do plugin sob timeout (o tauri
  faz `send().unwrap()` num oneshot dentro de callback JNI `extern "C"`
  — sem receiver, panic = abort). Teto de tempo = `tauri::async_runtime::
  spawn` do future + `tokio::time::timeout` no JoinHandle (padrao do
  `lib_recent_plays` e do `call` do tender em mobile_continuity.rs).
  Media3 fixo em 1.10.1 (1.11 arrasta kotlin-stdlib 2.2, quebra com o
  KGP 1.9.25 do projeto gerado).
- Biblioteca mobile: manifest exportado do Qdrant da cmr-auto
  (`scripts/android/export_manifest.py`, tunel 16333) com o track_id
  CANONICO do desktop (hash do path de la — o celular nao o deriva);
  resolucao por stem canonico em `mobile_library.rs` (1746/1746 no S24).
  Manifest vive em `/sdcard/Music/.rustify/manifest.json`; apos novo
  sync de acervo, `lib_rescan`.
- Capas mobile (CMR-212, paridade com o desktop): `manifest.cover` =
  `covers/<sha1>.jpg` (relativo a `.rustify/`), UMA capa por álbum-key
  (o mesmo `cover_path` do Qdrant; 1660 tracks → 565 arquivos),
  convertida do cache webp da cmr-auto pelo `--deploy` do export.
  Precedência em `resolve_cover` (`mobile_library.rs`): export (se o
  arquivo existir) > cover.jpg/folder.jpg da pasta > null — manifest ou
  APK antigos caem na pasta. **Gotcha do scope**: `assetProtocol.scope`
  em forma de ARRAY exige o ponto LITERAL no padrão (tauri 2.11):
  `Music/**` NÃO cobre `Music/.rustify/covers/**`, listado à parte em
  `tauri.android.conf.json`. Ordem de operação: release →
  `export_manifest.py --deploy` (túnel 16333) → `phone_push_retry.sh`
  na cmr-auto → `lib_rescan`. O job remoto de capas é idempotente e
  atômico (tmp+rename, "pronto" = jpg > 0 bytes); detalhes na docstring
  do script. `test_export_manifest.py` é gate real: `release_android.sh`
  o roda antes do build.
- Origem por item na fila (26/08, paridade com o `contOrigin` do
  desktop): a faixa ESCOLHIDA leva `manual`; a cauda que auto-avança
  leva `playlist` (linha de playlist, `playFolderFrom`) ou `album_seq`
  (lista/álbum/artista/busca/shelves, `playTrackFrom` — `album_seq` fica
  FORA dos sinais por design). Playlist = continuidade OFF em TODOS os
  caminhos (Play, Shuffle, linha, "Tocar agora", "Tocar a partir daqui").
  Badge: `manual` + contextId = "playlist". `shuffle_upcoming` (CMR-218)
  reordena só a cauda via `replaceMediaItems` — meta por item intacta.
  "Recently played" (CMR-215) = anel `recents.json` com `played_at`
  (conta se >= 20s ou >= 25%; legado sem o campo fica fora da shelf).
- Proveniencia: `device.json` no **dataDir raiz** do app Android
  (`/data/data/dev.cmr.rustifyplayer/device.json` — NAO em `files/`),
  device_id do S24 = `s24`, imutavel. APK carimba `app_version` proprio.
- Sync fase 2: worker Android (60s) drena o journal e POSTa em
  `http://100.102.249.9:19878/sync/events` (override:
  `sync.json` no data dir). Receptor no app DESKTOP
  (`src/sync_receiver.rs`, sobe no setup, bind SO no IP tailscale).
  Ack pos-200; upsert idempotente por UUID (`insert_synced_event` NAO
  re-estampa proveniencia). Payload validado por teste byte a byte
  contra o builder desktop. E2E validado 13/08 (regua mostra
  `s24` no breakdown por device). ureq no Android e SEM TLS —
  WireGuard da tailnet e o canal (rustls/ring exigiria clang do NDK).
- Like no mobile (CMR-220): coracao no cabecalho do Now Playing ->
  `set_like` (plugin, SEM withController) -> linha `like`/`unlike` no
  MESMO journal, com a MESMA forma da linha de play_event
  (`EventJournal.lineOf`, pura e testada; linha invalida travaria o lote
  do sync sem ack) -> sync (payload pelo mesmo builder, proveniencia
  estampada pelo worker) -> receiver desktop roteia por `event_type` pra
  `track_enrichments` (`apply_synced_like`, LWW por `like_updated_at`,
  fallback `liked_at` no legado; `toggle_like` do desktop grava o mesmo
  campo) — like NUNCA vira play_event. Estado no aparelho semeado pelo
  manifest (`liked_at`/`like_updated_at`, `fetch_like_state` no export) +
  override local `kv-mobile-likes` (`src/mobile/likes.ts`, o mais novo
  vence) — **reexportar o manifest apos release** pra fechar o ciclo.
  NAO e origin: a fila nao muda; anel de recentes/tender ignoram.
  Resposta do receiver (`SyncedOutcome`): 5xx/transporte com o Qdrant
  → 503 e o S24 NÃO acka (re-envia o lote inteiro no próximo tick; upsert
  por uuid e LWW tornam o replay seguro); rejeitado por validação
  (proveniência, `timestamp` ausente ou <= 0) OU por 4xx do Qdrant
  (`SyncedFail::from_ureq`: determinístico, `qdrant <code>: <corpo>` no
  log — 503 ali viraria head-of-line do lote) → 200 e ack; no-op por LWW
  conta como aceito. Nunca voltar a responder 200 em erro de transporte:
  o like/play sumia pra sempre.
  ORDEM DE RELEASE: o .deb do desktop entra ANTES do APK, senao o
  receiver antigo grava like como play_event.

### Build, install e debug

```bash
# Release Android (VM): bun run build + APK debug arm64 SEM debuginfo
# (~50 MB; o universal com DWARF tinha 520 MB) + android-latest.json,
# publicados no release `dev`. Bump em tauri.conf.json ANTES.
./scripts/release_android.sh            # ou --dry-run (sem upload)
# Primeira instalacao (ou troca de keystore) continua via adb:
scp src-tauri/target/android-release/rustify-player_<V>.apk cmr-auto@100.102.249.9:/tmp/ && \
  ssh cmr-auto@100.102.249.9 'adb install -r /tmp/rustify-player_<V>.apk'
# Permissao de acervo (uma vez por install limpo):
ssh cmr-auto@100.102.249.9 'adb shell appops set dev.cmr.rustifyplayer MANAGE_EXTERNAL_STORAGE allow'
```

- **Auto-update (v0.2.76, spec `docs/superpowers/specs/2026-08-24-android-auto-update-design.md`)**:
  o app consulta `android-latest.json` do release `dev` (check no boot com
  throttle de 6h + botão em Settings > Atualização), baixa o APK pelo Kotlin
  (TLS da plataforma — o ureq do Android é sem TLS), confere sha256 e commita
  uma `PackageInstaller.Session`; o sistema pede confirmação (sideload nunca é
  silencioso). Exige o toggle "instalar apps desconhecidos" uma vez. O
  `versionCode` deriva da semver (0.2.74 → 2074): só sobe com bump.
  **Assinatura = debug keystore da VM** (`~/.android/debug.keystore`, backup
  em `cmr-auto:~/backups/rustify-debug.keystore`): trocar o keystore quebra o
  update por cima e obriga reinstalar via adb.
- Testes JVM do plugin Kotlin (JUnit4, `android/src/test/java/`):
  `cd src-tauri/gen/android && ./gradlew :tauri-plugin-rustify-audio:testDebugUnitTest`
  (precisa dos arquivos autogerados do Tauri — existem apos o 1o android build).
  Gotcha: se o daemon do Gradle falhar com `Failed to exec spawn helper`
  (Test Executor nao inicia), e o daemon em estado ruim, nao o codigo:
  `./gradlew --stop` e rodar de novo.
- Log Rust NAO roteia pro logcat — ler via
  `adb shell run-as dev.cmr.rustifyplayer tail logs/rustify-player.log`.
- Smoke test CDP (WebView): `localabstract:webview_devtools_remote_<pid>`,
  `suppress_origin=True`. Scripts em `scripts/android/` (rodam NA cmr-auto
  via `~/.local/bin/uv run --with websocket-client`): `cdp_eval.py "<js>"`
  (avalia JS no WebView), `smoke_mobile.py` (tabbar, playlist=off, origem
  por item, shuffle do restante, like no journal, capas, recents) e
  `e2e_updater.py` (ciclo completo do auto-update). **O aparelho precisa
  estar DESBLOQUEADO**: com keyguard o app fica `procState=TPSL` e o
  `netpolicy` corta a rede do UID (`blocked=APP_BACKGROUND`) — DNS/TCP
  falham so no app enquanto a shell do adb resolve; `svc power stayon usb`
  mantem a tela acesa, mas na lock screen. `run-as <pkg> ping` NAO e
  oraculo de rede (nao herda o grupo `inet`).
  **Segundo bloqueio, distinto do keyguard (27/08)**: app em BACKGROUND sem
  playback (ex. WhatsApp por cima) e congelado pelo App Freezer (Android
  14+) — o socket `webview_devtools_remote_<pid>` aceita a conexao no
  kernel mas nenhuma thread responde; `cdp_eval`/`smoke` penduram (o
  `urlopen` tem `timeout=5` desde 27/08 pra falhar rapido). Checar
  `dumpsys activity activities | grep topResumedActivity` e
  `curl --max-time 5 :9333/json/version` ANTES de rodar script; se preciso,
  `adb shell monkey -p dev.cmr.rustifyplayer -c android.intent.category.LAUNCHER 1`.
  Com playback o MediaSessionService e foreground e nao congela.
  **`pkill -f "[c]dp_eval"` via SSH**: em chamada SSH SEPARADA — se a mesma
  linha remota invoca `cdp_eval.py` adiante, o pkill mata a propria shell
  (exit 255; aconteceu tres vezes em 26-27/08).
- `.cargo/config.toml` alinha o .so a 16KB (`max-page-size=16384`,
  Android 15+). Nao remover.
- UI mobile Solid em `src/mobile/` (dynamic import; desktop intocado),
  montada por deteccao de user agent no `main.tsx`.
