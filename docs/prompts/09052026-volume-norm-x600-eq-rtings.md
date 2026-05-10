# Retomada: Volume Normalization + X600 EQ + Backlog DSP/Visual

## Contexto rapido

Sessao implementou **EBU R128 volume normalization** (gain stage post-EQ pre-Limiter, +14 LUFS target hardcoded, ebur128 crate) no branch `feat/volume-normalization` em worktree dedicado. 3 commits atomicos no volnorm. Subagente ja finalizou implementacao + cleanup; release dev rodando em background. Ainda nao mergeado nem PR aberto.

Em paralelo, iteramos um **preset corretivo de EQ pra Soundcore Motion X600** (16 bandas, oratory-style, baseado em curva RTINGS real). Preset esta em `cmr-auto:~/Downloads/Soundcore-Motion-X600-corrective.json`. Ultima iteracao ainda nao satisfatoria — bass insuficiente, hi-hats fortes — testes adicionais necessarios.

Backlog: LSP plugins (Loudness Compensator top), multi-stem video como bg (em vez de fluid sim), like button animation (parked).

## Arquivos principais

### Implementacao

- `/home/opc/rustify-player-volnorm/src-tauri/crates/audio-engine/src/loudness.rs` — funcoes puras `gain_db_to_linear`, `lufs_to_gain_db` (clamp ±24dB)
- `/home/opc/rustify-player-volnorm/src-tauri/crates/library-indexer/src/loudness.rs` — `analyze_file` (symphonia decode + ebur128 push)
- `/home/opc/rustify-player-volnorm/src-tauri/crates/audio-engine/src/output/dsp.rs` — `norm_gain` GStreamer `volume` element entre EQ e Limiter, `set_norm_gain_db` / `set_norm_enabled`
- `/home/opc/rustify-player-volnorm/src-tauri/src/lib.rs` — NormState (AtomicBool), worker thread `loudness-backfill`, IPC commands, hook em `TrackStarted`
- `/home/opc/rustify-player-volnorm/src/views/Settings.tsx` — toggle "Normalizar volume entre faixas"

### Documentos

- `docs/contexto/09052026-volume-norm-x600-eq-rtings.md` — contexto detalhado desta sessao
- `docs/x600-curves/rtingscurve.webp`, `rtingscurve2.webp` — medicoes RTINGS (untracked, ficar onde estao)
- `/home/opc/deep-research-outputs/2026-05-09-fluid-audio-reactive-visualizers.md` — relatorio Gemini Deep Research (242 linhas) pra fluid sim corretamente implementada (parked)

### Externos

- `cmr-auto:~/Downloads/Soundcore-Motion-X600-corrective.json` — preset EQ X600 atual (formato EasyEffects)

## Proximos passos (por prioridade)

### 1. Verificar release dev e pull na cmr-auto

**Onde:** background task `b0wv61m6h` (`/tmp/claude-1000/-home-opc-rustify-player/e271f6b2-a27b-4995-84ba-3ab6f25af699/tasks/b0wv61m6h.output`)

**O que:** confirmar que o build .deb foi publicado na rolling release `dev` do GitHub.

**Por que:** sem release, user nao testa volume normalization na cmr-auto.

**Verificar:**
```bash
# Estado do build
tail /tmp/claude-1000/-home-opc-rustify-player/e271f6b2-a27b-4995-84ba-3ab6f25af699/tasks/b0wv61m6h.output

# Confirmar release no GitHub
gh release view dev -R PedroGiudice/rustify-player

# Pull na cmr-auto (user roda)
ssh cmr-auto@100.102.249.9 "gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber && sudo dpkg -i /tmp/rustify-player_*_amd64.deb"
```

### 2. Smoke test do volume normalization

**Onde:** app instalado na cmr-auto.

**O que:** validar que normalization funciona end-to-end:
- Settings -> "Normalizar volume entre faixas" checked default
- Toca track legacy (sem `lufs_integrated` no Qdrant) -> log `loudness-backfill: track analyzed lufs=...`
- Toca a mesma track de novo -> aplica gain (log: `DspSetNormGainDb`)
- Tracks de gêneros loudness diferentes (jazz ~-23 LUFS vs pop ~-8 LUFS) em sequencia -> transicao nivelada
- Toggle off -> proximas tracks passam sem normalizacao

**Por que:** valida o MVP antes de mergear.

**Verificar:**
```bash
# Confirmar que existe lufs_integrated no payload Qdrant
curl -s http://localhost:6333/collections/rustify_tracks/points/<ID> | jq '.result.payload | keys' | grep lufs_integrated
```

### 3. PR do volume normalization

**Onde:** `/home/opc/rustify-player-volnorm`, branch `feat/volume-normalization`.

**O que:** push + PR.

**Por que:** consolidar feature na main.

**Verificar:**
```bash
cd /home/opc/rustify-player-volnorm
git push -u origin feat/volume-normalization
gh pr create --title "feat: Volume normalization (EBU R128 LUFS)" --body "..."
```

### 4. X600 EQ — iteracao baseada em ear-test

**Onde:** `cmr-auto:~/Downloads/Soundcore-Motion-X600-corrective.json` + UI do app (Signal -> Importar preset).

**O que:** ouvir o preset atual (16 bandas, preamp -5dB), reportar onde dói, ajustar bandas pontuais. Manter Spatial+BassUp OFF na caixa Soundcore. Limiter desligado por enquanto.

**Por que:** preset baseado em curva RTINGS real mas nao validado por ear-test. Ultimas reclamacoes (sem grave, hi-hats fortes) mostraram que a interpretacao da curva ainda esta off.

**Verificar:** auditivamente. Tracks de teste sugeridas:
- Vocal centralizado: Adele "Hello", Lianne La Havas "Bittersweet"
- Bumbo + low-end: Daft Punk "Doin' It Right", Tame Impala "The Less I Know"
- Pratos/agudos: Steely Dan "Aja", Charlie Parker
- Densidade vocal: Kendrick "DNA", J. Cole

### 5. LSP Loudness Compensator (Fletcher-Munson dinamico)

**Onde:** GStreamer pipeline em `src-tauri/crates/audio-engine/src/output/dsp.rs`. Adicionar como elemento LV2 entre `audioconvert` (input) e EQ.

**O que:** integrar plugin `lsp-plug.in-loudness-compensator` (apt: `lsp-plugins-lv2`). Expor `volume` parameter (input level) atraves de IPC; plugin calcula a curva FM inversa internamente. Toggle no Settings.

**Por que:** musica em volume baixo perde bass e treble percebido (Fletcher-Munson). Compensador dinamico restaura percepcao plana sem usuario pensar. Killer feature pra music player.

**Verificar:**
```bash
# Confirmar plugin instalado
gst-inspect-1.0 lv2 | grep -i loud
# Fica algo tipo "lsp-plug.in/plugins/lv2/loud_comp"
```

### 6. Multi-stem video como bg (substituir spectrum + fluid)

**Onde:** novo componente `src/components/MultiVideoBackground.tsx`.

**O que:** 5 vídeos H.264 sincronizados (mesma cena, intensidades diferentes — ambient/bass/mid/high/peak) → 5 textures WebGL2 → fragment shader faz weighted sum com pesos vindos do FFT (smoothing 0.85-0.92, alocacao por banda). Geracao dos stems via CogVideo no Modal.

**Por que:** decisao arquitetural — fluid sim e "player de 2008". Multi-stem video com weighted shader blend e direcao moderna (Apple Music animated artwork, Spotify Canvas reactive em beta usam tecnicas similares).

**Verificar:** primeiro gerar 5 stems-teste no Modal (~15 min total) antes de implementar componente.

### 7. Limiter — quando reativar, garantir `boost: false`

**Onde:** `src-tauri/crates/audio-engine/src/output/dsp.rs`, criacao do limiter.

**O que:** quando o user reativar o limiter (atualmente bypassed), garantir `limiter.set_property("boost", false)` no init. Auto-makeup gain conflita com normalization LUFS.

**Por que:** se boost=true, limiter eleva nivel medio quando atenua picos — torna LUFS de saida imprevisivel.

**Verificar:** apos reativar, tocar track quieta + track alta normalizadas; output LUFS de ambas deve estar consistente em ~-14 LUFS (medir externamente, ex: BS.1770 plugin).

### 8. Backlog visual (parked)

- **Like button animation:** flame SVG pixel-art (12x15, monocromatico `currentColor`) precisa de frames adicionais. Sprite SitePoint nao casa esteticamente. Aguardar arte nova ou decisao de redesign.
- **Fluid sim refactor:** relatorio canonico salvo (`/home/opc/deep-research-outputs/2026-05-09-fluid-audio-reactive-visualizers.md`). Implementacao "Ghost Mouse + Lissajous" parked como opcao "skin retro".

## Restricoes / Cuidados

- **NAO mexer em `applyFullState` do EQ** — qualquer mudanca de default break presets do user
- **NAO compilar localmente na cmr-auto** — `release.sh` na VM e o unico caminho
- **Subagentes:** verificar premissas (storage backend, tooling) antes de briefar; passar `model: "opus"` (enum nao aceita 4.6 especifico mas opus e o disponivel mais alto); `isolation: "worktree"` pode ser ignorado silenciosamente — verificar manualmente onde escreveu
- **NAO usar `--no-verify` ou `--amend`** em commits desta feature
- **`docs/x600-curves/` e `sprites-animations/`** ficam como untracked no main — sao work em andamento, nao commitar ate user decidir
- **Bass Enhancer e Limiter:** user atualmente esta com Limiter bypassed pra ear-test do EQ. Nao reativar sem user pedir.

## Como verificar

```bash
# 1. Volnorm worktree state
cd /home/opc/rustify-player-volnorm
git log --oneline -5
# Esperado: 89671ae feat(app):..., a13ed73 feat(audio-engine):..., 44ab02a feat(library-indexer):...

# 2. Cargo check limpo
cargo check --manifest-path src-tauri/Cargo.toml
# Esperado: Finished `dev` profile

# 3. Main worktree limpo
cd /home/opc/rustify-player
git status --short
# Esperado APENAS:
#   ?? docs/x600-curves/
#   ?? sprites-animations/

# 4. Release status
gh release view dev -R PedroGiudice/rustify-player --json tagName,publishedAt,assets

# 5. Preset X600 disponivel
ssh cmr-auto@100.102.249.9 "ls -la ~/Downloads/Soundcore-Motion-X600-corrective.json"

# 6. Deep research outputs salvos
ls -la /home/opc/deep-research-outputs/2026-05-09-fluid-audio-reactive-visualizers.md
```

<session_metadata>
date: 2026-05-09
branch: feat/volume-normalization
worktree: /home/opc/rustify-player-volnorm
commits: 44ab02a, a13ed73, 89671ae
release: rolling "dev" tag
preset_x600_path: cmr-auto:~/Downloads/Soundcore-Motion-X600-corrective.json
preset_x600_state: aguardando ear-test (bass insuficiente, hi-hats fortes na ultima iteracao)
limiter_state: bypassed por decisao do user pra ear-test EQ
</session_metadata>
