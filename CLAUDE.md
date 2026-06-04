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

### Fluxo

1. Subagente le perfil + biblioteca via Qdrant (`http://100.102.249.9:6333`)
2. Pesquisa iterativa (WebSearch + WebFetch) em fontes curadas
   (RateYourMusic, Pitchfork, AllMusic, Reddit, MusicBrainz)
3. Valida cada candidato via MusicBrainz API (anti-alucinacao)
4. Cross-check contra biblioteca pra remover duplicatas
5. Entrega lista markdown com: artista, track, album, ano, justificativa
   concreta ancorada no teu perfil, e **query slskd pre-formada**

### Como baixar o que voce aprovar

O subagente entrega cada sugestao com uma query slskd otimizada. Voce
indica quais aprovar e a sessao principal Claude roda o script existente:

```bash
# Por enquanto manual — adapta o script pra receber query via CLI
python /home/opc/baixar_soulseek_teste.py --query "<query>"
```

O `baixar_soulseek_teste.py` ja tem: busca, filtro FLAC + tamanho minimo,
diversificacao por peer, fallback de 3 tentativas, estado persistido.
Endpoint slskd: `http://100.102.249.9:5030`.

### Limitacoes conhecidas

- `liked_at` esta sempre 0 no Qdrant — likes explicitos nao sao usados.
  Toda inferencia de gosto vem de `play_events` (listen_pct, replays).
- Qualidade da curadoria depende de massa de eventos: com < 30 positives
  qualificadas o subagente vai sinalizar baixa confianca.
- ListenBrainz como fonte de grounding e opcional e depende de tracks
  estarem indexadas no MusicBrainz (cobertura boa pra ocidental, fraca
  pra alguns nichos brasileiros).
