# Retomada: Spectrum — Pós-AGC, tuning e UI

## Contexto rapido

Spectrum WebGL2 com AGC per-bin funcionando e confirmado por logs (bass/mid/high equalizados ~240-254). 6 presets YAML com hot-reload via file watcher. Gravity decay 1.5/frame garante respiracao. Picker de presets no painel. Tuning iterativo feito ao vivo via SSH+sed nos YAMLs — hot-reload confirmado <2s.

## Arquivos principais

- `src/components/SpectrumBackground.tsx` — renderer (AGC + gravity + uniforms)
- `src/components/SpectrumRangesPanel.tsx` — painel com preset picker
- `src-tauri/src/lib.rs:614-780` — SpectrumVisualConfig + commands + file watcher
- `docs/contexto/06052026-spectrum-agc-presets-live.md` — contexto desta sessao

## Proximos passos

### 1. Commit das mudancas
**Onde:** git
**O que:** +1157 -323 lines, 19 files — PW capture + AGC + presets + hot-reload + picker
**Por que:** Nada commitado desde 294e77c
**Verificar:** `cargo check && npx vite build`

### 2. Config UI com sliders
**Onde:** `src/components/SpectrumRangesPanel.tsx`
**O que:** Sliders pra parametros individuais (attack, release, compression, multipliers, etc.) alem do preset picker
**Por que:** Usuario quer ajustar sem editar YAML manualmente

### 3. Geracao de shapes com IA
**Onde:** Scripts ou prompts pra Gemini/modelos locais
**O que:** Gerar imagens grayscale 120x150px. Regras: brightness=displacement, gradientes=direcao, sem preto puro
**Por que:** Shapes atuais sao manuais e limitadas

## Como verificar

```bash
cargo check --manifest-path src-tauri/Cargo.toml
npx vite build
./scripts/release.sh
# cmr-auto: testar preset picker no painel (icone engrenagem no Now Playing)
# cmr-auto: editar YAML em ~/.local/share/rustify-player/spectrum/ — deve hot-reload
```

<session_metadata>
branch: main
last_commit: 294e77c (uncommitted +1157 -323)
agc: confirmed working (bass≈mid≈high ~240-254)
hot_reload: confirmed working (<2s)
presets: 6 (Balanced, Bass Heavy, Vocal Focus, Hi-Energy, Subtle, Trance)
gravity_decay: 1.5/frame unconditional
</session_metadata>
