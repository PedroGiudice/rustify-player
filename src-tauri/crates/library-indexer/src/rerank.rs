//! Re-rank híbrido de recomendações: rank MERT + similaridade de "vibe".
//!
//! O score MERT bruto NÃO é confiável como valor absoluto — o espaço é
//! anisotrópico e desbalanceado (sims intra-cluster rap chegam a 0.744+
//! enquanto o melhor candidato techno contra um seed techno fica em ~0.599).
//! Por isso o re-rank usa apenas a POSIÇÃO do rank MERT, normalizada, e
//! mistura com a similaridade de vibe derivada dos enrichments
//! (energy/valence/mood_tags — cobertura 100% do acervo desde 2026-07-11)
//! mais o genre do payload da track.
//!
//! Pesos (v1, calibráveis — ver CMR-123):
//! - score final = 0.5·mert_norm + 0.5·vibe_similarity
//! - vibe = 0.35·energy + 0.25·valence + 0.30·jaccard(moods) + 0.10·genre_eq

use crate::types::Track;
use serde_json::Value;
use std::collections::HashMap;

/// Perfil de "vibe" de uma track, derivado do enrichment + genre do payload.
#[derive(Debug, Clone, Default)]
pub struct VibeProfile {
    pub energy: Option<f64>,
    pub valence: Option<f64>,
    pub moods: Vec<String>,
    pub genre: Option<String>,
}

/// Extrai um [`VibeProfile`] do payload de enrichment (`track_enrichments`).
/// Campos ausentes ou malformados viram `None`/vec vazio — nunca erro.
pub fn vibe_from_enrichment(enrichment: &Value, genre: Option<String>) -> VibeProfile {
    let moods = enrichment["mood_tags"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter_map(|v| v.as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default();
    VibeProfile {
        energy: enrichment["energy"].as_f64(),
        valence: enrichment["valence"].as_f64(),
        moods,
        genre,
    }
}

/// Similaridade de Jaccard entre dois conjuntos de mood tags:
/// |interseção| / |união|. União vazia retorna 0.
pub fn jaccard(a: &[String], b: &[String]) -> f64 {
    let sa: std::collections::HashSet<&str> = a.iter().map(String::as_str).collect();
    let sb: std::collections::HashSet<&str> = b.iter().map(String::as_str).collect();
    let union = sa.union(&sb).count();
    if union == 0 {
        return 0.0;
    }
    let inter = sa.intersection(&sb).count();
    inter as f64 / union as f64
}

/// Similaridade de vibe entre seed e candidato, em 0..1:
///
/// `0.35·(1 − |Δenergy|) + 0.25·(1 − |Δvalence|) + 0.30·jaccard(moods) + 0.10·genre_eq`
///
/// Componente com dado ausente em QUALQUER um dos lados vale 0.5 (neutro)
/// vezes o peso — moods ausentes = vec vazio. genre_eq: 1.0 se ambos Some e
/// iguais, 0.0 se ambos Some e diferentes, 0.5 se algum None.
pub fn vibe_similarity(seed: &VibeProfile, cand: &VibeProfile) -> f64 {
    const NEUTRAL: f64 = 0.5;

    let energy = match (seed.energy, cand.energy) {
        (Some(a), Some(b)) => 1.0 - (a - b).abs(),
        _ => NEUTRAL,
    };
    let valence = match (seed.valence, cand.valence) {
        (Some(a), Some(b)) => 1.0 - (a - b).abs(),
        _ => NEUTRAL,
    };
    let moods = if seed.moods.is_empty() || cand.moods.is_empty() {
        NEUTRAL
    } else {
        jaccard(&seed.moods, &cand.moods)
    };
    let genre = match (&seed.genre, &cand.genre) {
        (Some(a), Some(b)) if a == b => 1.0,
        (Some(_), Some(_)) => 0.0,
        _ => NEUTRAL,
    };

    0.35 * energy + 0.25 * valence + 0.30 * moods + 0.10 * genre
}

/// Re-rankeia candidatos misturando rank MERT e vibe do seed.
///
/// A ordem de entrada É o rank MERT: `mert_norm = 1 − i/len` (i = posição).
/// Score final = `0.5·mert_norm + 0.5·vibe_similarity` (pesos v1 calibráveis).
/// Ordenação decrescente e estável (empate preserva ordem de entrada;
/// partial_cmp defensivo — NaN não deve ocorrer, mas cai em Equal em vez de
/// panicar).
pub fn hybrid_rerank(seed: &VibeProfile, candidates: Vec<(Track, VibeProfile)>) -> Vec<Track> {
    hybrid_rerank_pools(seed, vec![candidates])
}

/// Variante multi-pool do [`hybrid_rerank`]: cada pool é uma lista em ordem
/// de rank MERT (ex.: vizinhança pura do seed + gosto global via best_score).
/// Uma track presente em mais de um pool entra UMA vez, com o MELHOR
/// `mert_norm` entre eles.
///
/// A união de pools é o que devolve ao re-rank os candidatos que o pool
/// global não traz: o espaço MERT é anisotrópico e um seed fora do cluster
/// dominante do gosto não coloca a própria vizinhança no top-N global
/// (validado empiricamente: seed de psytrance ia de 0/15 pra 7/15
/// eletrônica no top-15 com o pool duplo).
pub fn hybrid_rerank_pools(
    seed: &VibeProfile,
    pools: Vec<Vec<(Track, VibeProfile)>>,
) -> Vec<Track> {
    // Primeira passada: consolida a união dos pools. `order` preserva a
    // ordem de primeira ocorrência (desempate estável do sort abaixo);
    // `best` guarda o melhor mert_norm visto pra cada track.
    let mut order: Vec<u64> = Vec::new();
    let mut best: HashMap<u64, (f64, Track, VibeProfile)> = HashMap::new();
    for pool in pools {
        let len = pool.len();
        for (i, (track, vibe)) in pool.into_iter().enumerate() {
            let norm = 1.0 - i as f64 / len as f64;
            match best.get_mut(&track.id) {
                Some(entry) => {
                    if norm > entry.0 {
                        entry.0 = norm;
                    }
                }
                None => {
                    order.push(track.id);
                    best.insert(track.id, (norm, track, vibe));
                }
            }
        }
    }
    let mut scored: Vec<(f64, Track)> = order
        .into_iter()
        .filter_map(|id| best.remove(&id))
        .map(|(norm, track, vibe)| {
            let score = 0.5 * norm + 0.5 * vibe_similarity(seed, &vibe);
            (score, track)
        })
        .collect();
    scored.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    scored.into_iter().map(|(_, t)| t).collect()
}

/// [`cap_per_artist`] com piso: aplica o cap e, se o resultado ficar
/// abaixo de `min_len`, completa com os cortados na ordem original —
/// relaxa a diversidade em vez de entregar lista curta (uma station de
/// 40 pedidas não pode voltar com 14 porque os vizinhos MERT se
/// concentram em poucos artistas).
pub fn cap_per_artist_soft(tracks: Vec<Track>, cap: usize, min_len: usize) -> Vec<Track> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    let mut kept: Vec<Track> = Vec::new();
    let mut cut: Vec<Track> = Vec::new();
    for t in tracks {
        let key: String = t
            .artist_name
            .as_deref()
            .unwrap_or("")
            .chars()
            .filter(|c| c.is_alphanumeric())
            .flat_map(char::to_lowercase)
            .collect();
        if key.is_empty() {
            kept.push(t);
            continue;
        }
        let n = counts.entry(key).or_insert(0);
        *n += 1;
        if *n <= cap {
            kept.push(t);
        } else {
            cut.push(t);
        }
    }
    let deficit = min_len.saturating_sub(kept.len());
    kept.extend(cut.into_iter().take(deficit));
    kept
}

/// Limita a `cap` tracks por artista, preservando a ordem.
///
/// Chave = artist_name lowercase só-alfanumérico ("J. Cole" e "J Cole"
/// contam juntos — lixo de metadata real do acervo). Tracks sem artista
/// (None ou vazio pós-normalização) NÃO sofrem cap.
pub fn cap_per_artist(tracks: Vec<Track>, cap: usize) -> Vec<Track> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    tracks
        .into_iter()
        .filter(|t| {
            let key: String = t
                .artist_name
                .as_deref()
                .unwrap_or("")
                .chars()
                .filter(|c| c.is_alphanumeric())
                .flat_map(char::to_lowercase)
                .collect();
            if key.is_empty() {
                return true;
            }
            let n = counts.entry(key).or_insert(0);
            *n += 1;
            *n <= cap
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::EmbeddingStatus;
    use serde_json::json;
    use std::path::PathBuf;

    fn track(id: u64, artist: Option<&str>) -> Track {
        Track {
            id,
            path: PathBuf::new(),
            filename: String::new(),
            title: format!("t{id}"),
            track_number: None,
            disc_number: 1,
            duration_ms: 0,
            album_title: None,
            album_year: None,
            album_cover_path: None,
            artist_name: artist.map(str::to_string),
            genre_name: None,
            tags: Vec::new(),
            sample_rate: 44_100,
            bit_depth: 16,
            channels: 2,
            rg_track_gain: None,
            rg_album_gain: None,
            rg_track_peak: None,
            rg_album_peak: None,
            lufs_integrated: None,
            embedding_status: EmbeddingStatus::Done,
            play_count: 0,
            last_played: None,
            liked_at: None,
            lrc_path: None,
        }
    }

    fn moods(tags: &[&str]) -> Vec<String> {
        tags.iter().map(|s| s.to_string()).collect()
    }

    // ── jaccard ─────────────────────────────────────────────────────────────

    #[test]
    fn jaccard_disjunto_identico_parcial_uniao_vazia() {
        let a = moods(&["a", "b"]);
        let b = moods(&["c"]);
        assert_eq!(jaccard(&a, &b), 0.0, "disjunto");
        assert_eq!(jaccard(&a, &a), 1.0, "idêntico");
        let c = moods(&["b", "c"]);
        assert!((jaccard(&a, &c) - 1.0 / 3.0).abs() < 1e-9, "parcial: 1 de 3");
        assert_eq!(jaccard(&[], &[]), 0.0, "união vazia");
    }

    // ── vibe_from_enrichment ────────────────────────────────────────────────

    #[test]
    fn vibe_from_enrichment_extrai_campos_e_tolera_ausencia() {
        let enr = json!({
            "energy": 0.7,
            "valence": 0.2,
            "mood_tags": ["sombrio", "intenso"]
        });
        let v = vibe_from_enrichment(&enr, Some("Trance".into()));
        assert_eq!(v.energy, Some(0.7));
        assert_eq!(v.valence, Some(0.2));
        assert_eq!(v.moods, moods(&["sombrio", "intenso"]));
        assert_eq!(v.genre.as_deref(), Some("Trance"));

        // Payload nulo/ausente degrada pra perfil vazio, nunca erro.
        let v2 = vibe_from_enrichment(&Value::Null, None);
        assert_eq!(v2.energy, None);
        assert_eq!(v2.valence, None);
        assert!(v2.moods.is_empty());
        assert!(v2.genre.is_none());

        // mood_tags com entradas não-string são ignoradas silenciosamente.
        let v3 = vibe_from_enrichment(&json!({ "mood_tags": ["ok", 42, null] }), None);
        assert_eq!(v3.moods, moods(&["ok"]));
    }

    // ── vibe_similarity ─────────────────────────────────────────────────────

    #[test]
    fn vibe_similarity_dado_ausente_vale_neutro() {
        // Tudo ausente dos dois lados => todos os componentes neutros (0.5)
        // => score exatamente 0.5.
        let vazio = VibeProfile::default();
        assert!((vibe_similarity(&vazio, &vazio) - 0.5).abs() < 1e-9);
    }

    #[test]
    fn vibe_similarity_identica_completa_da_1() {
        let v = VibeProfile {
            energy: Some(0.8),
            valence: Some(0.3),
            moods: moods(&["dark"]),
            genre: Some("Trance".into()),
        };
        assert!((vibe_similarity(&v, &v) - 1.0).abs() < 1e-9);
    }

    #[test]
    fn vibe_similarity_pesa_componentes() {
        // energy oposta (Δ=1.0 → componente 0), resto ausente (neutro 0.5):
        // 0.35·0 + 0.25·0.5 + 0.30·0.5 + 0.10·0.5 = 0.325
        let a = VibeProfile { energy: Some(1.0), ..Default::default() };
        let b = VibeProfile { energy: Some(0.0), ..Default::default() };
        assert!((vibe_similarity(&a, &b) - 0.325).abs() < 1e-9);
    }

    #[test]
    fn vibe_similarity_moods_assimetrico_e_neutro_nao_zero() {
        // Um lado COM moods e o outro sem = dado ausente => componente
        // neutro (0.5), NUNCA jaccard(x, vazio)=0 — ausência de enrichment
        // não é sinal de vibe oposta. Demais componentes ausentes também
        // neutros: score total = 0.5 exato.
        let com = VibeProfile { moods: moods(&["dark", "raw"]), ..Default::default() };
        let sem = VibeProfile::default();
        assert!((vibe_similarity(&com, &sem) - 0.5).abs() < 1e-9);
        assert!((vibe_similarity(&sem, &com) - 0.5).abs() < 1e-9, "simétrico");
    }

    #[test]
    fn vibe_similarity_genre_eq_tres_casos() {
        let base = VibeProfile::default();
        let trance = VibeProfile { genre: Some("Trance".into()), ..Default::default() };
        let rap = VibeProfile { genre: Some("Rap & Hip-Hop".into()), ..Default::default() };

        // Demais componentes neutros contribuem 0.45 (0.35·0.5 + 0.25·0.5 + 0.30·0.5).
        // Ambos Some e iguais → +0.10·1.0 = 0.55
        assert!((vibe_similarity(&trance, &trance) - 0.55).abs() < 1e-9);
        // Ambos Some e diferentes → +0.10·0.0 = 0.45
        assert!((vibe_similarity(&trance, &rap) - 0.45).abs() < 1e-9);
        // Algum None → +0.10·0.5 = 0.50
        assert!((vibe_similarity(&trance, &base) - 0.50).abs() < 1e-9);
    }

    // ── hybrid_rerank ───────────────────────────────────────────────────────

    #[test]
    fn hybrid_rerank_promove_vibe_proxima_sobre_rank_mert_levemente_melhor() {
        let seed = VibeProfile {
            energy: Some(0.9),
            valence: Some(0.9),
            moods: moods(&["energético"]),
            genre: Some("Trance".into()),
        };
        let vibe_oposta = VibeProfile {
            energy: Some(0.1),
            valence: Some(0.1),
            moods: moods(&["melancólico"]),
            genre: Some("Rap & Hip-Hop".into()),
        };
        let vibe_igual = seed.clone();

        // Posição 0 = melhor rank MERT, mas vibe oposta; posição 1 tem a
        // vibe do seed e deve ser promovida.
        let cands = vec![
            (track(1, Some("A")), vibe_oposta),
            (track(2, Some("B")), vibe_igual),
        ];
        let out = hybrid_rerank(&seed, cands);
        assert_eq!(
            out.iter().map(|t| t.id).collect::<Vec<_>>(),
            vec![2, 1],
            "vibe idêntica ao seed deve superar rank MERT levemente melhor"
        );
    }

    #[test]
    fn hybrid_rerank_sem_sinal_de_vibe_mantem_rank_mert() {
        let seed = VibeProfile::default();
        let cands = vec![
            (track(1, None), VibeProfile::default()),
            (track(2, None), VibeProfile::default()),
            (track(3, None), VibeProfile::default()),
        ];
        let out = hybrid_rerank(&seed, cands);
        assert_eq!(out.iter().map(|t| t.id).collect::<Vec<_>>(), vec![1, 2, 3]);
    }

    #[test]
    fn hybrid_rerank_vazio_retorna_vazio() {
        assert!(hybrid_rerank(&VibeProfile::default(), Vec::new()).is_empty());
    }

    // ── hybrid_rerank_pools ─────────────────────────────────────────────────

    #[test]
    fn hybrid_rerank_pools_dedup_por_id_com_melhor_rank() {
        // Pool A: [1, 2]; Pool B: [3, 1] — a track 1 aparece nos dois.
        // Vibes todas neutras → só o mert_norm decide. A track 1 fica com o
        // melhor rank entre os pools (topo do A, norm 1.0) e aparece UMA vez;
        // a track 2 (norm 0.5, pior de todas) sai por último.
        let seed = VibeProfile::default();
        let pools = vec![
            vec![
                (track(1, None), VibeProfile::default()),
                (track(2, None), VibeProfile::default()),
            ],
            vec![
                (track(3, None), VibeProfile::default()),
                (track(1, None), VibeProfile::default()),
            ],
        ];
        let out = hybrid_rerank_pools(&seed, pools);
        let ids: Vec<u64> = out.iter().map(|t| t.id).collect();
        // Empate de score entre 1 e 3 (ambas norm 1.0, vibe neutra): o
        // desempate É contrato — ordem de PRIMEIRA ocorrência na iteração
        // dos pools (por isso a implementação mantém o Vec `order` em vez
        // de iterar o HashMap, cuja ordem varia por execução).
        assert_eq!(ids, vec![1, 3, 2], "dedup + desempate estável: {ids:?}");
    }

    #[test]
    fn hybrid_rerank_pools_promove_vizinhanca_do_seed_de_outro_pool() {
        // Cenário Astrix em miniatura: o pool "gosto global" (A) só tem
        // candidatos de vibe oposta; o pool "vizinhança do seed" (B) traz o
        // candidato de vibe idêntica, que deve subir pro topo da união.
        let seed = VibeProfile {
            energy: Some(0.9),
            valence: Some(0.7),
            moods: moods(&["energetic", "intense"]),
            genre: Some("Trance".into()),
        };
        let oposta = VibeProfile {
            energy: Some(0.2),
            valence: Some(0.3),
            moods: moods(&["melancholic"]),
            genre: Some("Rap & Hip-Hop".into()),
        };
        let pools = vec![
            vec![
                (track(10, Some("Rapper A")), oposta.clone()),
                (track(11, Some("Rapper B")), oposta.clone()),
            ],
            vec![(track(20, Some("Techno X")), seed.clone())],
        ];
        let out = hybrid_rerank_pools(&seed, pools);
        assert_eq!(out[0].id, 20, "vizinho do seed com vibe idêntica vence a união");
    }

    #[test]
    fn hybrid_rerank_e_wrapper_de_pool_unico() {
        // Mesmo input => mesma saída entre hybrid_rerank e a variante pools
        // com um pool só — o wrapper não pode divergir.
        let seed = VibeProfile {
            energy: Some(0.9),
            ..Default::default()
        };
        let cands = || {
            vec![
                (track(1, None), VibeProfile { energy: Some(0.1), ..Default::default() }),
                (track(2, None), VibeProfile { energy: Some(0.9), ..Default::default() }),
                (track(3, None), VibeProfile::default()),
            ]
        };
        let a: Vec<u64> = hybrid_rerank(&seed, cands()).iter().map(|t| t.id).collect();
        let b: Vec<u64> = hybrid_rerank_pools(&seed, vec![cands()]).iter().map(|t| t.id).collect();
        assert_eq!(a, b);
    }

    // ── cap_per_artist ──────────────────────────────────────────────────────

    #[test]
    fn cap_per_artist_preserva_ordem_e_normaliza_grafia() {
        let tracks = vec![
            track(1, Some("J. Cole")),
            track(2, Some("Drake")),
            track(3, Some("J Cole")),  // mesma chave que "J. Cole"
            track(4, Some("j cole")),  // 3ª ocorrência → cortada
            track(5, Some("Drake")),
            track(6, Some("Drake")),   // 3ª ocorrência → cortada
        ];
        let out = cap_per_artist(tracks, 2);
        assert_eq!(out.iter().map(|t| t.id).collect::<Vec<_>>(), vec![1, 2, 3, 5]);
    }

    #[test]
    fn cap_per_artist_soft_completa_ate_o_piso_com_os_cortados() {
        // 6 tracks de só 2 artistas; cap 2 deixaria 4 — abaixo do piso 5.
        // O soft completa com o primeiro cortado na ordem original.
        let tracks = vec![
            track(1, Some("A")),
            track(2, Some("A")),
            track(3, Some("A")), // cortado pelo cap
            track(4, Some("B")),
            track(5, Some("B")),
            track(6, Some("B")), // cortado pelo cap
        ];
        let out = cap_per_artist_soft(tracks, 2, 5);
        assert_eq!(
            out.iter().map(|t| t.id).collect::<Vec<_>>(),
            vec![1, 2, 4, 5, 3],
            "capados primeiro na ordem, depois cortados até o piso"
        );
    }

    #[test]
    fn cap_per_artist_soft_sem_deficit_e_identico_ao_cap() {
        let tracks = vec![
            track(1, Some("A")),
            track(2, Some("A")),
            track(3, Some("A")),
            track(4, Some("B")),
        ];
        // Piso 3 <= resultado do cap (3) => nada é readicionado.
        let out = cap_per_artist_soft(tracks, 2, 3);
        assert_eq!(out.iter().map(|t| t.id).collect::<Vec<_>>(), vec![1, 2, 4]);
    }

    #[test]
    fn cap_per_artist_soft_piso_maior_que_o_total_devolve_tudo() {
        let tracks = vec![track(1, Some("A")), track(2, Some("A")), track(3, Some("A"))];
        let out = cap_per_artist_soft(tracks, 1, 10);
        assert_eq!(out.len(), 3, "não há de onde tirar mais — devolve todas");
    }

    #[test]
    fn cap_per_artist_sem_artista_nao_sofre_cap() {
        let tracks = vec![
            track(1, None),
            track(2, None),
            track(3, None),
            track(4, Some("...")), // só pontuação → chave vazia → sem cap
            track(5, Some("...")),
            track(6, Some("...")),
        ];
        let out = cap_per_artist(tracks, 2);
        assert_eq!(out.len(), 6, "tracks sem artista nunca são cortadas");
    }
}
