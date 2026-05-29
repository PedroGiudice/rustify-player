//! Garante que os embed clients NÃO penduram indefinidamente quando o
//! servidor aceita a conexão TCP mas nunca responde (cenário do stall em
//! produção: serviço MERT vivo mas travado). Sem deadline global no ureq,
//! a request ficaria presa para sempre congelando o worker do pipeline.
//!
//! Estes testes sobem um TcpListener local que faz `accept()` e depois
//! segura o socket sem escrever nada. O client deve retornar `Err` dentro
//! de um deadline curto.

use library_indexer::{EmbedClient, LyricsEmbedClient};
use std::io::Read;
use std::net::TcpListener;
use std::time::{Duration, Instant};

/// Sobe um listener que aceita uma conexão, lê o request (drena o socket)
/// e então segura o socket aberto sem responder, até o `hold` expirar.
/// Retorna o endereço `host:port` para o client apontar.
fn spawn_silent_server(hold: Duration) -> String {
    let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
    let addr = listener.local_addr().expect("local addr");
    std::thread::spawn(move || {
        if let Ok((mut stream, _)) = listener.accept() {
            // Drena o que o client mandar para não causar RST no write dele,
            // depois apenas segura o socket sem responder.
            let mut buf = [0u8; 4096];
            let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
            let _ = stream.read(&mut buf);
            std::thread::sleep(hold);
        }
    });
    format!("127.0.0.1:{}", addr.port())
}

#[test]
fn lyrics_embed_times_out_instead_of_hanging() {
    // Servidor segura o socket por 30s; o client tem deadline de 2s.
    let addr = spawn_silent_server(Duration::from_secs(30));
    let base = format!("http://{addr}");

    let client = LyricsEmbedClient::with_timeouts(
        base,
        Duration::from_secs(2), // request global
        Duration::from_secs(1), // connect
    );

    let start = Instant::now();
    let result = client.embed_text("qualquer texto");
    let elapsed = start.elapsed();

    assert!(result.is_err(), "deve falhar por timeout, não pendurar");
    assert!(
        elapsed < Duration::from_secs(10),
        "deve retornar perto do deadline de 2s, levou {elapsed:?}"
    );
}

#[test]
fn mert_embed_times_out_instead_of_hanging() {
    let addr = spawn_silent_server(Duration::from_secs(30));
    let base = format!("http://{addr}");

    let client = EmbedClient::with_timeouts(
        base,
        Duration::from_secs(2),
        Duration::from_secs(1),
    );

    // Amostras sintéticas: evita decodificar FLAC, vai direto ao POST.
    let samples = vec![0.0_f32; 24_000];

    let start = Instant::now();
    let result = client.embed_samples(&samples);
    let elapsed = start.elapsed();

    assert!(result.is_err(), "deve falhar por timeout, não pendurar");
    assert!(
        elapsed < Duration::from_secs(10),
        "deve retornar perto do deadline de 2s, levou {elapsed:?}"
    );
}
