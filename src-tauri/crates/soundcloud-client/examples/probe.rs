//! Teste manual de rede (fora do CI).
//!
//! Busca: `cargo run -p soundcloud-client --example probe -- mandelão`
//!
//! Original (precisa do token; rodar na cmr-auto):
//! `cargo run -p soundcloud-client --example probe -- --orig <url-da-faixa>`
//! O token é lido de `SC_TOKEN_FILE` (padrão `~/.secrets/soundcloud-oauth.txt`)
//! e nunca impresso; a URL assinada também não.

use soundcloud_client::{availability, HttpSoundCloud, SoundCloudApi};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let cache = std::env::temp_dir().join("soundcloud_client_id.json");
    let sc = HttpSoundCloud::new(cache, "rustify-player/probe".into());

    if args.first().map(String::as_str) == Some("--orig") {
        let Some(link) = args.get(1) else { return eprintln!("uso: --orig <url-da-faixa>") };
        let path = std::env::var("SC_TOKEN_FILE").unwrap_or_else(|_| {
            format!("{}/.secrets/soundcloud-oauth.txt", std::env::var("HOME").unwrap_or_default())
        });
        let Ok(token) = std::fs::read_to_string(&path) else { return eprintln!("token ausente em {path}") };
        let t = match sc.resolve(link) {
            Ok(t) => t,
            Err(e) => return eprintln!("resolve: {e}"),
        };
        println!("{} | {} | {} ms | {:?}", t.user_name, t.title, t.duration_ms, availability(&t));
        match sc.probe_original(t.id, &token, t.duration_ms) {
            Ok(o) => println!("ext={:?} size={:?} kbps_est={:?}", o.ext, o.size, o.kbps_est),
            Err(e) => eprintln!("probe_original: {e}"),
        }
        return;
    }

    let q = args.join(" ");
    match sc.search(if q.is_empty() { "mandelão" } else { &q }, 10) {
        Ok(tracks) => {
            for t in tracks {
                println!("{} | {} | {} ms | {:?}", t.user_name, t.title, t.duration_ms, availability(&t));
            }
        }
        Err(e) => eprintln!("erro: {e}"),
    }
}
