//! Teste manual de rede (fora do CI): imprime a busca na API viva.
//! `cargo run -p soundcloud-client --example probe -- mandelão`

use soundcloud_client::{availability, HttpSoundCloud, SoundCloudApi};

fn main() {
    let q = std::env::args().skip(1).collect::<Vec<_>>().join(" ");
    let cache = std::env::temp_dir().join("soundcloud_client_id.json");
    let sc = HttpSoundCloud::new(cache, "rustify-player/probe".into());
    match sc.search(if q.is_empty() { "mandelão" } else { &q }, 10) {
        Ok(tracks) => {
            for t in tracks {
                println!("{} | {} | {} ms | {:?}", t.user_name, t.title, t.duration_ms, availability(&t));
            }
        }
        Err(e) => eprintln!("erro: {e}"),
    }
}
