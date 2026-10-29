# mcp-bridge (cópia local com cadeado)

Fork de [`tauri-plugin-mcp-bridge`](https://crates.io/crates/tauri-plugin-mcp-bridge)
**0.11.1** (hypothesi, MIT; `LICENSE` ao lado), a ponte que o servidor MCP
`@hypothesi/tauri-mcp-server` e o `scripts/impeccable/app_eval.sh` usam para
executar JS, tirar foto e interagir com o app pelo WebSocket em
`127.0.0.1:9223`. Vendorizado em 29/10/2026 porque o upstream não tem ponto
de interceptação: o despacho de comandos e a contagem de conexões são funções
privadas de `src/websocket.rs`, e a decisão de produto do CEO (depois de uma
sessão de medição navegar o app enquanto ele o usava) foi que **o app só
obedece à ponte quando ele liga um interruptor, e mostra quando há alguém
conectado**.

## O que mudou em relação ao upstream

- `src/gate.rs` (novo): `BridgeGate` (interruptor + nº de clientes), nasce
  DESLIGADO e fica no estado do app (`app.manage`); `classify` decide o que
  passa desligado (só `invoke_tauri` + `get_backend_state`, a saúde/versão que
  o servidor MCP chama ao abrir sessão, respondida SEM dados da tela);
  `REFUSAL` = `ponte desligada no app; ligue em Tweaks > Controle remoto`;
  `set_enabled`/`status` para os comandos do app; evento
  `bridge-clients-changed` (`BridgeStatus {enabled, clients}`) ao front.
- `src/websocket.rs`: `dispatch_command` consulta o gate antes de qualquer
  handler (sem gate no estado = recusa, fechado por padrão); cada conexão
  conta um cliente (guarda que desconta ao cair) e anuncia o estado ao entrar
  e ao sair; `get_backend_state` ligado leva o campo `bridge`.
- `src/lib.rs`: monta o gate no `setup`; re-exporta `set_enabled`, `status`,
  `BridgeGate`, `BridgeStatus`, `CLIENTS_CHANGED_EVENT`, `REFUSAL`.
- `Cargo.toml`: só `rlib`, sem as dependências nativas de screenshot de
  macOS/Windows/iOS/Android (`src/screenshot/` ficou só com o Linux); `tauri`
  com a feature `test` em dev para o app de mentira dos testes.
- Mesmo nome de pacote: os identificadores `mcp-bridge:default` da capability e
  o prefixo `plugin:mcp-bridge|` dos comandos não mudam.

No app: `bridge_set_enabled`/`bridge_get_status` em `src-tauri/src/desktop.rs`;
interruptor `remoteBridge` em `src/store/tweaks.ts` (Tweaks > Controle
remoto); espelho e chip em `src/store/bridge.ts` e `src/components/Sidebar.tsx`.

## Atualizar o upstream

Copiar a versão nova de `~/.cargo/registry/src/*/tauri-plugin-mcp-bridge-<v>/`
por cima (`src/`, `permissions/`, `build.rs`), reaplicar os três pontos acima
(gate.rs entra inteiro; websocket.rs e lib.rs são diffs pequenos) e rodar
`cargo test -p tauri-plugin-mcp-bridge`: os testes `gate_tests` em
`websocket.rs` são o contrato do cadeado.

```bash
cargo test -p tauri-plugin-mcp-bridge --manifest-path src-tauri/Cargo.toml
```
