use library_indexer::LyricsEmbedClient;

const COGMEM_URL: &str = "http://100.123.73.128:3939";

#[test]
fn lyrics_embed_returns_1024d_vector() {
    let client = LyricsEmbedClient::new(COGMEM_URL);
    if !client.is_healthy() {
        eprintln!("cogmem not reachable at {COGMEM_URL}, skipping");
        return;
    }
    let vec = client
        .embed_text("a melodia triste da saudade no fim da tarde")
        .expect("embed should succeed");
    assert_eq!(vec.len(), 1024, "BGE-M3 dense dimensionality");

    // BGE-M3 output is L2-normalized → norm ~= 1.0
    let norm: f32 = vec.iter().map(|x| x * x).sum::<f32>().sqrt();
    assert!(
        (norm - 1.0).abs() < 0.05,
        "expected L2-normalized vector, got norm={norm}"
    );
}
