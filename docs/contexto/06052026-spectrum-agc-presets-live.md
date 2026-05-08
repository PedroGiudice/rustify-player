# Contexto: Spectrum AGC + Presets Live + Gravity Decay

**Data:** 2026-05-06
**Branch:** main (uncommitted: +1157 -323, 19 files)

---

## O que foi feito (continuacao de 05052026-spectrum-webgl2-config-live)

### 1. AGC (Automatic Gain Control) per-bin
Normaliza raw FFT bins pela media corrente antes de qualquer processamento. Logs confirmaram equalizacao: `bass=247 mid=254 high=246`. Parametros: `AGC_DECAY=0.985`, `AGC_FLOOR=3.0`.

### 2. Gravity decay (respiracao)
Substituido decay condicional por `smoothed[i] -= 1.5` incondicional por frame. Notas sustentadas oscilam (attack empurra, gravidade puxa). Silencio volta a zero em ~2.8s.

### 3. 6 presets YAML na cmr-auto
Balanced (default), Bass Heavy, Vocal Focus, Hi-Energy, Subtle, Trance. Dir: `~/.local/share/rustify-player/spectrum/`.

### 4. Preset picker no painel
Frontend-developer adicionou secao "Visual Preset" com chips no SpectrumRangesPanel. Persiste em localStorage. Prop `onConfigChange` propaga ao NowPlaying.

### 5. Tuning iterativo via hot-reload
Sessao inteira de tuning feito via `sed` remoto nos YAMLs — file watcher confirmado funcional (<2s).

## Estado dos arquivos (delta vs sessao anterior)

| Arquivo | Mudanca nesta sessao |
|---------|---------------------|
| `src/components/SpectrumBackground.tsx` | +AGC per-bin, +gravity decay 1.5/frame, LOG_BANDS 128→256 |
| `src/components/SpectrumRangesPanel.tsx` | +preset picker chips, +onConfigChange prop |
| `src/styles/components.css` | +spectrum-panel__section, +spectrum-panel__label |
| `src/views/NowPlaying.tsx` | +onConfigChange={setSpectrumConfig} ao painel |

## Decisoes

- **AGC antes do smoothing**: normalizar raw bins garante baseline justa; boosts no shader sao relativos
- **Gravity 1.5/frame (nao condicional)**: elimina pinning em notas sustentadas sem matar responsividade
- **compression_bass=compression_default**: com AGC, nao precisa de tratamento diferenciado por regiao
- **6 presets em vez de 2**: usuario quer variedade pra experimentar

## Pendencias

1. **Commit** (alta) — +1157 -323 lines uncommitted
2. **Config UI com sliders** (media) — presets trocam via chips mas nao ha sliders pra ajustar parametros individuais
3. **Geracao de shapes com IA** (media) — regras de descricao documentadas na conversa, nao implementado
4. **Shader cache removido** (baixa) — OES_get_program_binary foi removido na rewrite
