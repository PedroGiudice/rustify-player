//! Testes de desserialização contra fixtures reais da API slskd v0
//! (capturadas no spike de 2026-08-07, slskd 0.25.1 na cmr-auto).

use slskd_client::wire::{ApiSearchResponse, ApiTransferUser};

fn load_fixture(name: &str) -> String {
    let path = format!("{}/tests/fixtures/{}", env!("CARGO_MANIFEST_DIR"), name);
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("failed to read {path}: {e}"))
}

#[test]
fn wire_parses_real_search_responses_fixture() {
    let raw = load_fixture("search-responses.json");
    let responses: Vec<ApiSearchResponse> =
        serde_json::from_str(&raw).expect("search-responses.json should parse");

    assert_eq!(responses.len(), 94);
    assert_eq!(responses[0].files[0].bit_depth, Some(16));
}

#[test]
fn wire_parses_real_transfers_fixture() {
    let raw = load_fixture("transfers.json");
    let users: Vec<ApiTransferUser> =
        serde_json::from_str(&raw).expect("transfers.json should parse");

    assert_eq!(users.len(), 50);

    let has_completed_errored = users
        .iter()
        .flat_map(|u| u.directories.iter())
        .flat_map(|d| d.files.iter())
        .any(|f| f.state == "Completed, Errored");
    assert!(
        has_completed_errored,
        "expected at least one transfer file with state \"Completed, Errored\""
    );
}

#[test]
fn wire_tolerates_unknown_and_missing_fields() {
    let raw = r#"{"username":"x"}"#;
    let resp: ApiSearchResponse =
        serde_json::from_str(raw).expect("minimal JSON with unknown/missing fields should parse");

    assert_eq!(resp.username, "x");
    assert_eq!(resp.file_count, 0);
    assert!(resp.files.is_empty());
    assert!(!resp.has_free_upload_slot);
}
