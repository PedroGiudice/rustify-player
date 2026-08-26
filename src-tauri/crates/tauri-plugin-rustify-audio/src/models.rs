use serde::{Deserialize, Serialize};

/// Item da fila nativa. `track_id` e **String** em toda a cadeia: os ids do
/// acervo sao u64 hash-based e valores acima de 2^53 se corrompem em JS.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueItem {
    pub track_id: String,
    /// URI tocavel pelo ExoPlayer (`file://`, `content://`, `http(s)://`).
    pub uri: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub artist: String,
    #[serde(default)]
    pub album: String,
    #[serde(default)]
    pub artwork_uri: Option<String>,
    #[serde(default)]
    pub duration_ms: i64,
    /// Override de origem POR ITEM; `None` herda a da fila. Existe para que a
    /// faixa enfileirada a mao dentro de uma station nao seja registrada como
    /// escuta passiva no sinal v3.
    #[serde(default)]
    pub origin: Option<String>,
    #[serde(default)]
    pub context_id: Option<String>,
}

/// Onde os itens entram na fila viva. O indice concreto e resolvido no Kotlin
/// contra o player — o JS nunca calcula posicao de fila (ela avanca sozinha).
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AddMode {
    /// Logo depois da faixa corrente.
    Next,
    /// Fim da fila.
    End,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddItemsRequest {
    pub items: Vec<QueueItem>,
    pub origin: String,
    #[serde(default)]
    pub context_id: Option<String>,
    pub mode: AddMode,
    /// Retoma se a fila ja tinha acabado. E o que faz o autoplay funcionar:
    /// anexar em `STATE_ENDED` nao volta a tocar sozinho.
    #[serde(default)]
    pub resume_if_ended: bool,
}

/// Substitui a fila inteira do player. `origin`/`context_id` sao carimbados em
/// cada evento gerado por essa fila (mesma semantica do desktop).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetQueueRequest {
    pub items: Vec<QueueItem>,
    #[serde(default)]
    pub start_index: u32,
    pub origin: String,
    #[serde(default)]
    pub context_id: Option<String>,
    #[serde(default = "default_true")]
    pub play_now: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SeekToRequest {
    pub position_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkipToIndexRequest {
    pub index: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainEventsRequest {
    /// Retorna apenas eventos com `seq` estritamente maior que este valor.
    pub after_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AckEventsRequest {
    /// Marca d'agua de consumo; o journal e compactado ate ela.
    pub upto_seq: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlaybackState {
    /// `idle` | `buffering` | `ready` | `ended`
    pub status: String,
    /// Indice na fila; `-1` quando nao ha fila.
    pub index: i32,
    #[serde(default)]
    pub track_id: Option<String>,
    pub position_ms: i64,
    pub duration_ms: i64,
    pub is_playing: bool,
    /// Itens na fila nativa. E o gatilho do tender de continuidade: da para
    /// saber que a fila esta secando sem ler a fila inteira a cada ciclo.
    #[serde(default)]
    pub count: i32,
    /// `off` | `one` | `all`. Com repeat ligado a fila nunca "seca" — o tender
    /// nao pode injetar autoplay por cima de um loop deliberado do usuario.
    #[serde(default = "default_repeat_mode")]
    pub repeat_mode: String,
}

fn default_repeat_mode() -> String {
    "off".into()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TruncateQueueRequest {
    /// Corta daqui ate o fim. O Kotlin nunca corta abaixo da faixa corrente.
    pub from_index: u32,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum RepeatMode {
    Off,
    One,
    All,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepeatModeRequest {
    pub mode: RepeatMode,
}

/// Item da fila NATIVA, do jeito que o servico a enxerga. `origin`/`context_id`
/// sao por ITEM — o wire ja nasce assim para nao mudar quando o enfileirar
/// avulso chegar (hoje o Kotlin devolve o escalar da fila para todos).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueEntry {
    pub track_id: String,
    pub origin: String,
    #[serde(default)]
    pub context_id: Option<String>,
    #[serde(default)]
    pub duration_ms: i64,
}

/// Resposta de `get_queue` — a unica leitura da fila real do player.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueueSnapshot {
    pub items: Vec<QueueEntry>,
    /// Indice corrente; `-1` quando a fila esta vazia.
    pub index: i32,
}

/// Resultado de `next`/`previous`. `moved = false` significa que a fila acabou
/// (ou comecou) — sem isso o botao vira no-op mudo na interface.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StepResult {
    pub moved: bool,
}

/// Linha do journal. Os campos sao **snake_case de proposito**: o schema espelha
/// o payload de `play_events` do desktop (qdrant_client.rs), nao a convencao
/// camelCase dos argumentos de command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlayEvent {
    pub seq: i64,
    pub uuid: String,
    /// `track_ended` | `track_skipped`
    pub event_type: String,
    pub track_id: String,
    pub origin: String,
    #[serde(default)]
    pub context_id: Option<String>,
    pub started_at: i64,
    pub timestamp: i64,
    pub end_position_ms: i64,
    pub duration_ms: i64,
    /// Pulo PARA TRAS (replay). Ausente na esmagadora maioria das linhas — o
    /// Kotlin so grava quando true, e linhas antigas nao tem o campo.
    #[serde(default)]
    pub backward: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrainEventsResponse {
    pub events: Vec<PlayEvent>,
    /// Maior `seq` ja gravado (mesmo que nenhum evento tenha sido devolvido).
    pub last_seq: i64,
}

/// Pedido de `updater_check`. `manifest_url` só existe para teste; `None`
/// usa a URL fixa do release `dev` (definida no Kotlin).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterCheckRequest {
    #[serde(default)]
    pub manifest_url: Option<String>,
}

/// Resposta de `updater_check`. A decisão `available` é do Kotlin (comparação
/// semver contra o `versionName` instalado) — fonte única.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCheck {
    pub installed: String,
    pub latest: String,
    pub available: bool,
    #[serde(default)]
    pub apk_url: Option<String>,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub size: i64,
    /// `canRequestPackageInstalls()` — false até o usuário liberar "instalar
    /// apps desconhecidos" para o app (toggle único por install).
    pub can_install: bool,
}

/// Pedido de `updater_install`. `sha256`/`size` vêm do manifest; ausentes,
/// o Kotlin pula a verificação correspondente.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterInstallRequest {
    pub url: String,
    #[serde(default)]
    pub sha256: Option<String>,
    #[serde(default)]
    pub size: i64,
}

/// `started` (download em andamento; progresso pelo evento `updater_progress`),
/// `needs_permission` (abriu a tela do sistema; o JS re-tenta depois) ou
/// `busy` (já havia um download rodando).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdaterInstallResult {
    pub status: String,
}

/// Payload vazio. O lado Kotlin recebe `{}` — nunca `null`, que quebraria um
/// eventual `invoke.getArgs()`.
#[cfg(target_os = "android")]
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub(crate) struct EmptyArgs {}

#[cfg(test)]
mod tests {
    use super::*;

    /// O wire do Kotlin e camelCase; o Rust e snake_case. Uma renomeacao
    /// silenciosa aqui so apareceria como "fila vazia" no aparelho — este teste
    /// e o que evita descobrir isso depois de um ciclo de build+install.
    #[test]
    fn queue_snapshot_le_o_wire_exato_do_kotlin() {
        let wire = r#"{
            "items": [
                {"trackId": "18446744073709551615", "origin": "station",
                 "contextId": "chill-romance", "durationMs": 214000}
            ],
            "index": 3
        }"#;
        let snap: QueueSnapshot = serde_json::from_str(wire).unwrap();
        assert_eq!(snap.index, 3);
        assert_eq!(snap.items.len(), 1);
        // u64::MAX passa intacto porque trafega como String em toda a cadeia.
        assert_eq!(snap.items[0].track_id, "18446744073709551615");
        assert_eq!(snap.items[0].origin, "station");
        assert_eq!(snap.items[0].context_id.as_deref(), Some("chill-romance"));
        assert_eq!(snap.items[0].duration_ms, 214_000);
    }

    #[test]
    fn queue_entry_tolera_context_id_nulo_e_duracao_ausente() {
        let wire = r#"{"trackId": "7", "origin": "manual", "contextId": null}"#;
        let entry: QueueEntry = serde_json::from_str(wire).unwrap();
        assert_eq!(entry.context_id, None);
        assert_eq!(entry.duration_ms, 0);
    }

    #[test]
    fn queue_snapshot_vazio_tem_indice_negativo() {
        let snap: QueueSnapshot = serde_json::from_str(r#"{"items": [], "index": -1}"#).unwrap();
        assert!(snap.items.is_empty());
        assert_eq!(snap.index, -1);
    }

    /// O modo viaja como string minúscula ("next"/"end") — o Kotlin compara
    /// com `args.mode == "next"`. Um rename aqui viraria "enfileirou no fim
    /// quando pediu em seguida", que é silencioso.
    #[test]
    fn add_mode_serializa_minusculo() {
        assert_eq!(serde_json::to_string(&AddMode::Next).unwrap(), "\"next\"");
        assert_eq!(serde_json::to_string(&AddMode::End).unwrap(), "\"end\"");
        let m: AddMode = serde_json::from_str("\"next\"").unwrap();
        assert_eq!(m, AddMode::Next);
    }

    #[test]
    fn add_items_request_carrega_origem_por_item() {
        let req = AddItemsRequest {
            items: vec![QueueItem {
                track_id: "9".into(),
                uri: "file:///m/a.opus".into(),
                title: "a".into(),
                artist: String::new(),
                album: String::new(),
                artwork_uri: None,
                duration_ms: 1000,
                origin: Some("manual".into()),
                context_id: None,
            }],
            origin: "manual".into(),
            context_id: None,
            mode: AddMode::Next,
            resume_if_ended: false,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"mode\":\"next\""), "{json}");
        assert!(json.contains("\"origin\":\"manual\""), "{json}");
        assert!(json.contains("\"contextId\":null"), "{json}");
    }

    /// Fila montada por set_queue não manda origem por item — o parser precisa
    /// aceitar a ausência, senão todo caller antigo quebra.
    #[test]
    fn queue_item_sem_origem_por_item_continua_valido() {
        let wire = r#"{"trackId":"1","uri":"file:///a","durationMs":10}"#;
        let item: QueueItem = serde_json::from_str(wire).unwrap();
        assert_eq!(item.origin, None);
        assert_eq!(item.context_id, None);
    }

    #[test]
    fn step_result_le_moved() {
        let step: StepResult = serde_json::from_str(r#"{"moved": false}"#).unwrap();
        assert!(!step.moved);
    }

    /// Serializa de volta com as MESMAS chaves — o contrato vale nas duas
    /// direcoes (o snapshot tambem viaja pro JS).
    #[test]
    fn queue_snapshot_serializa_em_camel_case() {
        let snap = QueueSnapshot {
            items: vec![QueueEntry {
                track_id: "42".into(),
                origin: "manual".into(),
                context_id: None,
                duration_ms: 1000,
            }],
            index: 0,
        };
        let json = serde_json::to_string(&snap).unwrap();
        assert!(json.contains("\"trackId\":\"42\""), "{json}");
        assert!(json.contains("\"durationMs\":1000"), "{json}");
        assert!(json.contains("\"contextId\":null"), "{json}");
    }

    /// Wire do Kotlin para `updater_check`. `sha256` pode vir `null` (manifest
    /// antigo) e `size` ausente — o parser não pode quebrar por isso.
    #[test]
    fn update_check_le_o_wire_do_kotlin() {
        let wire = r#"{"installed":"0.2.75","latest":"0.2.76","available":true,
            "apkUrl":"https://github.com/PedroGiudice/rustify-player/releases/download/dev/rustify-player_0.2.76.apk",
            "sha256":null,"canInstall":false}"#;
        let c: UpdateCheck = serde_json::from_str(wire).unwrap();
        assert_eq!(c.installed, "0.2.75");
        assert_eq!(c.latest, "0.2.76");
        assert!(c.available);
        assert_eq!(c.sha256, None);
        assert_eq!(c.size, 0);
        assert!(!c.can_install);
        assert!(c.apk_url.as_deref().unwrap().ends_with("rustify-player_0.2.76.apk"));
    }

    /// O request de install sai em camelCase — o Kotlin lê `sha256`/`size`
    /// com default, mas `url` é obrigatória.
    #[test]
    fn updater_install_request_serializa_em_camel_case() {
        let req = UpdaterInstallRequest {
            url: "https://x/y.apk".into(),
            sha256: Some("ab".into()),
            size: 10,
        };
        let json = serde_json::to_string(&req).unwrap();
        assert!(json.contains("\"url\":\"https://x/y.apk\""), "{json}");
        assert!(json.contains("\"sha256\":\"ab\""), "{json}");
        assert!(json.contains("\"size\":10"), "{json}");
    }

    #[test]
    fn updater_check_request_omite_url_nula_como_null() {
        let req = UpdaterCheckRequest { manifest_url: None };
        assert_eq!(serde_json::to_string(&req).unwrap(), r#"{"manifestUrl":null}"#);
    }

    #[test]
    fn updater_install_result_le_status() {
        let r: UpdaterInstallResult = serde_json::from_str(r#"{"status":"needs_permission"}"#).unwrap();
        assert_eq!(r.status, "needs_permission");
    }
}
