use library_indexer::radio_refusal::{give_back, refuse, RadioState, Refusal, Return};
use library_indexer::QdrantClient;
use serde_json::json;

/// Estado do rádio (B9) contra um Qdrant real: o filtro de `radio_states`
/// (range em campo nulo, `values_count` em lista) acha o que foi gravado,
/// deixa de achar o que foi apagado com `null` e não mexe no like.
///
/// Requer Qdrant em localhost:6333 (NUNCA o da cmr-auto). Ids sorteados
/// acima de i64::MAX, apagados no fim.
/// cargo test -p library-indexer --test radio_refusal_qdrant -- --ignored --nocapture
#[test]
#[ignore = "requires running Qdrant on localhost:6333"]
fn estado_do_radio_grava_acha_e_apaga() {
    let client = QdrantClient::new("http://localhost:6333");
    if !client.is_healthy() {
        eprintln!("Qdrant not available, skipping");
        return;
    }
    client.ensure_enrichments_collection().unwrap();
    let salt = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64
        & 0xFFFF_FFFF;
    let base = u64::MAX - (salt << 4);
    let (nunca, station, devolvida, intocada) = (base, base - 1, base - 2, base - 3);

    client.set_enrichment(nunca, json!({ "liked_at": 123, "energy": 0.7 })).unwrap();
    client.set_enrichment(intocada, json!({ "energy": 0.1 })).unwrap();
    let s_nunca = refuse(&RadioState::default(), &Refusal::Never, 1_800_000_000);
    let s_station = refuse(&RadioState::default(), &Refusal::Station("chuva-1".into()), 1_800_000_000);
    let s_devolvida = give_back(&RadioState::default(), &Return::All, 3, 1_800_000_000);
    client.set_radio_state(nunca, &s_nunca).unwrap();
    client.set_radio_state(station, &s_station).unwrap();
    client.set_radio_state(devolvida, &s_devolvida).unwrap();

    let all = client.radio_states().unwrap();
    assert_eq!(all.get(&nunca), Some(&s_nunca));
    assert_eq!(all.get(&station), Some(&s_station));
    assert_eq!(all.get(&devolvida), Some(&s_devolvida));
    assert!(!all.contains_key(&intocada), "faixa sem decisão não entra");

    // O like e a vibe continuam lá.
    let enr = client.get_enrichment(nunca).unwrap();
    assert_eq!(enr["liked_at"], json!(123));
    assert_eq!(enr["energy"], json!(0.7));

    // Desfazer a recusa apaga com null e a faixa some da varredura.
    let back = give_back(&s_nunca, &Return::Never, 0, 1_800_000_001);
    assert_eq!(back, RadioState::default());
    client.set_radio_state(nunca, &back).unwrap();
    assert_eq!(client.radio_state(nunca).unwrap(), RadioState::default());
    assert!(!client.radio_states().unwrap().contains_key(&nunca));
    assert_eq!(client.get_enrichment(nunca).unwrap()["liked_at"], json!(123));

    for id in [nunca, station, devolvida, intocada] {
        client.delete_enrichment(id).unwrap();
    }
}
