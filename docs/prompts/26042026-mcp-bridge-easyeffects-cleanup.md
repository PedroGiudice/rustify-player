# Retomada: MCP Bridge + Signal View Debug

## Contexto rapido

Adicionamos o plugin `tauri-plugin-mcp-bridge` ao Rustify Player para permitir
inspecao remota do app (DOM, screenshots, cliques) pela VM Contabo via Tailscale.
O WebSocket roda na porta 9223, bind exclusivo ao IP Tailscale da cmr-auto
(`100.102.249.9`). Tambem adicionamos `tauri-plugin-dialog` para import/export
de presets, e removemos o antigo modulo `easyeffects.rs` (substituido pelo DSP nativo).

As mudancas estao **nao commitadas**. Precisam de commit, build e release antes de testar.

## Arquivos principais

- `src-tauri/src/lib.rs` — registro dos plugins MCP Bridge e Dialog, remocao dos ee_* commands
- `src-tauri/Cargo.toml` — dependencias adicionadas
- `src-tauri/capabilities/default.json` — permissoes MCP Bridge, Dialog, fs expandido
- `src/js/views/signal.js` — view DSP (EQ, Limiter, Bass Enhancer)
- `src-tauri/src/dsp.rs` — backend DSP com 19 IPC commands
- `docs/contexto/26042026-mcp-bridge-easyeffects-cleanup.md` — contexto detalhado

## Proximos passos (por prioridade)

### 1. Commitar, compilar e release

**Onde:** root do projeto
**O que:** `git add` dos arquivos modificados, commit, `./scripts/release.sh`
**Por que:** Mudancas nao commitadas impedem tudo — release gera .deb para cmr-auto
**Verificar:**
```bash
cargo check --manifest-path src-tauri/Cargo.toml
./scripts/release.sh
```

### 2. Instalar na cmr-auto e conectar via MCP Bridge

**Onde:** cmr-auto (PC Linux)
**O que:** Instalar .deb, abrir app, conectar com driver_session
**Por que:** MCP Bridge permite diagnostico remoto sem screenshots manuais
**Verificar:**
```bash
# Na cmr-auto:
gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber
sudo dpkg -i /tmp/rustify-player_0.1.0_amd64.deb

# No Claude Code:
# mcp__tauri__driver_session(action: "start", host: "100.102.249.9", port: 9223)
```

### 3. Diagnosticar botoes da Signal view

**Onde:** `src/js/views/signal.js`
**O que:** Usuario reportou que botoes nao funcionam. Usar MCP Bridge para inspecionar DOM, event listeners, console errors
**Por que:** Signal view e o frontend principal do DSP — precisa funcionar
**Verificar:** Clicar nos botoes via MCP Bridge e verificar se IPC commands sao disparados

### 4. Implementar sistema de presets DSP

**Onde:** `src/js/views/signal.js` (frontend) — plano em `.claude/plans/`
**O que:** Save/load presets em localStorage, import/export de JSONs EasyEffects via `dialog.open()`/`dialog.save()`
**Por que:** Usuarios precisam salvar e compartilhar configuracoes DSP
**Verificar:** Salvar preset, recarregar app, preset persiste; importar JSON EasyEffects

## Como verificar

```bash
# Compilacao
cargo check --manifest-path src-tauri/Cargo.toml

# Release
./scripts/release.sh

# Conexao MCP (apos instalar na cmr-auto)
# mcp__tauri__driver_session(action: "start", host: "100.102.249.9", port: 9223)
# mcp__tauri__webview_screenshot()
```

<session_metadata>
branch: main
last_commit: a554919 (fix(dsp): use bool for Calf Bass Enhancer bypass property)
uncommitted_changes: 6 files (MCP Bridge + dialog plugin + easyeffects removal)
mcp_bridge_port: 9223
mcp_bridge_bind: 100.102.249.9
</session_metadata>
