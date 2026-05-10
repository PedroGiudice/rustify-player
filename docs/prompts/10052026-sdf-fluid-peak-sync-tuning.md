# Retomada: SDF Raymarching + Fluid Peak-Sync Tuning

## Contexto rapido

Sessão fechou com **dois paradigmas visuais funcionais e calibrados**:

- **Fluid (style: "fluid")**: peak-triggered emission via dois caminhos paralelos
  (ratio + delta detection), splats com hue/sat jitter por evento, position
  jitter ±10% pra evitar blob persistente. 6 novos params no YAML hot-reload.
  Usuário tuned `fluid_density_dissipation` pra **45.0** (default 4.0) na
  cmr-auto — calibragem viva, sugere fade quase instantâneo é o sweet spot.

- **SDF (style: "sdf")**: novo componente `SDFBackground.tsx` com WebGL2
  raymarching, 3 esferas mergeadas via smooth min, ASR envelope per band
  pra sync com peaks. Dois modos via `sdf_render_mode`: 0 = 2D glow (~50×
  mais barato), 1 = 3D raymarched. Usuário escolheu **mode 0** após teste.

**Estado:** working tree com 4 arquivos modificados + 1 novo, NADA COMMITADO.
Última release publicada via `release.sh` consumiu o working tree atual.

## Arquivos principais

### Código (working tree, não commitado)

- `src/components/SDFBackground.tsx` — **novo**, ~565 linhas, WebGL2 SDF raymarching com modes 2D/3D
- `src/components/FluidBackground.tsx` — peak-triggered, +169 linhas. Lógica core: linha ~530-600 (frame loop com detection)
- `src/views/NowPlaying.tsx` — switch ternário style sdf/fluid/exoskeleton (linha ~120)
- `src/tauri.ts` — interface SpectrumVisualConfig com +13 sdf_* + 6 fluid_peak/colour fields
- `src-tauri/src/lib.rs` — defaults Rust dos 19 novos fields, linhas ~683-712

### Docs

- `docs/contexto/10052026-sdf-fluid-peak-sync-tuning.md` — contexto detalhado desta sessão (decisões, métricas, pendências)
- `docs/contexto/10052026-fluid-lissajous-volnorm-bulk-backfill.md` — sessão anterior (mesmo dia)
- `docs/contexto/09052026-volume-norm-x600-eq-rtings.md` — sessão de ontem
- `/home/opc/deep-research-outputs/2026-05-10-audio-reactive-viz-alternatives.md` — DR de paradigmas (319 linhas, ranking 13)

### Configs externas (cmr-auto)

- `~/.local/share/rustify-player/spectrum/default.yaml` — preset Balanced, style fluid, com user-tuned `density_dissipation: 45.0` e `sensitivity: 1.5`
- `~/.local/share/rustify-player/spectrum/default-sdf.yaml` — preset SDF, `sdf_render_mode: 0`
- `~/Downloads/Soundcore-Motion-X600-warm-tilt.json` — preset EQ X600 (não validado ear-test)

### Memória persistida (~/.claude/projects/-home-opc-rustify-player/memory/)

- `feedback_app_runs_on_cmr_auto.md` — comandos pro user vão sem SSH, comandos meus pra inspecionar vão com SSH
- `feedback_remind_dpkg_install.md` — toda release publicada precisa `dpkg -i` antes de pedir teste

## Próximos passos (por prioridade)

### 1. Commitar tudo desta sessão (alta — bloqueador)

**Onde:** working tree do projeto

**O que:** 3 commits separados, na ordem:

```bash
# 1. Backend params (lib.rs + tauri.ts)
git add src-tauri/src/lib.rs src/tauri.ts
git commit -m "feat(spectrum): expose 13 SDF + 6 fluid peak/colour params via YAML hot-reload"

# 2. SDF component (novo paradigma)
git add src/components/SDFBackground.tsx src/views/NowPlaying.tsx
git commit -m "feat(sdf): SDFBackground component with 2D glow / 3D raymarched render modes + ASR impulse envelope"

# 3. Fluid refactor (peak-trigger)
git add src/components/FluidBackground.tsx
git commit -m "feat(fluid): peak-triggered emission with delta+ratio detection, hue/sat jitter, position jitter"

# 4. Docs (untracked — opcional, se decidir manter no repo)
git add docs/contexto/ docs/prompts/
git commit -m "docs: session contexts and resumption prompts (2026-05-09 / 10)"
```

**Por que:** working tree atual reflete múltiplas releases publicadas; sem
commits, qualquer rollback é manual via `git diff`. Próxima sessão vai
querer ramificar a partir de checkpoints.

**Verificar:** `git log --oneline -5` deve mostrar os novos commits no topo.

### 2. Reconciliar `fluid_density_dissipation` user-tuned vs default Rust (alta)

**Onde:** `src-tauri/src/lib.rs:695` (`default_fluid_density_dissipation`)

**O que:** decidir se 45.0 (atual cmr-auto) deve virar default Rust ou se
fica como override no YAML. Testar com peak-trigger:
- 4.0 (atual default): splat dura ~180ms — confortável visualmente, mas
  com peak detection denso pode acumular
- 45.0: splat fade praticamente instantâneo (~10ms). Pode parecer flash,
  mas combinado com peak-trigger talvez seja exatamente o que dá a
  sensação de "evento puro"

**Por que:** o usuário escolhendo 45.0 manualmente é um sinal — vale
investigar se default deve subir.

**Verificar:** alterar default Rust → release → testar lado-a-lado com
e sem override no YAML.

### 3. Audit `bass_attack_scale: 0.9` (média)

**Onde:** procurar uso em `src/components/FluidBackground.tsx` e
`src/components/SpectrumBackground_V2.tsx`

**O que:** confirmar se o param ainda tem efeito no fluid (provavelmente
legacy do SpectrumBackground V2). Se inerte no fluid, documentar.

**Por que:** usuário subiu pra 0.9 (de 0.43 default). Se param não afeta
nada, é confusão silenciosa.

**Verificar:** `grep -n "bass_attack_scale" src/components/*.tsx` —
mapear todos os usos e documentar quais styles são afetados.

### 4. Decidir SDF mode default no Rust (média)

**Onde:** `src-tauri/src/lib.rs` (`default_sdf_render_mode`)

**O que:** atual default é `1` (3D). Usuário preferiu `0` (2D) após teste
de comparação visual + perf. Considerar trocar default → 0.

**Por que:** alinha código com escolha real do usuário. Reduz fricção
pra novos users (já abre no modo mais smooth).

**Verificar:** abrir SDF preset sem override de YAML → conferir que abre
em 2D mode.

### 5. Portar hue/sat jitter pro SDF (média)

**Onde:** `src/components/SDFBackground.tsx`, função `triadicPaint()` no
shader (linha ~150) e shader uniforms

**O que:** hoje o SDF usa palette tríade fixa por banda (sem variação).
Fluid tem hue jitter ±7% + sat jitter por splat. Portar conceito:
- Adicionar uniform `u_hue_noise` modulando o cBass/cMid/cTreble computation
- JS-side: alimentar com `Math.random()` por frame (ou per-impulse)

**Por que:** se SDF for o paradigma preferido a longo prazo, deve ter a
mesma riqueza visual do fluid. Variação de cor é o que torna pintura
em vez de esquema.

**Verificar:** visualmente — esferas devem mostrar variação tonal
sutil mesmo em silêncio.

### 6. X600 EQ ear-test warm-tilt 4-band (alta — herdada de sessão anterior)

**Onde:** UI do app — Signal view → Importar preset

**O que:** importar `~/Downloads/Soundcore-Motion-X600-warm-tilt.json` e
ouvir tracks variadas. Reportar sensação por categoria.

**Por que:** preset aprovado conceptualmente nas sessões anteriores,
nunca validado em escuta longa.

**Verificar:** auditivamente. Tracks: Adele "Hello", Daft Punk
"Doin' It Right", Steely Dan "Aja", Kendrick "DNA".

### 7. YAML hot-reload pra EQ (média — herdada)

**Onde:** novo módulo backend, watcher `notify` em arquivo
`~/.config/rustify-player/eq-live.yaml`

**O que:** mesmo padrão de `watchSpectrumPreset`. Permitiria iterar EQ
via `sed`/edit, ciclos de 5s vs 60s pelo Signal view. ~1h dev.

**Por que:** se vamos calibrar muito (X600 + outros perfis), vale o
investimento.

## Restrições / Cuidados

- **NUNCA compilar localmente na cmr-auto** — sempre `bash scripts/release.sh`
  na VM Contabo. cmr-auto leva minutos, VM segundos.

- **APP roda na cmr-auto, NÃO na VM Contabo.** Comandos pro usuário rodar:
  passar SEM `ssh` (ele já está na cmr-auto). Comandos meus pra inspecionar:
  usar `ssh cmr-auto@100.102.249.9 "..."`. Memória registrada em
  `feedback_app_runs_on_cmr_auto.md`.

- **TODA release publicada precisa `dpkg -i` antes do teste.** YAML hot-reload
  pega params novos sem reabrir, mas mudanças de CÓDIGO (peak detection,
  jitter, novos uniforms) só entram com binário novo. Estado inconsistente
  (YAML novo + código antigo) gera regressões aparentes que parecem tuning
  ruim mas são versão errada. Sempre lembrar `dpkg -i` ANTES do teste.

- **Timestamp do binário não é prova de versão sem converter timezone.**
  VM Contabo (Frankfurt CEST UTC+2), cmr-auto (SP BRT UTC-3). Diferença 5h.

- **NÃO mexer em `applyFullState` do EQ Signal view** — quebra presets do user.

- **Dissipation no schema atual NÃO segue Pavel canonical** — calibragem
  empírica iterativa via YAML hot-reload é o caminho, não traduzir valores
  de papers.

- **NÃO assumir que `bass_attack_scale` afeta o fluid** — provavelmente é
  legacy do SpectrumBackground V2. Auditar antes de calibrar.

## Como verificar

```bash
# 1. Repo state
cd /home/opc/rustify-player
git log --oneline -5
git status --short
# Esperado: 4 modified + 1 new (SDFBackground.tsx) — ou commits feitos se passo 1 executado

# 2. Cargo check limpo
cargo check --manifest-path src-tauri/Cargo.toml
# Esperado: Finished `dev` profile

# 3. Frontend build (rápido)
bun x vite build 2>&1 | tail -3
# Esperado: ✓ built

# 4. App rodando + versão instalada (cmr-auto)
ssh cmr-auto@100.102.249.9 "stat -c '%y' /usr/bin/rustify-player; ps -eo pid,etime,cmd | grep -i rustify | grep -v grep"
# Confirmar: timestamp recente E uptime não muito velho

# 5. YAML state
ssh cmr-auto@100.102.249.9 "tail -10 ~/.local/share/rustify-player/spectrum/default.yaml; echo '---'; tail -10 ~/.local/share/rustify-player/spectrum/default-sdf.yaml"
# Esperado: 6 novos params no fluid yaml, sdf_render_mode no sdf yaml

# 6. Smoke test peak-trigger no fluid
# Tocar uma faixa com kicks distintos (techno, hip-hop) e observar:
# - Em silêncio entre faixas: canvas escurece (não tem splat sem peak)
# - Em kick: splat aparece, fade rápido
# - Em música constante: splats continuam saindo (delta detection funcionando)
# - Cores variam por splat dentro da banda (hue jitter)
```

<session_metadata>
date: 2026-05-10
branch: main
last_commit: b89244f
release_tag: dev (v0.2.3, ~9 republicações nesta sessão)
working_tree: 4 modified + 1 new component, not committed
fluid_state: peak-trigger funcional, user-tuned dissipation 45.0 na cmr-auto
sdf_state: 2D mode escolhido pelo user, ASR envelope estável
deep_research_outputs:
  - 2026-05-09-fluid-audio-reactive-visualizers.md (canonical fluid)
  - 2026-05-10-audio-reactive-viz-alternatives.md (alternativas modernas)
memories_persisted:
  - feedback_app_runs_on_cmr_auto.md
  - feedback_remind_dpkg_install.md
volume_norm_state: 100% cobertura, MVP fechado em sessão anterior
x600_eq_state: warm-tilt 4-band aprovado conceptual, ear-test ainda pendente
</session_metadata>
