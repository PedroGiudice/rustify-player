//! Cadeado da ponte (Rustify Player).
//!
//! A ponte aceita qualquer cliente que chegue à porta local (túnel SSH
//! incluído) e executa JS/IPC arbitrário no app. Incidente de 29/10/2026:
//! uma sessão de medição trocou de tela, abriu o Tweaks e mudou a cena do
//! fundo enquanto o CEO usava o app. Decisão de produto: o app só obedece
//! à ponte quando o dono liga o interruptor (Tweaks > Controle remoto),
//! e mostra quando há alguém conectado.
//!
//! O `BridgeGate` nasce DESLIGADO e fica no estado do app (`app.manage`);
//! o despacho do WebSocket (`websocket::dispatch_command`) consulta-o a
//! cada comando. Sem gate no estado, o despacho recusa (fechado por
//! padrão). Desligada, a ponte continua aceitando a conexão e respondendo
//! a saúde/versão (`invoke_tauri` + `get_backend_state`, o que o servidor
//! MCP do hypothesi chama ao abrir sessão) com um payload SEM dados da
//! tela, para o cliente ler um erro claro em vez de ficar pendurado.

use serde::Serialize;
use serde_json::Value;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use tauri::{AppHandle, Emitter, Manager, Runtime};

/// Mensagem que o cliente recebe em todo comando recusado.
pub const REFUSAL: &str = "ponte desligada no app; ligue em Tweaks > Controle remoto";

/// Evento Tauri emitido ao front quando o interruptor muda ou um cliente
/// entra/sai. Payload: [`BridgeStatus`].
pub const CLIENTS_CHANGED_EVENT: &str = "bridge-clients-changed";

/// Interruptor + contagem de clientes conectados ao WebSocket.
#[derive(Debug, Default)]
pub struct BridgeGate {
    enabled: AtomicBool,
    clients: AtomicUsize,
}

/// Estado da ponte como o front o vê. `Default` = fechado (desligada, 0).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize)]
pub struct BridgeStatus {
    pub enabled: bool,
    pub clients: usize,
}

impl BridgeGate {
    pub fn is_enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    /// Liga ou desliga. Devolve `true` se o valor mudou.
    pub fn set_enabled(&self, enabled: bool) -> bool {
        self.enabled.swap(enabled, Ordering::AcqRel) != enabled
    }

    pub fn clients(&self) -> usize {
        self.clients.load(Ordering::Acquire)
    }

    pub fn status(&self) -> BridgeStatus {
        BridgeStatus {
            enabled: self.is_enabled(),
            clients: self.clients(),
        }
    }

    /// Registra um cliente conectado; a guarda devolvida desconta ao cair
    /// (qualquer caminho de saída da conexão, inclusive pânico da task).
    pub fn client_connected(&self) -> ClientGuard<'_> {
        self.clients.fetch_add(1, Ordering::AcqRel);
        ClientGuard { gate: self }
    }
}

/// Guarda de uma conexão viva (ver [`BridgeGate::client_connected`]).
pub struct ClientGuard<'a> {
    gate: &'a BridgeGate,
}

impl Drop for ClientGuard<'_> {
    fn drop(&mut self) {
        self.gate.clients.fetch_sub(1, Ordering::AcqRel);
    }
}

/// Política com a ponte DESLIGADA para um comando do WebSocket.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OffPolicy {
    /// Saúde/versão: respondida sempre, sem dados da tela.
    Health,
    /// Tudo o que lê ou altera a interface e o estado: recusado.
    Refuse,
}

/// Classifica um comando do WebSocket (`{"command": ..., "args": ...}`).
pub fn classify(command: &Value) -> OffPolicy {
    let name = command.get("command").and_then(Value::as_str).unwrap_or("");
    let inner = command
        .get("args")
        .and_then(|a| a.get("command"))
        .and_then(Value::as_str)
        .unwrap_or("");
    if name == "invoke_tauri" && inner == "plugin:mcp-bridge|get_backend_state" {
        OffPolicy::Health
    } else {
        OffPolicy::Refuse
    }
}

/// O canal de broadcast (eventos do seletor de elemento, `__element_picked`
/// / `__element_pointed`, com seletor e metadados do DOM) só chega aos
/// clientes com a ponte ligada. Sem gate = fechado.
pub fn broadcast_allowed(status: Option<BridgeStatus>) -> bool {
    status.map(|s| s.enabled).unwrap_or(false)
}

/// Resposta de erro padrão do WebSocket com a mensagem do cadeado.
pub fn refusal(id: &str) -> Value {
    serde_json::json!({
        "id": id,
        "success": false,
        "error": REFUSAL
    })
}

/// Identidade do app e da ponte, sem nada da tela: o que a ponte entrega
/// com o interruptor desligado.
pub fn health<R: Runtime>(app: &AppHandle<R>, status: BridgeStatus) -> Value {
    let config = app.config();
    serde_json::json!({
        "app": {
            "name": config.product_name.clone().unwrap_or_else(|| "Unknown".to_string()),
            "identifier": config.identifier.clone(),
            "version": config.version.clone().unwrap_or_else(|| "0.0.0".to_string()),
        },
        "tauri": { "version": tauri::VERSION },
        "environment": {
            "debug": cfg!(debug_assertions),
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
            "family": std::env::consts::FAMILY,
        },
        "bridge": bridge_field(status),
        "timestamp": crate::monitor::current_timestamp(),
    })
}

/// Campo `bridge` que acompanha o `get_backend_state` nos dois estados.
/// Desligada, não diz a quem está de fora quantos clientes há: só o
/// interruptor, a versão e a mensagem.
pub fn bridge_field(status: BridgeStatus) -> Value {
    let mut v = serde_json::json!({
        "enabled": status.enabled,
        "pluginVersion": env!("CARGO_PKG_VERSION"),
    });
    if status.enabled {
        v["clients"] = Value::from(status.clients);
    } else {
        v["message"] = Value::String(REFUSAL.to_string());
    }
    v
}

/// Lê o estado da ponte. `None` quando o plugin não foi montado.
pub fn status<R: Runtime>(app: &AppHandle<R>) -> Option<BridgeStatus> {
    app.try_state::<BridgeGate>().map(|g| g.status())
}

/// Liga/desliga a ponte e avisa o front (evento [`CLIENTS_CHANGED_EVENT`])
/// quando o valor muda. Desligar também DESARMA o que uma sessão ligada
/// deixou armado (ver [`disarm`]). `None` quando o plugin não foi montado.
pub fn set_enabled<R: Runtime>(app: &AppHandle<R>, enabled: bool) -> Option<BridgeStatus> {
    let gate = app.try_state::<BridgeGate>()?;
    if gate.set_enabled(enabled) {
        if !enabled {
            disarm(app);
        }
        announce(app);
    }
    Some(gate.status())
}

/// Emite o estado atual ao front (evento [`CLIENTS_CHANGED_EVENT`]). Sem
/// gate no estado não há o que anunciar.
pub(crate) fn announce<R: Runtime>(app: &AppHandle<R>) {
    let Some(status) = status(app) else { return };
    if let Err(e) = app.emit(CLIENTS_CHANGED_EVENT, status) {
        crate::logging::mcp_log_error("GATE", &format!("evento {CLIENTS_CHANGED_EVENT}: {e}"));
    }
}

/// O que uma sessão LIGADA pode deixar armado e sobreviveria ao Off:
/// scripts registrados (o `bridge.js` os reinjeta a cada carga de página
/// por `request_script_injection`, IPC do próprio webview, fora do
/// despacho) e o monitor de IPC. Esvazia o registro, tira os scripts do
/// DOM e para o monitor; cada passo é independente e tolera a janela
/// ausente (testes com o app de mentira).
fn disarm<R: Runtime>(app: &AppHandle<R>) {
    if let Some(registry) = app.try_state::<crate::script_registry::SharedScriptRegistry>() {
        let n = match registry.lock() {
            Ok(mut reg) => {
                let n = reg.len();
                reg.clear();
                n
            }
            Err(poisoned) => {
                let mut reg = poisoned.into_inner();
                let n = reg.len();
                reg.clear();
                n
            }
        };
        if n > 0 {
            crate::logging::mcp_log_info("GATE", &format!("ponte desligada: {n} script(s) registrado(s) removido(s)"));
        }
        if let Err(e) = crate::websocket::clear_scripts_from_webview(app, None) {
            crate::logging::mcp_log_info("GATE", &format!("scripts no DOM não limpos: {e}"));
        }
    }
    if let Some(monitor) = app.try_state::<crate::monitor::IPCMonitorState>() {
        if let Some(window) = app.webview_windows().values().next() {
            let _ = window.eval("window.__MCP_STOP_IPC_MONITOR__ && window.__MCP_STOP_IPC_MONITOR__();");
        }
        match monitor.lock() {
            Ok(mut mon) => mon.stop(),
            Err(poisoned) => poisoned.into_inner().stop(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nasce_desligado_e_sem_clientes() {
        let g = BridgeGate::default();
        assert_eq!(g.status(), BridgeStatus { enabled: false, clients: 0 });
    }

    #[test]
    fn set_enabled_diz_se_mudou() {
        let g = BridgeGate::default();
        assert!(g.set_enabled(true));
        assert!(!g.set_enabled(true));
        assert!(g.set_enabled(false));
    }

    #[test]
    fn guarda_conta_e_desconta_clientes() {
        let g = BridgeGate::default();
        let a = g.client_connected();
        let b = g.client_connected();
        assert_eq!(g.clients(), 2);
        drop(a);
        assert_eq!(g.clients(), 1);
        drop(b);
        assert_eq!(g.clients(), 0);
    }

    #[test]
    fn so_get_backend_state_por_invoke_tauri_e_saude() {
        let health = serde_json::json!({"command":"invoke_tauri","args":{"command":"plugin:mcp-bridge|get_backend_state"}});
        assert_eq!(classify(&health), OffPolicy::Health);
        for gated in [
            serde_json::json!({"command":"execute_js","args":{"script":"1"}}),
            serde_json::json!({"command":"invoke_tauri","args":{"command":"plugin:mcp-bridge|get_window_info"}}),
            serde_json::json!({"command":"get_backend_state"}),
            serde_json::json!({"command":"list_windows"}),
            serde_json::json!({}),
        ] {
            assert_eq!(classify(&gated), OffPolicy::Refuse, "{gated}");
        }
    }

    #[test]
    fn campo_bridge_leva_a_mensagem_so_quando_desligada_e_nao_conta_clientes() {
        let off = bridge_field(BridgeStatus { enabled: false, clients: 1 });
        assert_eq!(off["message"], REFUSAL);
        assert!(off.get("clients").is_none(), "desligada não diz a quem está de fora quantos estão conectados");
        let on = bridge_field(BridgeStatus { enabled: true, clients: 2 });
        assert!(on.get("message").is_none());
        assert_eq!(on["enabled"], true);
        assert_eq!(on["clients"], 2);
    }

    #[test]
    fn status_padrao_e_fechado() {
        assert_eq!(BridgeStatus::default(), BridgeStatus { enabled: false, clients: 0 });
    }
}
