# Retomada: Spectrum WebGL2 — Diagnóstico AGC + Config UI

## Contexto rapido

O spectrum visualizer WebGL2 do Rustify Player foi reescrito nesta sessao. Pipeline: PipeWire monitor capture → rustfft 2048pt → 1024 bins → AGC normalize per-bin → 256 log bands → smoothing → textura GPU → shader com 18 uniforms tunáveis. Sistema de presets YAML com hot-reload (file watcher via notify crate) implementado e funcional. O usuario confirmou que a visualizacao melhorou muito, mas mids/highs (vocais, hi-hats) ainda sao sub-representados.

Na ultima iteracao, implementei AGC (Automatic Gain Control) per-bin que normaliza todas as frequencias para a mesma baseline antes do smoothing. O build com AGC esta publicado mas **nao foi testado pelo usuario**. Logs de diagnostico foram adicionados.

## Arquivos principais

- `src/components/SpectrumBackground.tsx` — renderer WebGL2 (AGC + smoothing + uniforms)
- `src-tauri/src/lib.rs:614-780` — SpectrumVisualConfig struct + 4 Tauri commands + file watcher
- `src-tauri/crates/audio-engine/src/output/pw_capture.rs` — PipeWire capture + FFT 2048pt
- `src/tauri.ts:218-255` — IPC bindings pra spectrum presets
- `src/views/NowPlaying.tsx` — carrega preset + file watcher + passa config ao renderer
- `docs/contexto/05052026-spectrum-webgl2-config-live.md` — contexto completo
- `~/.claude/plans/generic-skipping-wirth.md` — plano de config live (tasks 1-4 done)

## Proximos passos (por prioridade)

### 1. Diagnosticar AGC e mids/highs
**Onde:** Console do DevTools do app (F12)
**O que:** Verificar os logs `[spectrum] #N bass=X mid=X high=X air=X`. Se mid/high estao comparaveis ao bass, o AGC funciona e o problema e visual (shader compression/multipliers). Se mid/high sao 0 ou muito baixos, o AGC nao esta normalizando — investigar `AGC_FLOOR`, `AGC_DECAY`, ou o log binning.
**Por que:** Bloqueador — sem saber se os dados existem, nao da pra ajustar o visual.
**Verificar:** Valores esperados: bass ~100-200, mid ~80-150, high ~50-120 durante musica com vocais.

### 2. Ajustar shader se AGC confirmado
**Onde:** `src/components/SpectrumBackground.tsx`, vertex shader (VERT_SRC)
**O que:** Se dados existem mas visual nao reage, revisar a curva de compression por regiao. A logica atual usa `smoothstep(0.2, 0.8, regionT)` pra interpolar compressao — pode estar muito suave. Testar com `u_compDefault * 0.5` pra regioes altas (mais boost).
**Por que:** O shader e o ultimo elo — se os dados chegam normalizados e o shader nao amplifica suficiente, mids ficam invisiveis.
**Verificar:** Editar `~/.local/share/rustify-player/spectrum/default.yaml`, mudar `compression_default: 0.4` — hot-reload deve mostrar efeito em <2s.

### 3. Implementar UI de configuracao do spectrum
**Onde:** `src/components/SpectrumRangesPanel.tsx` (expandir)
**O que:** Seção "Visual" com sliders para: density (lines x points), bass_multiplier, compression_bass, compression_default, hue_spread, saturation, alphas, lightness. Dropdown pra selecionar preset YAML. Botao "Save as...".
**Por que:** Usuario quer "total liberdade, fuck around for real". Hot-reload YAML funciona mas sliders sao mais intuitivos.
**Verificar:** Mover slider → visualizer muda em tempo real.

### 4. Gerar shapes melhores com modelos generativos
**Onde:** Scripts separados ou Gemini/local LLM
**O que:** Gerar imagens grayscale 120x150px seguindo as regras documentadas na conversa: brightness = displacement magnitude, gradientes = direcao, sem preto puro nas bordas.
**Por que:** As shapes atuais foram feitas manualmente. O usuario quer experimentar com variedade.
**Verificar:** Copiar PNG pra `~/.local/share/rustify-player/media/shapes/`, trocar shape na UI.

## Como verificar

```bash
# Build e publicar
cargo check --manifest-path src-tauri/Cargo.toml
npx vite build
./scripts/release.sh

# Instalar na cmr-auto
gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber && sudo dpkg -i /tmp/rustify-player_0.2.1_amd64.deb

# Verificar AGC (no DevTools do app)
# Logs: [spectrum] #N bass=X mid=X high=X air=X

# Testar hot-reload (na cmr-auto)
nano ~/.local/share/rustify-player/spectrum/default.yaml
# Mudar bass_multiplier de 1.6 pra 2.5, salvar — visualizer deve reagir em <2s
```

<session_metadata>
branch: main
last_commit: 294e77c (uncommitted: +1086 -307 lines)
agc_status: implemented, not user-tested
blocker: verify AGC normalizes mids/highs to comparable levels
pipeline: PW capture → FFT 2048 → AGC per-bin → 256 log bands → smoothing → WebGL2
hot_reload: working via notify crate file watcher
presets_dir: ~/.local/share/rustify-player/spectrum/
shapes_dir: ~/.local/share/rustify-player/media/shapes/
</session_metadata>
