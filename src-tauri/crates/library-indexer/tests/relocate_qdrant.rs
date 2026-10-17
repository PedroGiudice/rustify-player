use library_indexer::relocate::{move_tracks, Journal, MoveStatus, MoveTarget};
use library_indexer::types::path_to_id;
use library_indexer::QdrantClient;
use serde_json::json;
use std::fs;

/// Ciclo completo de "Mover para playlist…" (CMR-298) contra um Qdrant real:
/// vetores, payload externo, enrichment e play_events vão para o id novo.
///
/// Requer Qdrant em localhost:6333 (NUNCA o da cmr-auto — usa as collections
/// de verdade com ids derivados de um tempdir, que não colidem com o acervo).
/// cargo test -p library-indexer --test relocate_qdrant -- --ignored --nocapture
#[test]
#[ignore = "requires running Qdrant on localhost:6333"]
fn mover_leva_vetores_like_e_plays() {
    let client = QdrantClient::new("http://localhost:6333");
    if !client.is_healthy() {
        eprintln!("Qdrant not available, skipping");
        return;
    }
    client.ensure_collection().unwrap();
    client.ensure_play_events_collection().unwrap();
    client.ensure_enrichments_collection().unwrap();

    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let album = root.join("Rap/Artista/2020 - Álbum [tidal]");
    fs::create_dir_all(&album).unwrap();
    let src = album.join("01 - Faixa.flac");
    fs::write(&src, b"flac").unwrap();
    fs::write(album.join("01 - Faixa.lrc"), b"[00:01.00] verso").unwrap();
    fs::write(album.join("cover.jpg"), b"jpg").unwrap();

    let old_id = path_to_id(&src);
    let mert: Vec<f32> = (0..768).map(|i| i as f32 / 768.0).collect();
    let lyrics: Vec<f32> = (0..1024).map(|i| (i % 7) as f32).collect();
    client
        .upsert_point_raw(
            old_id,
            &json!({
                "path": src.to_string_lossy(), "filename": "01 - Faixa.flac", "genre": "Rap",
                "title": "Faixa", "lyrics_text": "verso", "lyrics_status": "plain",
                "lrc_path": album.join("01 - Faixa.lrc").to_string_lossy(),
                "mtime": 1, "size_bytes": 4, "embedding_status": "done"
            }),
            &json!({ "mert": mert, "lyrics": lyrics }),
        )
        .unwrap();
    client.set_enrichment(old_id, json!({ "liked_at": 123, "play_count": 7, "energy": 0.8 })).unwrap();
    for i in 0..3 {
        client
            .insert_raw_event(&json!({ "event_type": "track_ended", "track_id": old_id, "started_at": i, "listen_pct": 1.0 }))
            .unwrap();
    }

    // insert_raw_event não espera o WAL (sem wait=true): aguarda os 3
    // ficarem visíveis antes de mover.
    for _ in 0..50 {
        let n = client.scroll_play_event_track_ids().unwrap().iter().filter(|(_, t)| *t == old_id).count();
        if n == 3 {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    let report = move_tracks(&client, root, &Journal::in_dir(&root.join(".data")), &[old_id], &MoveTarget::Playlist("Favoritas".into()));
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    assert_eq!(report.moved, 1, "{report:?}");
    assert!(report.items[0].detail.is_none(), "{report:?}");

    let dst = root.join("Favoritas/Artista/2020 - Álbum [tidal]/01 - Faixa.flac");
    let new_id = path_to_id(&dst);
    assert_eq!(report.items[0].new_track_id.as_deref(), Some(new_id.to_string().as_str()));
    assert!(dst.is_file() && dst.with_extension("lrc").is_file());
    assert!(dst.parent().unwrap().join("cover.jpg").is_file());
    assert!(!root.join("Rap/Artista").exists() && root.join("Rap").is_dir());

    let (payload, vector) = client.get_point_with_vectors(new_id).unwrap().expect("ponto novo");
    assert_eq!(payload["path"], dst.to_string_lossy().as_ref());
    assert_eq!(payload["genre"], "Favoritas");
    assert_eq!(payload["lyrics_text"], "verso");
    assert_eq!(vector["mert"].as_array().unwrap().len(), 768);
    assert_eq!(vector["lyrics"].as_array().unwrap().len(), 1024);
    assert!(client.get_point_with_vectors(old_id).unwrap().is_none());
    assert!(!root.join(".data").join(Journal::FILE).exists(), "registro de intenção apagado no fim");

    let enr = client.get_enrichment(new_id).unwrap();
    assert_eq!(enr["liked_at"], 123);
    assert_eq!(enr["play_count"], 7);
    assert_eq!(client.get_enrichment(old_id).unwrap(), json!({}));

    let events = client.scroll_play_event_track_ids().unwrap();
    assert_eq!(events.iter().filter(|(_, t)| *t == new_id).count(), 3);
    assert_eq!(events.iter().filter(|(_, t)| *t == old_id).count(), 0);

    // De novo para o mesmo lugar: "já estava lá", nada muda.
    let again = move_tracks(&client, root, &Journal::disabled(), &[new_id], &MoveTarget::Playlist("Favoritas".into()));
    assert_eq!(again.items[0].status, MoveStatus::AlreadyThere);

    // Limpeza do que o teste gravou.
    let pids: Vec<_> = events.into_iter().filter(|(_, t)| *t == new_id).map(|(p, _)| p).collect();
    let _ = ureq::post("http://localhost:6333/collections/play_events/points/delete")
        .send_json(json!({ "points": pids }));
    client.delete_enrichment(new_id).unwrap();
    client.delete_points(&[new_id]).unwrap();
}

/// Tirar a marca `[tidal]` da pasta do álbum (decisão do CEO, 17/10/2026): a
/// faixa fica na mesma playlist, no caminho normal, com vetores, letra
/// externa, like e plays no id novo; a pasta marcada some com a capa.
/// cargo test -p library-indexer --test relocate_qdrant -- --ignored --nocapture
#[test]
#[ignore = "requires running Qdrant on localhost:6333"]
fn tirar_marca_tidal_leva_identidade_e_some_com_a_pasta() {
    let client = QdrantClient::new("http://localhost:6333");
    if !client.is_healthy() {
        eprintln!("Qdrant not available, skipping");
        return;
    }
    client.ensure_collection().unwrap();
    client.ensure_play_events_collection().unwrap();
    client.ensure_enrichments_collection().unwrap();

    let tmp = tempfile::tempdir().unwrap();
    let root = tmp.path();
    let album = root.join("Jazz/Artista/2020 - Álbum [tidal]");
    fs::create_dir_all(&album).unwrap();
    let a = album.join("01 - A.flac");
    let b = album.join("02 - B.flac");
    fs::write(&a, b"flac-a").unwrap();
    fs::write(&b, b"flac-b").unwrap();
    fs::write(album.join("01 - A.lrc"), b"[00:01.00] verso").unwrap();
    fs::write(album.join("cover.jpg"), b"jpg").unwrap();

    let mert: Vec<f32> = (0..768).map(|i| i as f32 / 768.0).collect();
    let lyrics: Vec<f32> = (0..1024).map(|i| (i % 5) as f32).collect();
    let (id_a, id_b) = (path_to_id(&a), path_to_id(&b));
    for (id, p, t) in [(id_a, &a, "A"), (id_b, &b, "B")] {
        client
            .upsert_point_raw(
                id,
                &json!({ "path": p.to_string_lossy(), "filename": p.file_name().unwrap().to_string_lossy(),
                         "genre": "Jazz", "title": t, "lyrics_text": "verso", "lyrics_status": "plain",
                         "mtime": 1, "size_bytes": 6, "embedding_status": "done" }),
                &json!({ "mert": mert, "lyrics": lyrics }),
            )
            .unwrap();
    }
    client.set_enrichment(id_a, json!({ "liked_at": 456, "energy": 0.3 })).unwrap();
    client
        .insert_raw_event(&json!({ "event_type": "track_ended", "track_id": id_a, "started_at": 1, "listen_pct": 1.0 }))
        .unwrap();
    for _ in 0..50 {
        if client.scroll_play_event_track_ids().unwrap().iter().any(|(_, t)| *t == id_a) {
            break;
        }
        std::thread::sleep(std::time::Duration::from_millis(100));
    }

    let target = MoveTarget::UnmarkTidal { playlist: "Jazz".into() };
    let report = move_tracks(&client, root, &Journal::in_dir(&root.join(".data")), &[id_a, id_b], &target);
    println!("{}", serde_json::to_string_pretty(&report).unwrap());
    assert_eq!(report.moved, 2, "{report:?}");
    assert_eq!(report.dest_playlist, "Jazz");

    let clean = root.join("Jazz/Artista/2020 - Álbum");
    let (na, nb) = (clean.join("01 - A.flac"), clean.join("02 - B.flac"));
    assert!(na.is_file() && nb.is_file() && clean.join("01 - A.lrc").is_file());
    assert!(clean.join("cover.jpg").is_file(), "capa acompanha o álbum");
    assert!(!album.exists(), "a pasta com a marca some quando esvazia");

    let new_a = path_to_id(&na);
    let (payload, vector) = client.get_point_with_vectors(new_a).unwrap().expect("ponto novo");
    assert_eq!(payload["path"], na.to_string_lossy().as_ref());
    assert_eq!(payload["genre"], "Jazz");
    assert_eq!(payload["lyrics_text"], "verso");
    assert_eq!(vector["lyrics"].as_array().unwrap().len(), 1024);
    assert!(client.get_point_with_vectors(id_a).unwrap().is_none());
    assert_eq!(client.get_enrichment(new_a).unwrap()["liked_at"], 456);
    let events = client.scroll_play_event_track_ids().unwrap();
    assert_eq!(events.iter().filter(|(_, t)| *t == new_a).count(), 1);

    // Pedido repetido: já está no caminho normal, nada muda.
    let again = move_tracks(&client, root, &Journal::disabled(), &[new_a], &target);
    assert_eq!(again.items[0].status, MoveStatus::AlreadyThere);
    // Faixa de outra playlist no mesmo pedido: falha sem tocar em nada.
    let other = move_tracks(&client, root, &Journal::disabled(), &[new_a], &MoveTarget::UnmarkTidal { playlist: "Rap".into() });
    assert_eq!(other.items[0].status, MoveStatus::Failed);
    assert!(na.is_file());

    let pids: Vec<_> = events.into_iter().filter(|(_, t)| *t == new_a).map(|(p, _)| p).collect();
    let _ = ureq::post("http://localhost:6333/collections/play_events/points/delete")
        .send_json(json!({ "points": pids }));
    let new_b = path_to_id(&nb);
    client.delete_enrichment(new_a).unwrap();
    client.delete_points(&[new_a, new_b]).unwrap();
}
