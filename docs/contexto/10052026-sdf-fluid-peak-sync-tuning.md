# Contexto: SDF Raymarching + Fluid Peak-Sync Tuning Iterativo

**Data:** 2026-05-10 (continuação da mesma data, sessão posterior à de Lissajous bulk backfill)
**Branch:** main
**Duracao:** ~6h

---

## O que foi feito

### 1. SDFBackground.tsx — novo componente WebGL2 raymarching

Criado do zero como style alternativo ao `style: "fluid"`. Implementa SDF
raymarching com 3 esferas (uma por banda perceptual) merged via Inigo-Quilez
smooth min, domain warping audio-modulado, palette tríade, half-res FBO +
upscale linear pra performance em iGPU.

Dois modos via uniform `u_render_mode`:

| Mode | Custo fragment | Visual | Quando usar |
|------|----------------|--------|-------------|
| `0` (2D glow) | ~1 SDF eval/pixel | Neon stylized, sem volume | Smooth garantido em iGPU |
| `1` (3D raymarched) | step_count × SDF + normal calc | Volumetric, fresnel rim | Quando hardware aguenta |

Decisão do usuário: **mode 0 (2D)** após teste — diferença visual entre 2D
e 3D foi menor do que esperado, perf 50× melhor.

### 2. SDF impulse system (sync com música)

Depois de feedback "reage exatamente ao grave mas dá um ZOOM/piscando":

**Antes:** raio = `0.55 + bass × 0.55` (suave, sempre presente)
**Depois:** raio = `0.10 + bass × 0.30 + bass_impulse × 0.65` (idle minúsculo, explode em peaks)

Adicionado **ASR envelope** (Attack-Sustain-Release) pra evitar flash:
```
attack_rate = 0.30 (lerp/frame, ~80ms ramp visível)
release_rate = 0.08 (lerp/frame, ~170ms organic falloff)
target_decay = 0.94 (~250ms half-life)
```

Peak-detection mirrored do fluid: running avg per band + cooldown + threshold.
Em silêncio: esferas com raio ~0.10/0.05/0.03 = canvas quase preto. Em peak:
"explosão" + decay suave.

### 3. FluidBackground — peak-trigger refactor

Remoção da emissão contínua (60fps × 3 ghosts = 180 splats/s, criava blob
persistente). Substituída por peak-triggered emission:

```typescript
const isPeak = (byDelta || byRatio) && (now - lastPeakT > cooldown);
```

**Onde a iteração foi sofrida:**

1. Threshold ratio (1.25-1.45) — suave demais = blob persistente, alto demais = piscando
2. Cooldowns (40-200ms por banda) — variaram entre "spam de splats" e "0 sensibilidade"
3. Position: Lissajous(t) puro acumulava splats no mesmo path → adicionado **jitter** ±10% canvas
4. Detection ratio-based **falha em música constante** porque running avg se acomoda → adicionada **delta-based detection** como path paralelo (OR)

Configuração final estável:
- PEAK_THRESHOLD: 1.25 (ratio path)
- DELTA_THRESHOLD: 0.06 (delta path — primário em música densa)
- ABS_FLOOR: 0.12 (hardcoded, noise floor)
- Cooldowns: bass 130ms / mid 90ms / treble 50ms

### 4. Color jitter por splat

Cada splat agora pinta com hue + saturation aleatórios dentro da banda:

```typescript
const hueJitter = (Math.random() - 0.5) * fluidCfg.HUE_JITTER;       // ±7%
const sat = fluidCfg.SAT_BASE + peakStrength * 0.25 + Math.random() * fluidCfg.SAT_JITTER;
const c = HSVtoRGB((baseHue + g.hueOffset + hueJitter + 1) % 1, Math.min(1, sat), 1);
```

Tríade bass/mid/treble preservada (cores anchor distintas), mas dentro de
cada banda os splats são visualmente diversos. Pintura, não esquema repetido.

### 5. 6 novos params do fluid no YAML (hot-reload)

Antes calibrar via YAML não cobria peak-trigger nem cor. Agora cobre:

| Param | Default | Faixa |
|-------|---------|-------|
| `fluid_peak_threshold` | 1.25 | 1.10–1.60 |
| `fluid_delta_threshold` | 0.06 | 0.03–0.12 |
| `fluid_jitter_amount` | 0.10 | 0.0–0.25 |
| `fluid_hue_jitter` | 0.14 | 0.0–0.40 |
| `fluid_sat_base` | 0.75 | 0.4–1.0 |
| `fluid_sat_jitter` | 0.10 | 0.0–0.30 |

Usuário já subiu `fluid_density_dissipation: 45.0` (default 4.0) e
`fluid_sensitivity: 1.5` na cmr-auto via edit direto — calibragem viva.

### 6. Pause gates em ambos componentes

Bug: app não parava splats ao pausar (gate `player.isPlaying` faltava).
Fix em ambos: emit gating no frame loop, mas `step()` continua rodando
(dye dissipa naturalmente até preto).

## Estado dos arquivos

### Backend (Rust)

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src-tauri/src/lib.rs` | Modificado | +13 SDF defaults (`sdf_*`), +6 peak/colour defaults (`fluid_peak_*`, `fluid_*_jitter`, `fluid_sat_*`); fluid defaults rebalanceados várias vezes |

### Frontend (Solid/TS)

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src/components/FluidBackground.tsx` | Modificado | +peak detection (ratio + delta paths), +ASR envelope-like cooldown, +position jitter, +hue/sat jitter, +pause gate, BAND_SMOOTH 0.88→0.55, GHOSTS hueOffsets 0/0.08/0.16→0/0.33/0.66 |
| `src/components/SDFBackground.tsx` | **Criado** | WebGL2 raymarching, 2 modes (2D glow / 3D ray), half-res FBO + upscale, ASR impulse envelope per band |
| `src/views/NowPlaying.tsx` | Modificado | Switch ternário style: sdf → SDFBackground / fluid → FluidBackground / outros → SpectrumBackground |
| `src/tauri.ts` | Modificado | +13 SDF fields + 6 peak/colour fields no `SpectrumVisualConfig` interface |

### Configs externas (cmr-auto)

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `~/.local/share/rustify-player/spectrum/default.yaml` | Modificado | fluid_density_dissipation user-tuned para **45.0**, fluid_sensitivity 1.5, +6 novos peak/colour params |
| `~/.local/share/rustify-player/spectrum/default-sdf.yaml` | **Criado** | Preset SDF style com `sdf_render_mode: 0` (2D escolhido pelo user) |

### Memória persistida

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `~/.claude/projects/-home-opc-rustify-player/memory/feedback_app_runs_on_cmr_auto.md` | Criado | Direção de comandos: usuário roda local na cmr-auto, Claude usa SSH |
| `~/.claude/projects/-home-opc-rustify-player/memory/feedback_remind_dpkg_install.md` | Criado | Toda release publicada precisa `dpkg -i` antes de teste; YAML hot-reload sem código novo causa estado inconsistente |

## Commits desta sessao

Nenhum commit ainda — todas as mudanças desta sessão estão em working tree
não-commitadas. Releases publicadas via `release.sh` consumiram o working
tree direto, sem checkpoints intermediários. **Recomendação:** próxima
sessão deve commitar antes de continuar.

## Decisoes tomadas

- **Peak-trigger em vez de continuous emission no fluid** | Continuous (180 splats/s) criava blob persistente, sem causa-efeito legível com música. | Descartado: dissipation extrema (10+) — mata fluid feel
- **Delta detection paralelo ao ratio detection** | Ratio sozinho falha em música constante (running avg se acomoda, peaks param após 1s). Delta detecta onsets independente do nível médio. | Descartado: spectral flux completo — overkill, derivada simples basta
- **ASR envelope no SDF impulse** | Impulse instantâneo causava flash/zoom 1-frame. Envelope com attack rápido + release lento = pulse orgânico. | Descartado: decay exponencial puro — flash mantido visualmente
- **2D mode default no SDF (após teste)** | Diferença visual entre 2D e 3D foi menor que esperado, 50× mais barato. | Mantido 3D como opt-in via YAML
- **Triadic palette (hue 0/0.33/0.66)** | Vs 0/0.08/0.16 anterior: 8% no círculo cromático = invisível, 33% = obviamente distinto. | Descartado: bandas com cores casadas — usuário não conseguia mapear "essa cor = essa banda"
- **Jitter 0.10 em vez de threshold/cooldown apertados** | Pra resolver "blob eterno", jitter sozinho basta — splats consecutivos caem em pontos diferentes, dissipation alcança. Apertar threshold/cooldown junto matava reatividade (lições da sessão). | Descartado: over-tuning multi-dimensional simultâneo
- **Velocity dissipation BAIXA (2.5) em vez de alta** | Fluid feel exige velocity persistente pro solver criar swirl/curl. velocity=8 matava velocity em 100ms = blobs estáticos sem look líquido. | Descartado: velocity alta + force alta — splats voavam
- **6 params expostos no YAML** | Hot-reload em peak/colour acelera muito calibragem subjetiva. | Descartado: expor TUDO (BAND_SMOOTH, force_multiplier, brightness_curve) — escopo mínimo viável agora
- **App run direction memória** | Usuário escorregou em comando com SSH; rules registradas pra evitar recorrência. | Memória persistida: comandos pro user vão sem SSH, comandos meus pra inspecionar vão com SSH
- **dpkg install reminder** | Falso "piorou" foi causado por release não instalada (binário 21:48 ontem, mudanças hot-reload de YAML em código antigo). | Memória persistida: sempre lembrar dpkg + checkar timestamp+uptime antes de assumir tuning errado

## Métricas

| Metrica | Valor |
|---------|-------|
| Releases dev publicadas | ~9 (todas tag `dev` atualizada) |
| Iterações peak-trigger fluid | 5 (threshold/cooldown/jitter/dissipation/force) |
| Iterações SDF mode | 3 (3D full → lite 3D → 2D + impulse) |
| Linhas FluidBackground delta | +169 -54 |
| Componente SDFBackground.tsx | ~565 linhas (novo) |
| Backend SpectrumVisualConfig fields adicionados | 13 sdf_* + 6 fluid_peak/colour |
| Memórias persistidas | 2 (feedback_app_runs_on_cmr_auto, feedback_remind_dpkg_install) |

## Pendências identificadas

1. **Commit de tudo desta sessão** (alta) — working tree tem 4 arquivos modificados + 1 novo (SDFBackground.tsx) + docs/ untracked. Sugestão: 3 commits separados
   - `feat(sdf): SDFBackground component with 2D/3D render modes`
   - `feat(fluid): peak-triggered emission with delta detection + colour jitter`
   - `feat(spectrum): expose 6 fluid peak/colour params via YAML hot-reload`

2. **Calibragem do `fluid_density_dissipation: 45.0`** (alta) — usuário tuned na cmr-auto. Testar se faz sentido como default no Rust ou só como preset alternativo. Default atual no código é 4.0. 45 é absurdamente agressivo, sugere que peak-trigger funciona melhor com fade quase instantâneo.

3. **`bass_attack_scale: 0.9`** (média) — usuário também tuned (default era 0.43). Desconhecido qual é o efeito visual desse param no fluid atual — pode ser legacy do SpectrumBackground V2. Vale auditar uso.

4. **SDF testado preferencialmente em 2D mode** (média) — usuário escolheu mode 0. Vale considerar: deixar mode 0 como default no Rust (default atualmente é 1), e 3D como opt-in.

5. **SDF não tem hue jitter / sat jitter** (média) — só fluid recebeu essa feature. Se SDF for o paradigma preferido a longo prazo, vale portar.

6. **X600 EQ ear-test do warm-tilt** (alta, herdada) — preset reordenado em `cmr-auto:~/Downloads/Soundcore-Motion-X600-warm-tilt.json`. Aprovado conceptualmente, ainda não validado em escuta longa.

7. **YAML hot-reload pra EQ** (média, herdada) — discussão adiada da sessão anterior. ~1h dev.

8. **Migração SDF Raymarching avaliada** (concluída parcialmente) — feita como style alternativo. Ainda não decidido se SDF substitui fluid como default ou se fica como opção paralela.

9. **Volumetric raymarching / WebGPU paradigms** (baixa) — discutido mas descartado pra Linux/WebKitGTK atual. Reabrir só se trocar de webview.

10. **Sidecar Qdrant defunct cosmético** (baixa, herdada) — `[qdrant] <defunct>` aparece nos `ps aux`. Inocuo. Cleanup graceful shutdown.
