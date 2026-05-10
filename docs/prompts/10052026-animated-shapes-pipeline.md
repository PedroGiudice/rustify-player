# Retomada: Animated Shapes Pipeline + Driver Modes

## Contexto rapido

Pipeline completa de **animated shapes** entregue: vídeo → 48-96 frames pré-processados como normal maps + color textures → classificação semântica via Gemini → driver com 3 modos audio-reativos (`intensity`, `band_split`, `pendulum`). Working tree dirty, 7 arquivos modificados/criados, **zero commits feitos**.

Funcional na cmr-auto: `rotating-face` (48 frames, ping-pong sem costas) e `burning-R` (96 frames, chamas) ambos classificados. Driver default = `intensity`. Rest state implementado pra evitar frozen-frame em transições/breakdowns.

Próximo movimento natural do usuário: **gerar novo vídeo source com full bass-mid-treble range** (burning-R não tem "bass", rotating-face não tem "peak") + commit do trabalho desta sessão.

## Arquivos principais

### Código (working tree, não commitado)
- `src/components/SpectrumBackground_V2.tsx` — driver completo (3 modos + rest state) na função `draw()`, e `loadAnimatedShape()` que carrega manifest + N texturas
- `src-tauri/src/lib.rs` — `list_shapes` aceita diretórios com manifest.json (linha ~1080); 6 defaults `shape_anim_*` em torno da linha 760
- `src/tauri.ts` — interface `SpectrumVisualConfig` com 6 fields adicionados
- `scripts/build_shape_anim.mjs` — gera shape directory a partir de vídeo (Node + sharp + ffmpeg)
- `scripts/classify_shape_anim.py` — classifica frames com Gemini, atualiza manifest

### Docs
- `docs/contexto/10052026-animated-shapes-pipeline.md` — contexto detalhado desta sessão
- `docs/contexto/10052026-sdf-fluid-peak-sync-tuning.md` — sessão anterior do mesmo dia (SDF + fluid)

### Configs externas (cmr-auto)
- `~/.local/share/rustify-player/spectrum/*.yaml` (×7 presets) — todos com 6 params shape_anim_* + `shape_anim_mode: band_split`
- `~/.local/share/rustify-player/media/shapes/rotating-face/` — 48 frames + manifest classificado
- `~/.local/share/rustify-player/media/shapes/burning-R/` — 96 frames + manifest classificado

## Próximos passos (por prioridade)

### 1. Commit do trabalho (alta)

**Onde:** root do repo
**O que:** 2 commits separados
- `feat(spectrum): animated shapes pipeline with semantic driver modes` — `src/components/SpectrumBackground_V2.tsx`, `src-tauri/src/lib.rs`, `src/tauri.ts`, `scripts/build_shape_anim.mjs`, `package.json`, `bun.lock`
- `feat(scripts): Gemini-based shape frame classification` — `scripts/classify_shape_anim.py`
- Docs de contexto/prompts vão num terceiro commit `docs:` ou junto do feat principal

**Por que:** working tree dirty bloqueia futuras releases limpas e perde rastreabilidade.

**Verificar:**
```bash
git status --short  # esperado: clean após commits
```

### 2. Gerar source video com full audio range (alta)

**Onde:** Veo (ou LTX/Cogvideo locais)

**O que:** Vídeo 12-16s com gradiente natural bass→mid→treble. Recomendações priorizadas:
1. **Vulcão erupcionando** — pluma densa (bass) → lava fluindo (mid) → faíscas (treble). Black bg.
2. **Ink in water slow-mo** — drop denso (bass) → tendrils (mid) → wisps (treble). Black bg.
3. **Plasma orb** — núcleo denso pulsando (bass) → arcos elétricos (mid) → faíscas tip (treble).

**Por que:** burning-R tem 0 bass / rotating-face tem 0 peak. Band_split mode só fica realmente expressivo quando shape tem distribuição rica nas 3 bandas. Caso contrário funciona via fallback intensity_ranking, mas é menos óbvio que separação espectral.

**Verificar:** após gerar, rodar pipeline e checar distribuição:
```bash
# Na VM Contabo
scp cmr-auto@100.102.249.9:~/Downloads/<video>.mp4 /tmp/
node scripts/build_shape_anim.mjs --video /tmp/<video>.mp4 --name <slug> --frames 96 --dim 700 --out /tmp/shape-out
/home/opc/rustify-player/.venv/bin/python scripts/classify_shape_anim.py --name <slug> --shapes-dir /tmp/shape-out
# Distribuição esperada: bass>5, mid>5, treble>5
scp -r /tmp/shape-out/<slug> cmr-auto@100.102.249.9:~/.local/share/rustify-player/media/shapes/
```

### 3. Possíveis tuning iterativos (média)

**Onde:** YAMLs em `~/.local/share/rustify-player/spectrum/` (cmr-auto, hot-reload sem rebuild)

**Conhecimento atual:**
- `shape_anim_mode: band_split` (default) — usa classificação Gemini, fallback inteligente
- `shape_anim_baseline_speed: 0.04` — ease rate (0.02 lento, 0.10 reativo)
- `shape_anim_energy_gain: 1.0` — sensibilidade (multiplicado ×5 internamente). 0.4 = sutil, 2.0 = saturado
- Rest threshold hardcoded em 0.04 — se disparar em passagens quietas legítimas, expor via YAML

**Verificar:** edita YAML, espera ~2s, observa mudança no app sem reabrir.

### 4. Pendências herdadas de sessões anteriores (baixa-média)

- `bass_attack_scale: 0.9` audit no fluid — verificar se afeta ou é legacy V2
- YAML hot-reload pra EQ — sessão anterior, ~1h dev
- X600 EQ ear-test — preset aprovado mas sem validação auditiva
- Mensagem do commit `d41faae` em prosa em vez de Conventional Commits — `git commit --amend` resolve

## Restrições / Cuidados

- **NUNCA compilar localmente na cmr-auto** — sempre `bash scripts/release.sh` na VM Contabo. Memória: `feedback_app_runs_on_cmr_auto.md`.

- **APP roda na cmr-auto, NÃO na VM Contabo.** Comandos pro user passam SEM `ssh`. Comandos meus pra inspecionar usam `ssh cmr-auto@100.102.249.9`.

- **TODA release publicada precisa `dpkg -i` antes de testar.** YAML hot-reload pega params novos sem reabrir, mas mudanças de CÓDIGO (shape modes, drivers) só entram com binário novo. Memória: `feedback_remind_dpkg_install.md`.

- **Driver tunings vivem em YAML.** Não introduzir mais params hardcoded em `SpectrumBackground_V2.tsx` — usar `cfg.shape_anim_*`. Se precisar de novo knob, adicionar em lib.rs (Rust) + tauri.ts (TS) + DEFAULT_CONFIG + sed nos YAMLs cmr-auto.

- **Reuso de YAML knobs por modo:** `baseline_speed` significa ease rate em intensity/band_split MAS spring stiffness em pendulum. `peak_decay` significa spring damping em pendulum, ignorado nos outros modos. Documentar ao tocar.

- **Build script preserva algoritmo idêntico ao runtime.** Sobel/dither/packing 1:1 com o que `loadShape()` faz pra imagens estáticas. Não mexer sem propagar a mudança nos dois lados.

- **Gemini classification não é determinística.** Reclassificar a mesma shape pode dar contagens ligeiramente diferentes em bands/moods. Se bater inconsistência grave, reduzir temperatura no script (default 1.0).

## Como verificar

```bash
# 1. Repo state
cd /home/opc/rustify-player
git status --short
# Esperado se passo 1 não executado: 7 arquivos M/?? listados

# 2. Builds limpos
cargo check --manifest-path src-tauri/Cargo.toml 2>&1 | tail -3
bun x vite build 2>&1 | tail -3

# 3. Release atual instalada na cmr-auto
ssh cmr-auto@100.102.249.9 "stat -c '%y' /usr/bin/rustify-player; ps -eo etime,cmd | grep '/usr/bin/rustify' | grep -v grep"
# Esperado: timestamp recente + uptime baixo

# 4. Shapes na cmr-auto
ssh cmr-auto@100.102.249.9 "ls ~/.local/share/rustify-player/media/shapes/"
# Esperado: rotating-face/, burning-R/ + as estáticas

# 5. Classificação dos manifests
ssh cmr-auto@100.102.249.9 "jq '.frames, .band_groups | length' ~/.local/share/rustify-player/media/shapes/burning-R/manifest.json"
# Esperado: 96 e 3

# 6. YAMLs com mode setado
ssh cmr-auto@100.102.249.9 "grep -h shape_anim_mode ~/.local/share/rustify-player/spectrum/*.yaml"
# Esperado: band_split em todos
```

<session_metadata>
date: 2026-05-10
branch: main
last_commit: d41faae (não desta sessão)
working_tree: dirty (7 files M/??)
release_tag: dev (v0.2.3, múltiplas republicações)
shapes_classified: rotating-face (48 frames), burning-R (96 frames)
default_mode: band_split
gemini_cost_so_far: ~$0.024
pending_videos: vulcão / ink-in-water / plasma orb (full bass-mid-treble range)
memories_referenced:
  - feedback_app_runs_on_cmr_auto.md
  - feedback_remind_dpkg_install.md
</session_metadata>
