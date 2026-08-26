//! Receptor do sync de play_events (fase 2 da spec de proveniência).
//!
//! HTTP mínimo no MESMO padrão do media server (TcpListener + threads),
//! mas escutando no IP TAILSCALE da máquina — o S24 alcança pela tailnet;
//! LAN e internet não (WireGuard é o perímetro, como no resto da infra).
//! Sem IP tailscale o receptor simplesmente não sobe. NUNCA bind em
//! 0.0.0.0 (hardening 2026-07-17).
//!
//! Contrato: POST /sync/events com
//! `{"events":[{"uuid":"...","payload":{...canônico...}}]}` → upsert
//! idempotente por uuid ([`QdrantClient::insert_synced_event`] valida a
//! proveniência e NÃO re-estampa). Eventos `like`/`unlike` NÃO viram
//! play_event: vão pra `track_enrichments` com last-write-wins por
//! `like_updated_at` ([`QdrantClient::apply_synced_like`], CMR-220).
//! Resposta: `200 {"accepted":N,"rejected":M}` — o S24 acka TUDO que vem
//! com 200, inclusive o rejeitado por validação (re-enviar não conserta);
//! no-op por LWW conta como aceito. Falha de HTTP/transporte com o Qdrant
//! → `503 {"error":...}` e o lote aborta sem contagem: o worker NÃO acka e
//! re-envia inteiro no próximo tick (upsert idempotente por uuid, like por
//! LWW — replay é seguro). GET /sync/health → 200.

use library_indexer::{QdrantClient, SyncedOutcome};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};

const SYNC_PORT: u16 = 19878;
const MAX_BODY: usize = 4 * 1024 * 1024;

/// Fase de observação do auth (CMR-194): `false` = verifica e LOGA, mas
/// aceita tudo. O flip pra `true` (fail-closed, 401) é a fase 3 — só depois
/// de ≥1 dia de `sync auth ok` nos lotes reais do S24.
const REQUIRE_BEARER: bool = false;

/// `token` é o Bearer esperado (`<data_dir>/sync-token` na cmr-auto, o mesmo
/// arquivo que o export_manifest.py leva ao aparelho). `None` = sem auth
/// configurado, comporta como sempre.
pub(crate) fn start(client: QdrantClient, token: Option<String>) {
    let Some(ip) = tailscale_ip() else {
        tracing::info!("sync receiver: sem IP tailscale — não sobe");
        return;
    };
    if token.is_none() {
        tracing::info!("sync auth: sem token configurado — aceitando sem verificação");
    }
    start_on(&format!("{ip}:{SYNC_PORT}"), client, token);
}

/// Sobe o listener num addr explícito. Retorna a porta real (testes usam
/// `:0`); `None` se o bind falhar.
fn start_on(addr: &str, client: QdrantClient, token: Option<String>) -> Option<u16> {
    let listener = match TcpListener::bind(addr) {
        Ok(l) => l,
        Err(e) => {
            tracing::warn!(?e, %addr, "sync receiver: bind falhou");
            return None;
        }
    };
    let port = listener.local_addr().ok()?.port();
    tracing::info!(%addr, port, "sync receiver listening");
    std::thread::Builder::new()
        .name("sync-receiver".into())
        .spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { continue };
                let client = client.clone();
                let token = token.clone();
                std::thread::Builder::new()
                    .name("sync-conn".into())
                    .spawn(move || {
                        if let Err(e) = handle(&mut stream, &client, token.as_deref()) {
                            tracing::debug!(?e, "sync receiver: conn error");
                        }
                    })
                    .ok();
            }
        })
        .ok();
    Some(port)
}

/// IPv4 da tailnet via CLI (`tailscale ip -4`). Sem CLI/tailnet → None.
fn tailscale_ip() -> Option<String> {
    let out = std::process::Command::new("tailscale")
        .args(["ip", "-4"])
        .output()
        .ok()?;
    let ip = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()?
        .trim()
        .to_string();
    (!ip.is_empty()).then_some(ip)
}

fn handle(
    stream: &mut TcpStream,
    client: &QdrantClient,
    token: Option<&str>,
) -> std::io::Result<()> {
    let mut buf = Vec::with_capacity(8192);
    let mut chunk = [0u8; 8192];
    let header_end = loop {
        let n = stream.read(&mut chunk)?;
        if n == 0 {
            return Ok(());
        }
        buf.extend_from_slice(&chunk[..n]);
        if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
            break pos + 4;
        }
        if buf.len() > 64 * 1024 {
            return respond(stream, 431, r#"{"error":"headers too large"}"#);
        }
    };

    let head = String::from_utf8_lossy(&buf[..header_end]).to_string();
    let mut lines = head.lines();
    let request_line = lines.next().unwrap_or_default().to_string();
    let mut parts = request_line.split_whitespace();
    let (method, path) = (
        parts.next().unwrap_or_default().to_string(),
        parts.next().unwrap_or_default().to_string(),
    );

    match (method.as_str(), path.as_str()) {
        ("GET", "/sync/health") => respond(stream, 200, r#"{"ok":true}"#),
        ("POST", "/sync/events") => {
            let (mut content_length, mut authorization) = (0usize, None::<String>);
            for (k, v) in lines.filter_map(|l| l.split_once(':')) {
                if k.eq_ignore_ascii_case("content-length") {
                    content_length = v.trim().parse().unwrap_or(0);
                } else if k.eq_ignore_ascii_case("authorization") {
                    authorization = Some(v.trim().to_string());
                }
            }
            // Auth (CMR-194): token configurado → header deve conferir.
            // Antes do body de propósito: quando REQUIRE_BEARER virar true,
            // o 401 sai sem processar nada.
            let auth_ok = match token {
                None => true,
                Some(t) => authorization.as_deref() == Some(format!("Bearer {t}").as_str()),
            };
            if !auth_ok {
                if REQUIRE_BEARER {
                    return respond(stream, 401, r#"{"error":"unauthorized"}"#);
                }
                tracing::warn!(
                    header_presente = authorization.is_some(),
                    "sync auth FALHOU — aceitando (observação; REQUIRE_BEARER=false)"
                );
            } else if token.is_some() {
                tracing::info!("sync auth ok");
            }
            if content_length == 0 || content_length > MAX_BODY {
                return respond(stream, 400, r#"{"error":"bad content-length"}"#);
            }
            let mut body = buf[header_end..].to_vec();
            while body.len() < content_length {
                let n = stream.read(&mut chunk)?;
                if n == 0 {
                    break;
                }
                body.extend_from_slice(&chunk[..n]);
            }
            let parsed: serde_json::Value = match serde_json::from_slice(&body) {
                Ok(v) => v,
                Err(_) => return respond(stream, 400, r#"{"error":"invalid json"}"#),
            };
            let Some(events) = parsed["events"].as_array() else {
                return respond(stream, 400, r#"{"error":"missing events"}"#);
            };
            let (mut accepted, mut rejected) = (0u32, 0u32);
            for ev in events {
                let (Some(uuid), Some(payload)) = (ev["uuid"].as_str(), ev.get("payload"))
                else {
                    rejected += 1;
                    continue;
                };
                // like/unlike NUNCA entram em play_events: vão pro enrichment
                // com LWW por like_updated_at (CMR-220).
                let result = match payload["event_type"].as_str() {
                    Some("like") | Some("unlike") => client.apply_synced_like(payload),
                    _ => client.insert_synced_event(uuid, payload),
                };
                match result {
                    Ok(SyncedOutcome::Applied) => accepted += 1,
                    Ok(SyncedOutcome::Skipped { current }) => {
                        tracing::debug!(
                            uuid,
                            track_id = %payload["track_id"],
                            ts = %payload["timestamp"],
                            vigente = current,
                            "sync receiver: no-op por LWW (like vigente é mais novo)"
                        );
                        accepted += 1;
                    }
                    Ok(SyncedOutcome::Rejected(reason)) => {
                        tracing::warn!(%reason, uuid, "sync receiver: evento rejeitado");
                        rejected += 1;
                    }
                    // Transporte com o Qdrant falhou: NADA pode ser ackado —
                    // 200 aqui faria o S24 ackar e o like/play sumir pra
                    // sempre. Aborta o lote; o re-envio inteiro é seguro
                    // (upsert por uuid, like por LWW).
                    Err(e) => {
                        tracing::warn!(
                            ?e,
                            uuid,
                            accepted,
                            rejected,
                            "sync receiver: Qdrant indisponível — lote abortado com 503"
                        );
                        return respond(stream, 503, r#"{"error":"qdrant unavailable"}"#);
                    }
                }
            }
            tracing::info!(accepted, rejected, "sync receiver: lote processado");
            respond(
                stream,
                200,
                &format!(r#"{{"accepted":{accepted},"rejected":{rejected}}}"#),
            )
        }
        _ => respond(stream, 404, r#"{"error":"not found"}"#),
    }
}

fn respond(stream: &mut TcpStream, status: u16, body: &str) -> std::io::Result<()> {
    let reason = match status {
        200 => "OK",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        431 => "Request Header Fields Too Large",
        503 => "Service Unavailable",
        _ => "Error",
    };
    write!(
        stream,
        "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    /// Comportamento do Qdrant fake: o que o GET de enrichment devolve e o
    /// status do PUT (500 = Qdrant quebrando no meio do lote).
    struct FakeQdrant {
        enrichment: &'static str,
        put_status: u16,
    }

    impl Default for FakeQdrant {
        fn default() -> Self {
            Self { enrichment: r#"{"result":{"payload":{}}}"#, put_status: 200 }
        }
    }

    /// Qdrant fake: REGISTRA cada request (request-line + headers + body) e
    /// responde 200 com algo plausível — `{"result":{"payload":{}}}` pro GET
    /// de enrichment (ponto sem nada), `{}` pro resto. O que importa é o
    /// contrato HTTP do receptor (parse, validação, contagem, roteamento) —
    /// a validação de payload em si é testada no library-indexer.
    fn fake_qdrant() -> (u16, Arc<Mutex<Vec<String>>>) {
        fake_qdrant_with(FakeQdrant::default())
    }

    fn fake_qdrant_with(cfg: FakeQdrant) -> (u16, Arc<Mutex<Vec<String>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let requests = Arc::new(Mutex::new(Vec::new()));
        let log = Arc::clone(&requests);
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let Some(req) = read_request(&mut s) else { continue };
                let (status, body) =
                    if req.starts_with("GET /collections/track_enrichments/points/") {
                        (200, cfg.enrichment)
                    } else if req.starts_with("PUT ") {
                        (cfg.put_status, "{}")
                    } else {
                        (200, "{}")
                    };
                log.lock().unwrap().push(req);
                let reason = if status == 200 { "OK" } else { "Internal Server Error" };
                let _ = write!(
                    s,
                    "HTTP/1.1 {status} {reason}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
            }
        });
        (port, requests)
    }

    /// Lê headers + body (Content-Length) de uma request e devolve o texto
    /// cru — o body pode chegar num segmento separado dos headers.
    fn read_request(s: &mut TcpStream) -> Option<String> {
        let mut buf = Vec::new();
        let mut chunk = [0u8; 8192];
        let header_end = loop {
            let n = s.read(&mut chunk).ok()?;
            if n == 0 {
                return None;
            }
            buf.extend_from_slice(&chunk[..n]);
            if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                break pos + 4;
            }
        };
        let content_length: usize = String::from_utf8_lossy(&buf[..header_end])
            .lines()
            .filter_map(|l| l.split_once(':'))
            .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
            .and_then(|(_, v)| v.trim().parse().ok())
            .unwrap_or(0);
        while buf.len() < header_end + content_length {
            let n = s.read(&mut chunk).ok()?;
            if n == 0 {
                break;
            }
            buf.extend_from_slice(&chunk[..n]);
        }
        Some(String::from_utf8_lossy(&buf).to_string())
    }

    #[test]
    fn post_de_lote_conta_aceitos_e_rejeitados() {
        let (qdrant_port, requests) = fake_qdrant();
        let client = QdrantClient::new(format!("http://127.0.0.1:{qdrant_port}"));
        let port = start_on("127.0.0.1:0", client, None).expect("receiver sobe");

        let valido = play_event("11111111-2222-3333-4444-555555555555", 12755931536157556u64);
        // sem device_id → rejeitado pela validação de proveniência
        let invalido = serde_json::json!({
            "uuid": "99999999-8888-7777-6666-555555555555",
            "payload": { "event_type": "track_ended", "track_id": 1, "signal_schema": 3 }
        });
        let body =
            serde_json::json!({ "events": [valido, invalido] }).to_string();

        let resp: serde_json::Value = ureq::post(&format!("http://127.0.0.1:{port}/sync/events"))
            .send_string(&body)
            .unwrap()
            .into_json()
            .unwrap();
        assert_eq!(resp["accepted"], 1);
        assert_eq!(resp["rejected"], 1);

        // O válido virou UM PUT em play_events com o uuid de origem como id
        // (upsert idempotente); o rejeitado nem chegou ao Qdrant; e nada
        // tocou track_enrichments — play NUNCA vira like.
        let reqs = requests.lock().unwrap();
        assert_eq!(reqs.len(), 1, "{reqs:?}");
        let put = reqs
            .iter()
            .find(|r| r.starts_with("PUT /collections/play_events/points"))
            .expect("PUT em play_events");
        assert!(put.contains("\"id\":\"11111111-2222-3333-4444-555555555555\""), "{put}");
        assert!(
            !reqs.iter().any(|r| r.contains("/collections/track_enrichments/")),
            "{reqs:?}"
        );
        drop(reqs);

        // health
        let health = ureq::get(&format!("http://127.0.0.1:{port}/sync/health"))
            .call()
            .unwrap()
            .status();
        assert_eq!(health, 200);
    }

    fn lote_minimo() -> String {
        serde_json::json!({ "events": [{
            "uuid": "11111111-2222-3333-4444-555555555555",
            "payload": {
                "event_type": "track_ended", "track_id": 1u64,
                "origin": "manual", "started_at": 1, "timestamp": 2,
                "end_position_ms": 100, "duration_ms": 100, "listen_pct": 1.0,
                "signal_schema": 3, "device_id": "s24", "app_version": "0.1.0"
            }
        }]})
        .to_string()
    }

    #[test]
    fn auth_com_header_certo_aceita() {
        let client = QdrantClient::new(format!("http://127.0.0.1:{}", fake_qdrant().0));
        let port =
            start_on("127.0.0.1:0", client, Some("tok-secreto".into())).expect("receiver sobe");
        let status = ureq::post(&format!("http://127.0.0.1:{port}/sync/events"))
            .set("Authorization", "Bearer tok-secreto")
            .send_string(&lote_minimo())
            .unwrap()
            .status();
        assert_eq!(status, 200);
    }

    /// Fase de observação (REQUIRE_BEARER=false): header errado LOGA mas
    /// aceita. A fase 3 (fail-closed) inverte este teste pra 401.
    #[test]
    fn auth_header_errado_em_observacao_aceita() {
        let client = QdrantClient::new(format!("http://127.0.0.1:{}", fake_qdrant().0));
        let port =
            start_on("127.0.0.1:0", client, Some("tok-secreto".into())).expect("receiver sobe");
        let status = ureq::post(&format!("http://127.0.0.1:{port}/sync/events"))
            .set("Authorization", "Bearer errado")
            .send_string(&lote_minimo())
            .unwrap()
            .status();
        assert_eq!(status, if REQUIRE_BEARER { 401 } else { 200 });
    }

    #[test]
    fn sem_token_configurado_aceita_sem_header() {
        let client = QdrantClient::new(format!("http://127.0.0.1:{}", fake_qdrant().0));
        let port = start_on("127.0.0.1:0", client, None).expect("receiver sobe");
        let status = ureq::post(&format!("http://127.0.0.1:{port}/sync/events"))
            .send_string(&lote_minimo())
            .unwrap()
            .status();
        assert_eq!(status, 200);
    }

    /// POST do lote devolvendo (status, body) mesmo em status de erro — o
    /// ureq trata 4xx/5xx como Err, exatamente o que o worker do S24 vê
    /// (e por isso não acka).
    fn post_lote_raw(port: u16, body: &str) -> (u16, serde_json::Value) {
        match ureq::post(&format!("http://127.0.0.1:{port}/sync/events")).send_string(body) {
            Ok(resp) => (resp.status(), resp.into_json().unwrap()),
            Err(ureq::Error::Status(code, resp)) => (code, resp.into_json().unwrap()),
            Err(e) => panic!("transporte: {e}"),
        }
    }

    fn post_lote(port: u16, body: &str) -> serde_json::Value {
        let (status, resp) = post_lote_raw(port, body);
        assert_eq!(status, 200, "{resp}");
        resp
    }

    /// Play event canônico e válido (mesma forma do builder do S24).
    fn play_event(uuid: &str, track_id: u64) -> serde_json::Value {
        serde_json::json!({
            "uuid": uuid,
            "payload": {
                "event_type": "track_ended", "track_id": track_id,
                "origin": "playlist", "started_at": 1, "timestamp": 2,
                "end_position_ms": 100, "duration_ms": 100, "listen_pct": 1.0,
                "signal_schema": 3, "device_id": "s24", "app_version": "0.1.0"
            }
        })
    }

    /// Like válido com o timestamp dado (o clock do LWW).
    fn like_event(uuid: &str, timestamp: i64) -> serde_json::Value {
        serde_json::json!({
            "uuid": uuid,
            "payload": {
                "event_type": "like", "track_id": 12755931536157556u64,
                "origin": "manual", "started_at": 0, "timestamp": timestamp,
                "end_position_ms": 0, "duration_ms": 0, "listen_pct": 0.0,
                "signal_schema": 3, "device_id": "s24", "app_version": "0.2.77"
            }
        })
    }

    #[test]
    fn post_de_like_roteia_pra_track_enrichments() {
        let (qdrant_port, requests) = fake_qdrant();
        let client = QdrantClient::new(format!("http://127.0.0.1:{qdrant_port}"));
        let port = start_on("127.0.0.1:0", client, None).expect("receiver sobe");
        let body = serde_json::json!({ "events": [{
            "uuid": "aaaaaaaa-2222-3333-4444-555555555555",
            "payload": {
                "event_type": "like", "track_id": 12755931536157556u64,
                "origin": "manual", "started_at": 0, "timestamp": 1_700_000_000,
                "end_position_ms": 0, "duration_ms": 0, "listen_pct": 0.0,
                "signal_schema": 3, "device_id": "s24", "app_version": "0.2.77"
            }
        }]})
        .to_string();

        let resp = post_lote(port, &body);
        assert_eq!(resp["accepted"], 1);
        assert_eq!(resp["rejected"], 0);

        // A resposta só sai depois do lote inteiro, então o log está completo.
        let reqs = requests.lock().unwrap();
        assert!(
            reqs.iter().any(|r| r.contains("/collections/track_enrichments/points")),
            "{reqs:?}"
        );
        assert!(
            !reqs.iter().any(|r| r.contains("/collections/play_events/points")),
            "like NUNCA entra em play_events: {reqs:?}"
        );
        let put = reqs
            .iter()
            .find(|r| r.starts_with("PUT /collections/track_enrichments/points"))
            .expect("PUT em track_enrichments");
        assert!(put.contains("\"liked_at\":1700000000"), "{put}");
        assert!(put.contains("\"liked_device\":\"s24\""), "{put}");
        assert!(put.contains("\"like_updated_at\":1700000000"), "{put}");
    }

    #[test]
    fn post_de_unlike_sem_device_id_e_rejeitado() {
        let (qdrant_port, requests) = fake_qdrant();
        let client = QdrantClient::new(format!("http://127.0.0.1:{qdrant_port}"));
        let port = start_on("127.0.0.1:0", client, None).expect("receiver sobe");
        let body = serde_json::json!({ "events": [{
            "uuid": "bbbbbbbb-2222-3333-4444-555555555555",
            "payload": {
                "event_type": "unlike", "track_id": 1u64, "timestamp": 5, "signal_schema": 3
            }
        }]})
        .to_string();

        let resp = post_lote(port, &body);
        assert_eq!(resp["accepted"], 0);
        assert_eq!(resp["rejected"], 1);
        // Validação de proveniência roda ANTES de qualquer request: nenhum
        // PUT em track_enrichments (nem GET — o Qdrant nem é tocado).
        let reqs = requests.lock().unwrap();
        assert!(reqs.is_empty(), "{reqs:?}");
    }

    /// Falha de transporte: Qdrant fora do ar (porta fechada). O lote NÃO
    /// pode virar 200 — o S24 acka tudo que vem com 200 e o like/play
    /// sumiria pra sempre. 503 sem contagem → o worker não acka e re-envia
    /// no próximo tick.
    #[test]
    fn qdrant_fora_do_ar_responde_503_e_nada_e_aceito() {
        let client = QdrantClient::new("http://127.0.0.1:1");
        let port = start_on("127.0.0.1:0", client, None).expect("receiver sobe");
        for body in [
            lote_minimo(),
            serde_json::json!({ "events": [like_event("aaaaaaaa-2222-3333-4444-555555555555", 10)] })
                .to_string(),
        ] {
            let (status, resp) = post_lote_raw(port, &body);
            assert_eq!(status, 503, "{resp}");
            assert!(resp.get("accepted").is_none(), "{resp}");
            assert_eq!(resp["error"], "qdrant unavailable");
        }
    }

    /// Qdrant responde 500 no PUT do 1º evento: o lote aborta ALI (o 2º nem
    /// é tentado) e a resposta é 503 sem contagem. Replay do lote inteiro é
    /// seguro — upsert por uuid.
    #[test]
    fn erro_http_do_qdrant_no_meio_do_lote_aborta_com_503() {
        let (qdrant_port, requests) =
            fake_qdrant_with(FakeQdrant { put_status: 500, ..Default::default() });
        let client = QdrantClient::new(format!("http://127.0.0.1:{qdrant_port}"));
        let port = start_on("127.0.0.1:0", client, None).expect("receiver sobe");
        let body = serde_json::json!({ "events": [
            play_event("11111111-2222-3333-4444-555555555555", 1),
            play_event("22222222-2222-3333-4444-555555555555", 2),
        ]})
        .to_string();

        let (status, resp) = post_lote_raw(port, &body);
        assert_eq!(status, 503, "{resp}");
        assert!(resp.get("accepted").is_none(), "{resp}");
        let reqs = requests.lock().unwrap();
        assert_eq!(reqs.iter().filter(|r| r.starts_with("PUT ")).count(), 1, "{reqs:?}");
    }

    /// timestamp 0 não ordena no LWW (e liked_at=0 é ambíguo): rejeitado por
    /// validação → conta em `rejected`, 200, e o Qdrant nem é tocado.
    #[test]
    fn like_com_timestamp_zero_e_rejeitado_sem_tocar_o_qdrant() {
        let (qdrant_port, requests) = fake_qdrant();
        let client = QdrantClient::new(format!("http://127.0.0.1:{qdrant_port}"));
        let port = start_on("127.0.0.1:0", client, None).expect("receiver sobe");
        let body = serde_json::json!({ "events": [
            like_event("aaaaaaaa-2222-3333-4444-555555555555", 0)
        ]})
        .to_string();

        let resp = post_lote(port, &body);
        assert_eq!(resp["accepted"], 0);
        assert_eq!(resp["rejected"], 1);
        assert!(requests.lock().unwrap().is_empty());
    }

    /// Like mais velho que o vigente é no-op por LWW — mas ACEITO: o S24
    /// deve ackar (re-enviar nunca vai vencer o like mais novo). Só o GET do
    /// enrichment acontece; nenhum PUT.
    #[test]
    fn like_mais_velho_que_o_vigente_e_noop_mas_conta_como_aceito() {
        let (qdrant_port, requests) = fake_qdrant_with(FakeQdrant {
            enrichment: r#"{"result":{"payload":{"liked_at":200,"liked_device":"cmr-auto","like_updated_at":200}}}"#,
            ..Default::default()
        });
        let client = QdrantClient::new(format!("http://127.0.0.1:{qdrant_port}"));
        let port = start_on("127.0.0.1:0", client, None).expect("receiver sobe");
        let body = serde_json::json!({ "events": [
            like_event("aaaaaaaa-2222-3333-4444-555555555555", 100)
        ]})
        .to_string();

        let resp = post_lote(port, &body);
        assert_eq!(resp["accepted"], 1);
        assert_eq!(resp["rejected"], 0);
        let reqs = requests.lock().unwrap();
        assert!(
            reqs.iter().any(|r| r.starts_with("GET /collections/track_enrichments/points/")),
            "{reqs:?}"
        );
        assert!(!reqs.iter().any(|r| r.starts_with("PUT ")), "no-op não escreve: {reqs:?}");
    }
}
