use library_indexer::QdrantClient;

/// Full lifecycle test: collection creation, upsert, count, scroll, recommend.
///
/// Requires a running Qdrant instance on localhost:6333.
/// Run with: cargo test -p library-indexer --test qdrant_client -- --ignored --nocapture
#[test]
#[ignore = "requires running Qdrant on localhost:6333"]
fn test_qdrant_lifecycle() {
    let client = QdrantClient::new("http://localhost:6333");

    if !client.is_healthy() {
        eprintln!("Qdrant not available, skipping");
        return;
    }

    // Ensure collection exists (idempotent).
    client.ensure_collection().expect("ensure_collection failed");

    // Upsert a test point with a sentinel ID unlikely to collide with real data.
    let vec: Vec<f32> = (0..768).map(|i| (i as f32) / 768.0).collect();
    let payload = serde_json::json!({
        "title": "qdrant_lifecycle_test",
        "artist": "test_suite"
    });
    client
        .upsert_batch(&[(999_999, vec.as_slice(), payload)])
        .expect("upsert_batch failed");

    // Scroll should include our sentinel ID.
    // Scroll is the consistent read path; points_count in collection info
    // may lag by up to one flush interval (5 s default) in Qdrant.
    let ids = client.scroll_ids().expect("scroll_ids failed");
    assert!(
        ids.contains(&999_999),
        "sentinel ID 999999 not found in scroll results"
    );

    // collection_point_count() is a best-effort stat — just check it parses.
    let count = client
        .collection_point_count()
        .expect("collection_point_count failed");
    println!("points_count (may be eventually consistent): {count}");

    // Recommend using the sentinel as a positive anchor.
    // With only 1 point this may return an empty list — that is acceptable.
    let recs = client
        .recommend(&[999_999], &[], 5)
        .expect("recommend failed");
    assert!(
        recs.len() <= 5,
        "recommend returned more results than requested limit"
    );

    println!(
        "lifecycle ok: count={count}, scroll_ids={}, recs={}",
        ids.len(),
        recs.len()
    );
}
