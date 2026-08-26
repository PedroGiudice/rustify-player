//! Sync de play_events do Android → desktop (fase 2 da spec de proveniência).
//!
//! O journal do plugin rustify-audio É a fila: cada linha tem UUID nascido
//! no evento e o `ack_events` compacta o consumido. Este módulo drena o
//! journal, monta o payload CANÔNICO (mesmos campos do
//! `build_play_event_payload` do desktop — teste de contrato garante) e faz
//! POST no receptor da cmr-auto via tailnet. Ack só depois do 200: se o
//! desktop está fechado ou o celular fora da tailnet, os eventos ficam no
//! journal e o próximo ciclo re-tenta (upsert por UUID = re-envio inócuo).

use serde_json::json;

/// Espelho de `library_indexer::SIGNAL_SCHEMA` — o library-indexer não
/// compila no Android. O teste `signal_schema_espelha_o_canonico` (host)
/// quebra se divergirem.
pub(crate) const SIGNAL_SCHEMA: i64 = 3;

/// Campos de uma linha do journal do plugin (chaves snake_case).
#[derive(serde::Deserialize)]
pub(crate) struct JournalEvent {
    pub uuid: String,
    pub event_type: String,
    /// String na cadeia inteira; u64 > 2^53 corrompe em JS.
    pub track_id: String,
    pub origin: String,
    #[serde(default)]
    pub context_id: Option<String>,
    pub started_at: i64,
    pub timestamp: i64,
    pub end_position_ms: u64,
    pub duration_ms: u64,
}

/// Payload canônico de um evento sincado. `None` se o track_id não parsear
/// pra u64 (não deve acontecer — nasce da biblioteca; dropar com log é
/// melhor que entupir a fila pra sempre).
pub(crate) fn build_synced_payload(
    ev: &JournalEvent,
    device_id: &str,
    app_version: &str,
) -> Option<serde_json::Value> {
    let track_id: u64 = ev.track_id.parse().ok()?;
    let listen_pct = if ev.duration_ms == 0 {
        0.0_f64
    } else {
        (ev.end_position_ms as f64 / ev.duration_ms as f64).clamp(0.0, 1.0)
    };
    let mut payload = json!({
        "event_type": ev.event_type,
        "timestamp": ev.timestamp,
        "track_id": track_id,
        "origin": ev.origin,
        "started_at": ev.started_at,
        "end_position_ms": ev.end_position_ms,
        "duration_ms": ev.duration_ms,
        "listen_pct": listen_pct,
        "signal_schema": SIGNAL_SCHEMA,
        "device_id": device_id,
        "app_version": app_version,
    });
    if let Some(cid) = &ev.context_id {
        payload["context_id"] = json!(cid);
    }
    Some(payload)
}

/// Resolve o token Bearer do sync (CMR-194). Precedência:
/// 1. `<data_dir>/sync.json` campo `"token"` (override manual, privado);
/// 2. cópia privada `<data_dir>/sync-token`;
/// 3. `<sdcard_rustify>/sync-token` (chega pelo trilho do phone-sync) — e ao
///    ler daqui, copia pro data dir privado: o sdcard é legível por qualquer
///    app com storage, a cópia privada passa a valer no próximo boot.
/// Conteúdo com trim (o arquivo costuma vir com \n). Sem token → `None` e o
/// header não vai — o receptor de hoje aceita, nada quebra.
pub(crate) fn resolve_token(
    data_dir: &std::path::Path,
    sdcard_rustify: &std::path::Path,
) -> Option<String> {
    if let Some(t) = std::fs::read(data_dir.join("sync.json"))
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v["token"].as_str().map(|s| s.trim().to_string()))
        .filter(|s| !s.is_empty())
    {
        return Some(t);
    }
    if let Ok(s) = std::fs::read_to_string(data_dir.join("sync-token")) {
        let t = s.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    let s = std::fs::read_to_string(sdcard_rustify.join("sync-token")).ok()?;
    let t = s.trim().to_string();
    if t.is_empty() {
        return None;
    }
    let _ = std::fs::write(data_dir.join("sync-token"), &t);
    Some(t)
}

#[cfg(target_os = "android")]
pub(crate) mod worker {
    use super::*;
    use std::time::Duration;
    use tauri_plugin_rustify_audio::RustifyAudioExt;

    const DEFAULT_ENDPOINT: &str = "http://100.102.249.9:19878/sync/events";
    const INTERVAL: Duration = Duration::from_secs(60);

    /// Endpoint do receptor: override em `<data_dir>/sync.json`
    /// (`{"endpoint":"http://..."}`), senão o default (cmr-auto na tailnet).
    fn endpoint(data_dir: &std::path::Path) -> String {
        std::fs::read(data_dir.join("sync.json"))
            .ok()
            .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
            .and_then(|v| v["endpoint"].as_str().map(String::from))
            .unwrap_or_else(|| DEFAULT_ENDPOINT.to_string())
    }

    pub(crate) fn spawn(app: tauri::AppHandle) {
        std::thread::Builder::new()
            .name("mobile-sync".into())
            .spawn(move || {
                use tauri::Manager;
                let data_dir = match app.path().app_data_dir() {
                    Ok(d) => d,
                    Err(e) => {
                        tracing::warn!(?e, "mobile-sync: sem data dir, worker não sobe");
                        return;
                    }
                };
                let _ = std::fs::create_dir_all(&data_dir);
                let device_id = crate::device_identity::load_or_create(&data_dir);
                let app_version = app.package_info().version.to_string();
                let url = endpoint(&data_dir);
                let token = super::resolve_token(
                    &data_dir,
                    &std::path::Path::new(crate::mobile_library::MUSIC_ROOT).join(".rustify"),
                );
                tracing::info!(%device_id, %url, com_token = token.is_some(),
                    "mobile-sync: worker ativo");
                loop {
                    std::thread::sleep(INTERVAL);
                    if let Err(e) = sync_once(&app, &device_id, &app_version, &url, token.as_deref())
                    {
                        tracing::debug!(e, "mobile-sync: ciclo falhou (re-tenta)");
                    }
                }
            })
            .ok();
    }

    fn sync_once(
        app: &tauri::AppHandle,
        device_id: &str,
        app_version: &str,
        url: &str,
        token: Option<&str>,
    ) -> Result<(), String> {
        use tauri::Manager;
        let audio = app.rustify_audio();
        let drained = tauri::async_runtime::block_on(audio.drain_events(0))
            .map_err(|e| format!("drain: {e}"))?;
        let raw = serde_json::to_value(&drained.events).map_err(|e| e.to_string())?;
        let events: Vec<JournalEvent> =
            serde_json::from_value(raw).map_err(|e| format!("journal parse: {e}"))?;
        if events.is_empty() {
            return Ok(());
        }

        // O worker vê TODO evento a cada 60s, com ou sem continuidade armada —
        // é o alimentador natural do anel de recentes ("não repete o que tocou
        // nos últimos dias"), cobrindo também a escuta manual e de playlist.
        // Antes do POST de propósito: rede fora não pode custar a memória.
        // O helper é o mesmo do tender e do `lib_recent_plays`: uma leitura
        // só do que é escuta e do que contou como play (CMR-215).
        if let Some(cs) = app.try_state::<crate::mobile_continuity::ContinuityState>() {
            cs.remember_recents(events.iter().filter_map(|ev| {
                crate::mobile_continuity::recents_feed_item(
                    &ev.event_type,
                    &ev.track_id,
                    ev.started_at,
                    ev.timestamp,
                    ev.end_position_ms as i64,
                    ev.duration_ms as i64,
                )
            }));
        }

        let mut batch = Vec::with_capacity(events.len());
        for ev in &events {
            match build_synced_payload(ev, device_id, app_version) {
                Some(payload) => batch.push(json!({ "uuid": ev.uuid, "payload": payload })),
                None => {
                    tracing::warn!(uuid = %ev.uuid, track_id = %ev.track_id,
                        "mobile-sync: track_id não-u64, evento dropado");
                }
            }
        }

        let mut req = ureq::post(url).timeout(Duration::from_secs(15));
        if let Some(t) = token {
            req = req.set("Authorization", &format!("Bearer {t}"));
        }
        let resp: serde_json::Value = req
            .send_json(json!({ "events": batch }))
            .map_err(|e| format!("post: {e}"))?
            .into_json()
            .map_err(|e| format!("resp: {e}"))?;
        let accepted = resp["accepted"].as_u64().unwrap_or(0);
        // O journal tem DOIS leitores e um só apaga. O tender lê os mesmos
        // eventos para reagir a skip; compactar à frente do cursor dele faria
        // rejeições sumirem em silêncio. Ver `ack_ceiling`.
        let upto = {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as i64)
                .unwrap_or(0);
            let (cursor, cursor_at) = app
                .try_state::<crate::mobile_continuity::ContinuityState>()
                .and_then(|s| {
                    s.inner
                        .lock()
                        .ok()
                        .map(|c| (c.journal_cursor, c.cursor_at))
                })
                .unwrap_or((0, 0));
            crate::mobile_continuity::ack_ceiling(drained.last_seq, cursor, cursor_at, now)
        };
        tracing::info!(
            sent = batch.len(),
            accepted,
            last_seq = drained.last_seq,
            ack_upto = upto,
            "mobile-sync: lote entregue"
        );
        // Rejeitados também ackam: re-enviar payload inválido para sempre não
        // conserta nada e o receptor já logou o motivo. O que fica para trás do
        // teto é re-enviado no próximo ciclo — inócuo, o upsert é por uuid.
        tauri::async_runtime::block_on(audio.ack_events(upto)).map_err(|e| format!("ack: {e}"))?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signal_schema_espelha_o_canonico() {
        assert_eq!(SIGNAL_SCHEMA, library_indexer::SIGNAL_SCHEMA);
    }

    /// O payload do Android deve ser indistinguível do que o desktop grava
    /// via build_play_event_payload + Provenance — mesmo contrato, byte a
    /// byte nos campos.
    #[test]
    fn payload_mobile_identico_ao_do_desktop() {
        let ev = JournalEvent {
            uuid: "x".into(),
            event_type: "track_ended".into(),
            track_id: "12755931536157556".into(),
            origin: "playlist".into(),
            context_id: Some("ctx-9".into()),
            started_at: 1_786_600_000,
            timestamp: 1_786_600_180,
            end_position_ms: 180_000,
            duration_ms: 200_000,
        };
        let mobile = build_synced_payload(&ev, "s24", "0.2.73").unwrap();
        let desktop = library_indexer::build_play_event_payload(
            "track_ended",
            12755931536157556,
            "playlist",
            1_786_600_000,
            1_786_600_180,
            180_000,
            200_000,
            Some("ctx-9"),
            Some(&library_indexer::Provenance {
                device_id: "s24".into(),
                app_version: "0.2.73".into(),
            }),
        );
        assert_eq!(mobile, desktop);
    }

    #[test]
    fn token_sync_json_vence_privado_e_sdcard() {
        let data = tempfile::tempdir().unwrap();
        let sdcard = tempfile::tempdir().unwrap();
        std::fs::write(data.path().join("sync.json"), r#"{"token":" da-config "}"#).unwrap();
        std::fs::write(data.path().join("sync-token"), "privado").unwrap();
        std::fs::write(sdcard.path().join("sync-token"), "do-sdcard").unwrap();
        assert_eq!(
            resolve_token(data.path(), sdcard.path()),
            Some("da-config".to_string())
        );
    }

    #[test]
    fn token_privado_vence_sdcard() {
        let data = tempfile::tempdir().unwrap();
        let sdcard = tempfile::tempdir().unwrap();
        std::fs::write(data.path().join("sync-token"), "privado\n").unwrap();
        std::fs::write(sdcard.path().join("sync-token"), "do-sdcard").unwrap();
        assert_eq!(
            resolve_token(data.path(), sdcard.path()),
            Some("privado".to_string())
        );
    }

    #[test]
    fn token_do_sdcard_copia_pro_data_dir() {
        let data = tempfile::tempdir().unwrap();
        let sdcard = tempfile::tempdir().unwrap();
        std::fs::write(sdcard.path().join("sync-token"), "abc123\n").unwrap();
        assert_eq!(
            resolve_token(data.path(), sdcard.path()),
            Some("abc123".to_string())
        );
        // Mitigação do sdcard legível: a partir daqui a cópia privada vale.
        assert_eq!(
            std::fs::read_to_string(data.path().join("sync-token")).unwrap(),
            "abc123"
        );
    }

    #[test]
    fn sem_token_em_lugar_nenhum_vira_none() {
        let data = tempfile::tempdir().unwrap();
        let sdcard = tempfile::tempdir().unwrap();
        assert_eq!(resolve_token(data.path(), sdcard.path()), None);
        // Arquivo vazio/whitespace também não vale como token.
        std::fs::write(sdcard.path().join("sync-token"), "\n").unwrap();
        assert_eq!(resolve_token(data.path(), sdcard.path()), None);
    }

    #[test]
    fn track_id_invalido_vira_none() {
        let ev = JournalEvent {
            uuid: "x".into(),
            event_type: "track_ended".into(),
            track_id: "não-numérico".into(),
            origin: "manual".into(),
            context_id: None,
            started_at: 1,
            timestamp: 2,
            end_position_ms: 0,
            duration_ms: 0,
        };
        assert!(build_synced_payload(&ev, "s24", "0.1.0").is_none());
    }
}
