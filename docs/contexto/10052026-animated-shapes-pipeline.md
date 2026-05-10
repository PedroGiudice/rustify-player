# Contexto: Animated Shapes Pipeline + Driver Modes

**Data:** 2026-05-10 (sessão 3 do dia)
**Branch:** main (working tree dirty, sem commit)
**Duracao:** ~5h

---

## O que foi feito

### 1. Bug do exoskeleton "flicker"
Causa: blending aditivo com 700×700 lines em movimento criava saturação variável por pixel. Fix: exoskeleton agora usa `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` (alpha blending normal). Só `dust` mantém aditivo. Cada linha pinta com opacidade fixa, sem soma de overlap.

### 2. Pipeline de animated shapes (diretório com manifest)
Backend (`list_shapes`) reconhece diretórios com `manifest.json` como shapes válidas além das imagens estáticas. Frontend (`SpectrumBackground_V2`) detecta URL sem extensão → carrega manifest → carrega N texturas de normal map (`normal_NNNN.png`) + N texturas de color (`color_NNNN.jpg`) na GPU.

Cada frame de render: bind da textura `frames[animFrameIndex]` no TEXTURE0 (normal map) e `colorFrames[animFrameIndex]` no TEXTURE3 (background).

### 3. Script offline de geração (`scripts/build_shape_anim.mjs`)
Node + sharp + ffmpeg. Extrai N frames de um vídeo, processa cada um com pipeline idêntico ao runtime do componente (greyscale + blur(σ=8)*0.5 + blur(σ=3)*0.7 + Sobel + dither), empacota como PNG RGB (R=brightness, G=normal_x, B=normal_y). Salva também `color_NNNN.jpg` (512px max, JPEG q=82) por frame para o bg pass animar lockstep.

Output structure:
```
media/shapes/<name>/
  manifest.json   { name, frames, dim, duration_seconds, color_frames: true, intensity_ranking, band_groups, mood_groups, classifications }
  normal_NNNN.png (×N, 700×700 RGB)
  color_NNNN.jpg  (×N, 512px JPEG)
  color.png       (frame representativo, fallback)
```

### 4. Script de classificação semântica (`scripts/classify_shape_anim.py`)
Python + google-genai. Envia cada `color_NNNN.jpg` ao Gemini Flash 2.5 com schema JSON:
```json
{ "intensity": 0-100, "band": "bass|mid|treble", "mood": "calm|active|peak" }
```
Reescreve `manifest.json` com `intensity_ranking[]` (frames ordenados dim→bright), `band_groups{bass,mid,treble}`, `mood_groups{calm,active,peak}`. Custo ≈ $0.012 por shape (96 frames). Thinking budget = 0 (não precisa raciocínio extenso).

### 5. Driver de animação com 3 modos (`shape_anim_mode` no YAML)

| Mode | Lógica |
|------|--------|
| `intensity` | `target_rank = (E + rawE*0.3) * (N-1)`. Frame index = `intensity_ranking[round(target_rank)]`. Loudness mapeia direto pra rank de intensidade visual classificada |
| `band_split` | Detecta banda dominante (bass/mid/treble) por energia smoothed por região FFT. Pega frame de `band_groups[active_band]`. Posição within-group dirigida pela amplitude da banda × `energy_gain*5`. Fallback inteligente quando band_group vazio: usa fatia correspondente do `intensity_ranking` (bass→1/3 inferior, mid→meio, treble→1/3 superior) |
| `pendulum` (legacy) | Spring physics: peak → velocidade injetada em direção alternada (L→R→L), spring puxa pra zero, damping. Para shapes não classificadas |

Easing comum (`shape_anim_baseline_speed`): `animTargetFloat += (target - animTargetFloat) * easeRate`. Default 0.04 (~400ms pra alcançar target).

### 6. Rest state (anti-frozen-frame)
Quando `E < 0.04 && rawE < 0.05` (silêncio total / transição de track / breakdown):
- `animTargetFloat *= 0.85`, `animDisplacement *= 0.85`, `animVelocity *= 0.5`
- `animFrameIndex = intensityRanking[0]` (frame mais dim) ou frame 0
- Aplicado a TODOS os modos. Sem isso, breakdowns no techno deixavam animação travada na última frame ativa.

### 7. Vídeos processados

`rotating-face`: vídeo Veo 1920×1080×8s. Tinha back-of-head e composições multi-face artefato. Reprocessado via ffmpeg: trim 6-8s + 0-2s + reverse + concat = ping-pong sem costas (right→front→left→front→right). 48 frames @ 12fps. Classificação: intensidade 10-55, 6 bass / 41 mid / 1 treble, 33 calm / 15 active / 0 peak.

`burning-R`: letra R em chamas B&W em fundo preto, 1920×1080×8s. Sem trim. 96 frames @ 12fps. Classificação: intensidade 50-85, 0 bass / 54 mid / 42 treble, 0 calm / 64 active / 32 peak.

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src/components/SpectrumBackground_V2.tsx` | Modificado | +loadAnimatedShape, +disposeAnimShape, +3 modos no draw loop, blending fix exoskeleton |
| `src-tauri/src/lib.rs` | Modificado | list_shapes detecta diretórios + 6 fields shape_anim_* + defaults |
| `src/tauri.ts` | Modificado | +6 fields no SpectrumVisualConfig |
| `scripts/build_shape_anim.mjs` | Criado | Node ESM + sharp, ~110 linhas |
| `scripts/classify_shape_anim.py` | Criado | Python + google-genai, ~140 linhas |
| `package.json` + `bun.lock` | Modificado | +sharp dev dep |
| `~/.local/share/rustify-player/spectrum/*.yaml` (cmr-auto) | Modificado | +6 params shape_anim_* em todos os 7 presets |
| `~/.local/share/rustify-player/media/shapes/rotating-face/` (cmr-auto) | Criado | 48 normal + 48 color + manifest classificado |
| `~/.local/share/rustify-player/media/shapes/burning-R/` (cmr-auto) | Criado | 96 normal + 96 color + manifest classificado |

## Commits desta sessao

Zero. Tudo no working tree (incluindo os edits do contexto/prompts da sessão anterior — `docs/contexto/10052026-sdf-fluid-peak-sync-tuning.md` e `docs/prompts/10052026-sdf-fluid-peak-sync-tuning.md`).

## Decisoes tomadas

- **Pre-gen offline em vez de runtime processing** | drawImage de `<video>`+ Sobel JS por frame é caro (readback GPU→CPU) e instável em WebKitGTK | Descartado: runtime video element direto
- **Node + sharp em vez de Python + Pillow** | Mantém algoritmo idêntico ao runtime JS (Sobel/dither/packing 1:1) | Descartado: Python — divergência sutil de blur algorithm
- **Color frame por frame (não 1 estático)** | bg pass usando colorTex estático criava "frame congelado" sobre wireframe animado. Domina visualmente | Descartado: skip bg pass — perde camada de profundidade
- **Ping-pong via ffmpeg pra rotating-face** | Vídeo original tinha back-of-head no meio. Trim 6-8s+0-2s + reverse evita costas e dá loop simétrico | Descartado: trim simples (gerava jump cut)
- **Gemini Flash 2.5 com thinking_budget=0** | Classificação visual simples não precisa reasoning extenso | Descartado: Pro — overkill, 30× mais caro
- **Intensity como default mode** | Modo mais semântico, "kick = frame mais brilhante" é intuitivo | band_split tem fallback de qualquer jeito
- **Rest state hardcoded threshold 0.04** | Empírico: cobre silêncio sem false-firing em passagens quietas | Não exposto via YAML por simplicidade — exponho se virar problema
- **Reuso de YAML knobs com significados context-dependentes** | Evita explosão de campos. `baseline_speed` = ease rate em intensity/band_split, spring stiffness em pendulum. `peak_decay` = spring damping. `energy_gain` = sensitivity multiplier | Descartado: 3× campos com nomes específicos por modo
- **Fallback de band_group vazio para intensity_ranking** | burning-R tem 0 frames "bass". Sem fallback, bass da música não animava | Descartado: requerer reclassificação com prompt mais permissivo

## Métricas

| Metrica | Valor |
|---------|-------|
| Releases publicadas nesta sessão | 7 |
| Frames gerados rotating-face | 48 (53MB) |
| Frames gerados burning-R | 96 (117MB) |
| Tempo de classificação Gemini | ~2min/96 frames |
| Custo estimado classificação | $0.012/shape |
| YAML params adicionados | 6 (shape_anim_*) |
| Linhas adicionadas SpectrumBackground_V2 | +~210 -~30 |

## Pendências identificadas

1. **Source video novo com full bass-mid-treble range** (alta) — usuário vai gerar. burning-R só tem mid/treble (0 bass), rotating-face só tem calm/active (0 peak). Para band_split funcionar visivelmente em toda faixa precisa fonte com gradiente natural (vulcão, tempestade, ink-in-water, plasma). Recomendações listadas na última resposta.

2. **Commit do trabalho** (alta) — working tree sujo com 7 arquivos modificados/criados. Precisa de commit antes de qualquer coisa. Sugestão: 2 commits (1 feat: pipeline animated shapes + driver modes; 2 chore: classify script).

3. **Mensagem do commit anterior `d41faae`** (baixa, herdada) — prosa de resumo em vez de Conventional Commits. Pode amend se quiser histórico limpo.

4. **`bass_attack_scale: 0.9` audit** (média, herdada) — usuário tuned, desconhecido se ainda afeta fluid ou é legacy V2.

5. **YAML hot-reload pra EQ** (média, herdada) — sessão anterior, ~1h dev.

6. **X600 EQ ear-test** (alta, herdada) — preset aprovado conceitualmente, ainda sem validação auditiva.

7. **Sidecar Qdrant defunct cosmético** (baixa, herdada) — `[qdrant] <defunct>` no `ps aux`. Inocuo.
