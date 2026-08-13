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
//! proveniência e NÃO re-estampa). Resposta: `{"accepted":N,"rejected":M}`.
//! GET /sync/health → 200.

use library_indexer::QdrantClient;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};

const SYNC_PORT: u16 = 19878;
const MAX_BODY: usize = 4 * 1024 * 1024;

pub(crate) fn start(client: QdrantClient) {
    let Some(ip) = tailscale_ip() else {
        tracing::info!("sync receiver: sem IP tailscale — não sobe");
        return;
    };
    start_on(&format!("{ip}:{SYNC_PORT}"), client);
}

/// Sobe o listener num addr explícito. Retorna a porta real (testes usam
/// `:0`); `None` se o bind falhar.
fn start_on(addr: &str, client: QdrantClient) -> Option<u16> {
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
                std::thread::Builder::new()
                    .name("sync-conn".into())
                    .spawn(move || {
                        if let Err(e) = handle(&mut stream, &client) {
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

fn handle(stream: &mut TcpStream, client: &QdrantClient) -> std::io::Result<()> {
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
            let content_length = lines
                .filter_map(|l| l.split_once(':'))
                .find(|(k, _)| k.eq_ignore_ascii_case("content-length"))
                .and_then(|(_, v)| v.trim().parse::<usize>().ok())
                .unwrap_or(0);
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
                match client.insert_synced_event(uuid, payload) {
                    Ok(()) => accepted += 1,
                    Err(e) => {
                        tracing::warn!(?e, uuid, "sync receiver: evento rejeitado");
                        rejected += 1;
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
        404 => "Not Found",
        431 => "Request Header Fields Too Large",
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

    /// Qdrant fake: responde 200 `{}` a qualquer request. O que importa é o
    /// contrato HTTP do receptor (parse, validação, contagem) — a validação
    /// de payload em si já é testada em synced_event_error.
    fn fake_qdrant() -> u16 {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut s) = stream else { continue };
                let mut buf = [0u8; 65536];
                let _ = std::io::Read::read(&mut s, &mut buf);
                let _ = write!(
                    s,
                    "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
                );
            }
        });
        port
    }

    #[test]
    fn post_de_lote_conta_aceitos_e_rejeitados() {
        let qdrant_port = fake_qdrant();
        let client = QdrantClient::new(format!("http://127.0.0.1:{qdrant_port}"));
        let port = start_on("127.0.0.1:0", client).expect("receiver sobe");

        let valido = serde_json::json!({
            "uuid": "11111111-2222-3333-4444-555555555555",
            "payload": {
                "event_type": "track_ended", "track_id": 12755931536157556u64,
                "origin": "playlist", "started_at": 1, "timestamp": 2,
                "end_position_ms": 100, "duration_ms": 100, "listen_pct": 1.0,
                "signal_schema": 3, "device_id": "s24", "app_version": "0.1.0"
            }
        });
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

        // health
        let health = ureq::get(&format!("http://127.0.0.1:{port}/sync/health"))
            .call()
            .unwrap()
            .status();
        assert_eq!(health, 200);
    }
}
