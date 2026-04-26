# Contexto: MCP Bridge + Limpeza EasyEffects

**Data:** 2026-04-26
**Sessao:** main (direto)
**Duracao:** ~1h

---

## O que foi feito

### 1. Adicionado tauri-plugin-mcp-bridge para inspecao remota

Plugin MCP Bridge (WebSocket, porta 9223) registrado no app para que o Claude na VM
Contabo possa inspecionar remotamente o app rodando na cmr-auto — DOM snapshots,
screenshots, cliques, console — sem intervencion do usuario.

Bind address restrito ao IP Tailscale da cmr-auto (`100.102.249.9`) para garantir
que o WebSocket so e acessivel dentro da tailnet.

Registrado SEM `#[cfg(debug_assertions)]` porque todos os releases sao `--release`.

### 2. Adicionado tauri-plugin-dialog

Necessario para o sistema de presets da Signal view (import/export de arquivos
EasyEffects via `dialog.open()` / `dialog.save()`). Registrado junto com o MCP Bridge.

### 3. Removido modulo easyeffects.rs e comandos IPC associados

O antigo sistema de presets EasyEffects (via CLI `easyeffects --load-preset`) foi
removido. Substituido pelo sistema DSP nativo (dsp.rs) com import/export direto
de JSONs EasyEffects.

Removidos: `easyeffects.rs`, commands `ee_list_presets`, `ee_get_current_preset`,
`ee_apply_preset`, e a secao EasyEffects da settings view.

### 4. Expandidas permissoes de filesystem

- `fs:allow-read` agora inclui `$HOME/.config/easyeffects/**` (leitura de presets)
- `fs:allow-write` adicionado para `$HOME/**` (exportar presets)

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src-tauri/Cargo.toml` | Modificado | +tauri-plugin-dialog, +tauri-plugin-mcp-bridge |
| `src-tauri/Cargo.lock` | Modificado | Lock atualizado |
| `src-tauri/src/lib.rs` | Modificado | +plugins dialog/mcp-bridge, -mod easyeffects, -3 ee_* commands |
| `src-tauri/src/easyeffects.rs` | Deletado | Modulo inteiro removido |
| `src-tauri/capabilities/default.json` | Modificado | +dialog:default, +mcp-bridge:default, +fs:allow-write, +easyeffects read path |
| `src/js/views/settings.js` | Modificado | Removida secao EasyEffects e funcao hydrateEEPresets |

## Commits desta sessao

Nenhum commit feito nesta sessao. Mudancas sao todas unstaged/untracked.

## Decisoes tomadas

- **Bind ao IP Tailscale, nao 0.0.0.0**: Garante que o WebSocket MCP so e acessivel via tailnet. Alternativa descartada: bind em localhost + Tailscale Serve — nao aplica (WebSocket, nao HTTP).
- **Sem debug gate**: `#[cfg(debug_assertions)]` descartado — releases sao sempre `--release`, gate impediria uso em producao.
- **Remover easyeffects.rs**: O sistema DSP nativo (dsp.rs com 19 IPC commands) substitui completamente o wrapper CLI do EasyEffects. Manter os dois geraria confusao.

## Pendencias identificadas

1. **Commit e release das mudancas** (alta) — Mudancas nao commitadas. Compilar e rodar `release.sh` para gerar .deb.
2. **Conectar via MCP Bridge** (alta) — Apos instalar .deb na cmr-auto, conectar com `mcp__tauri__driver_session(action: "start", host: "100.102.249.9", port: 9223)`. MCP server do Tauri desconectou durante a sessao; precisa reiniciar sessao Claude Code.
3. **Signal view: botoes nao funcionando** (alta) — Usuario reportou que botoes da Signal view nao respondem. Diagnosticar via MCP Bridge apos conexao.
4. **Sistema de presets** (media) — Implementar save/load/import/export de presets DSP conforme plano em `.claude/plans/`.
