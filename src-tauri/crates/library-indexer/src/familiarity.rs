//! Familiaridade por faixa e mistura conhecida/descoberta do autoplay (v0.2.92).
//!
//! Evidência: `docs/contexto/14102026-autoplay-forense.md`. No autoplay desde
//! a v0.2.75 o CEO pula 92%, e o que separa aceite de pulo é FAMILIARIDADE,
//! não som: faixa nunca ouvida até o fim = 96% de pulo; 10+ vezes = 64%;
//! curtida 72% x 94%. 72% das escolhas do motor eram faixas ouvidas até o fim
//! no máximo 2 vezes.
//!
//! Três peças, todas puras e testadas aqui:
//! - [`FamiliarityIndex`]: por faixa, quantas vezes foi ouvida até o fim
//!   (`ended`) e quantas vezes o motor a serviu (`motor_attempts`). Mesma
//!   definição de aceite da régua (`scripts/metrics/autoplay_regua.py`,
//!   função `familiaridade`): aceite = `track_ended`, pulo = `track_skipped`.
//!   A fixture `scripts/metrics/fixtures/familiaridade.json` é lida pelos
//!   testes dos dois lados e trava a equivalência.
//! - [`interleave_mix`]: a sequência servida intercala conhecida, conhecida,
//!   descoberta ([`MIX_KNOWN_RUN`] conhecidas por descoberta). O padrão é
//!   ancorado num `slot` que o frontend mantém por rodada de rádio, por isso
//!   sobrevive ao re-fetch pós-pulo (não recomeça em "conhecida, conhecida").
//! - [`never_ends`]: faixa servida pelo motor [`NEVER_ENDS_MIN_ATTEMPTS`]
//!   vezes ou mais, nunca ouvida até o fim em todo o histórico e sem like,
//!   sai das candidatas de autoplay e station. Ao contrário do negativo do
//!   `behavioral_signals` (decai em ~2 semanas), este filtro não expira:
//!   sai só quando a faixa for ouvida até o fim (por outra via) ou curtida.

use serde_json::Value;
use std::collections::HashMap;

/// Faixa "conhecida": ouvida até o fim pelo menos esta quantidade de vezes
/// (qualquer origem, todo o histórico), ou curtida. Na forense, a faixa de
/// 3-9 aceites tem pulo de 88% contra 94-96% das de 0-2.
pub const KNOWN_MIN_ENDED: u32 = 3;

/// Padrão da mistura: quantas conhecidas antes de cada descoberta (2:1 =
/// conhecida, conhecida, descoberta). Ciclo de `MIX_KNOWN_RUN + 1` slots.
pub const MIX_KNOWN_RUN: usize = 2;

/// Faixa servida pelo motor (autoplay/station) pelo menos esta quantidade de
/// vezes, com zero escutas até o fim e sem like, sai das candidatas.
pub const NEVER_ENDS_MIN_ATTEMPTS: u32 = 3;

/// Origens que contam como "o motor serviu esta faixa".
pub const MOTOR_ORIGINS: &[&str] = &["autoplay", "station"];

/// Aparelho cujo pulo em 0 ms não conta como tentativa: no S24 há 80 pulos
/// do autoplay com posição 0 ms (forense, "Anomalias"), suspeitos de arquivo
/// que não toca no celular. Punir a faixa por isso a tiraria do desktop, onde
/// ela toca. No desktop o caso é raro (1 ocorrência) e conta normalmente.
pub const UNPLAYABLE_SUSPECT_DEVICE: &str = "s24";

/// Aceite na régua: a faixa terminou.
pub fn is_accept(p: &Value) -> bool {
    p["event_type"].as_str() == Some("track_ended")
}

/// Pulo na régua.
pub fn is_skip(p: &Value) -> bool {
    p["event_type"].as_str() == Some("track_skipped")
}

/// Pulo em 0 ms no aparelho suspeito (ver [`UNPLAYABLE_SUSPECT_DEVICE`]).
/// `end_position_ms` ausente não é 0: conta como tentativa.
fn is_unplayable_suspect(p: &Value) -> bool {
    is_skip(p)
        && p["device_id"].as_str() == Some(UNPLAYABLE_SUSPECT_DEVICE)
        && p["end_position_ms"].as_u64() == Some(0)
}

/// O evento conta como uma vez em que o motor serviu a faixa.
pub fn counts_as_motor_attempt(p: &Value) -> bool {
    (is_accept(p) || is_skip(p))
        && p["origin"].as_str().is_some_and(|o| MOTOR_ORIGINS.contains(&o))
        && !is_unplayable_suspect(p)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct TrackFamiliarity {
    /// Vezes ouvida até o fim (qualquer origem, todo o histórico).
    pub ended: u32,
    /// Vezes servida pelo autoplay/station (aceite ou pulo).
    pub motor_attempts: u32,
}

/// "Conhecida" para a mistura: ouvida até o fim [`KNOWN_MIN_ENDED`]+ vezes ou curtida.
pub fn is_known(f: TrackFamiliarity, liked: bool) -> bool {
    liked || f.ended >= KNOWN_MIN_ENDED
}

/// Faixa que o motor insiste em servir e que nunca termina (ver doc do módulo).
pub fn never_ends(f: TrackFamiliarity, liked: bool) -> bool {
    !liked && f.ended == 0 && f.motor_attempts >= NEVER_ENDS_MIN_ATTEMPTS
}

/// Contagens por faixa, derivadas de `play_events`. Chave sempre u64: os
/// eventos legados com `track_id` em texto (11, `search_click`/`queue_add`)
/// ficam fora.
#[derive(Debug, Clone, Default)]
pub struct FamiliarityIndex {
    by_track: HashMap<u64, TrackFamiliarity>,
}

impl FamiliarityIndex {
    pub fn from_payloads<'a>(payloads: impl IntoIterator<Item = &'a Value>) -> Self {
        let mut idx = Self::default();
        for p in payloads {
            idx.observe(p);
        }
        idx
    }

    /// Incorpora um evento (montagem inicial e atualização incremental quando
    /// um evento novo é gravado).
    pub fn observe(&mut self, p: &Value) {
        let Some(tid) = p["track_id"].as_u64() else {
            return;
        };
        let accept = is_accept(p);
        let attempt = counts_as_motor_attempt(p);
        if !accept && !attempt {
            return;
        }
        let e = self.by_track.entry(tid).or_default();
        if accept {
            e.ended += 1;
        }
        if attempt {
            e.motor_attempts += 1;
        }
    }

    pub fn get(&self, track_id: u64) -> TrackFamiliarity {
        self.by_track.get(&track_id).copied().unwrap_or_default()
    }

    pub fn len(&self) -> usize {
        self.by_track.len()
    }

    pub fn is_empty(&self) -> bool {
        self.by_track.is_empty()
    }

    /// Faixas que hoje cairiam no filtro de nunca-termina (sem olhar like).
    pub fn never_ends_candidates(&self) -> impl Iterator<Item = u64> + '_ {
        self.by_track
            .iter()
            .filter(|(_, f)| never_ends(**f, false))
            .map(|(id, _)| *id)
    }
}

/// O slot `slot` (0-based, contado na rodada de rádio) é de descoberta?
/// Padrão: K, K, D, K, K, D...
pub fn slot_is_discovery(slot: usize) -> bool {
    slot % (MIX_KNOWN_RUN + 1) == MIX_KNOWN_RUN
}

/// Separa as candidatas (já filtradas e na ordem do re-rank, com o score de
/// cada uma) em conhecidas e descoberta. A ordem do re-rank é mantida nos
/// dois grupos; nas conhecidas, a familiaridade (`ended`) desempata score
/// igual. Sort estável: empate total preserva a ordem de entrada.
pub fn partition_known<T>(
    ranked: Vec<(f64, T)>,
    id_of: impl Fn(&T) -> u64,
    fam: &FamiliarityIndex,
    liked: impl Fn(u64) -> bool,
) -> (Vec<T>, Vec<T>) {
    let mut known: Vec<(f64, u32, T)> = Vec::new();
    let mut discovery: Vec<T> = Vec::new();
    for (score, t) in ranked {
        let id = id_of(&t);
        let f = fam.get(id);
        if is_known(f, liked(id)) {
            known.push((score, f.ended, t));
        } else {
            discovery.push(t);
        }
    }
    known.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.1.cmp(&a.1))
    });
    (known.into_iter().map(|(_, _, t)| t).collect(), discovery)
}

/// Intercala os dois grupos a partir de `start_slot`: slot de descoberta
/// ([`slot_is_discovery`]) tira do topo da descoberta, os outros do topo das
/// conhecidas. Grupo esgotado = completa com o outro. Devolve tudo (quem chama
/// trunca no `limit`).
pub fn interleave_mix<T>(known: Vec<T>, discovery: Vec<T>, start_slot: usize) -> Vec<T> {
    let mut k = known.into_iter();
    let mut d = discovery.into_iter();
    let mut out = Vec::new();
    let mut slot = start_slot;
    loop {
        let next = if slot_is_discovery(slot) {
            d.next().or_else(|| k.next())
        } else {
            k.next().or_else(|| d.next())
        };
        match next {
            Some(t) => out.push(t),
            None => return out,
        }
        slot += 1;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const FIXTURE: &str = include_str!("../../../../scripts/metrics/fixtures/familiaridade.json");

    #[test]
    fn fixture_compartilhada_com_a_regua_bate() {
        let fx: Value = serde_json::from_str(FIXTURE).unwrap();
        let events = fx["events"].as_array().unwrap();
        let idx = FamiliarityIndex::from_payloads(events.iter());
        let liked: Vec<u64> = fx["liked"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap())
            .collect();
        let expected = fx["expected"].as_object().unwrap();
        for (k, exp) in expected {
            let id: u64 = k.parse().unwrap();
            let f = idx.get(id);
            let lk = liked.contains(&id);
            assert_eq!(f.ended, exp["ended"].as_u64().unwrap() as u32, "ended de {id}");
            assert_eq!(
                f.motor_attempts,
                exp["motor_attempts"].as_u64().unwrap() as u32,
                "motor_attempts de {id}"
            );
            assert_eq!(is_known(f, lk), exp["known"].as_bool().unwrap(), "known de {id}");
            assert_eq!(never_ends(f, lk), exp["never_ends"].as_bool().unwrap(), "never_ends de {id}");
        }
        // Texto, não-play e album_seq pulado não criam entrada.
        let com_contagem = expected
            .values()
            .filter(|e| e["ended"].as_u64() != Some(0) || e["motor_attempts"].as_u64() != Some(0))
            .count();
        assert_eq!(idx.len(), com_contagem);
    }

    #[test]
    fn track_id_acima_de_i64_max_conta_e_texto_nao() {
        let big: u64 = u64::MAX - 7;
        let mut idx = FamiliarityIndex::default();
        idx.observe(&json!({"event_type": "track_ended", "track_id": big, "origin": "manual"}));
        idx.observe(&json!({"event_type": "track_ended", "track_id": big.to_string(), "origin": "manual"}));
        assert_eq!(idx.get(big).ended, 1);
        assert_eq!(idx.len(), 1);
    }

    #[test]
    fn observe_incremental_equivale_a_montagem_inteira() {
        let fx: Value = serde_json::from_str(FIXTURE).unwrap();
        let events = fx["events"].as_array().unwrap();
        let inteira = FamiliarityIndex::from_payloads(events.iter());
        let mut incremental = FamiliarityIndex::from_payloads(events[..5].iter());
        for e in &events[5..] {
            incremental.observe(e);
        }
        assert_eq!(inteira.by_track, incremental.by_track);
    }

    #[test]
    fn nunca_termina_exige_tres_tentativas_zero_fins_e_sem_like() {
        let f = |ended, motor_attempts| TrackFamiliarity { ended, motor_attempts };
        assert!(never_ends(f(0, 3), false));
        assert!(!never_ends(f(0, 2), false), "duas tentativas ainda não bastam");
        assert!(!never_ends(f(1, 9), false), "uma escuta até o fim tira do filtro");
        assert!(!never_ends(f(0, 9), true), "like tira do filtro");
    }

    #[test]
    fn pulo_zero_ms_do_s24_nao_conta_mas_do_desktop_conta() {
        let s24 = json!({"event_type": "track_skipped", "track_id": 1, "origin": "autoplay",
                         "end_position_ms": 0, "device_id": "s24"});
        let desk = json!({"event_type": "track_skipped", "track_id": 1, "origin": "autoplay",
                          "end_position_ms": 0, "device_id": "cmr-auto"});
        let s24_tocou = json!({"event_type": "track_skipped", "track_id": 1, "origin": "station",
                               "end_position_ms": 1, "device_id": "s24"});
        assert!(!counts_as_motor_attempt(&s24));
        assert!(counts_as_motor_attempt(&desk));
        assert!(counts_as_motor_attempt(&s24_tocou));
        let idx = FamiliarityIndex::from_payloads([&s24, &s24, &s24, &s24]);
        assert!(!never_ends(idx.get(1), false), "quatro pulos 0 ms do S24 não condenam a faixa");
    }

    #[test]
    fn conhecida_por_tres_fins_ou_like() {
        let f = |ended| TrackFamiliarity { ended, motor_attempts: 0 };
        assert!(!is_known(f(2), false));
        assert!(is_known(f(3), false));
        assert!(is_known(f(0), true));
    }

    fn fam(pairs: &[(u64, u32)]) -> FamiliarityIndex {
        let mut idx = FamiliarityIndex::default();
        for &(id, ended) in pairs {
            for _ in 0..ended {
                idx.observe(&json!({"event_type": "track_ended", "track_id": id, "origin": "manual"}));
            }
        }
        idx
    }

    #[test]
    fn particao_mantem_ordem_do_rerank_e_desempata_conhecidas_por_familiaridade() {
        // 1: 3 fins; 2: 0; 3: 10 fins; 4: curtida; 5: 1 fim; 6: 5 fins
        let idx = fam(&[(1, 3), (3, 10), (5, 1), (6, 5)]);
        let ranked = vec![(0.9, 1u64), (0.8, 2), (0.8, 3), (0.7, 4), (0.6, 5), (0.9, 6)];
        // Entrada já vem ordenada pelo re-rank na prática; aqui 6 tem score
        // igual ao 1 e mais familiaridade: sobe no empate.
        let (known, disc) = partition_known(ranked, |t| *t, &idx, |id| id == 4);
        assert_eq!(known, vec![6, 1, 3, 4]);
        assert_eq!(disc, vec![2, 5]);
    }

    #[test]
    fn intercalacao_dois_para_um() {
        let k = vec!["k1", "k2", "k3", "k4"];
        let d = vec!["d1", "d2"];
        assert_eq!(interleave_mix(k, d, 0), vec!["k1", "k2", "d1", "k3", "k4", "d2"]);
    }

    #[test]
    fn intercalacao_com_grupos_desiguais_completa_com_o_outro() {
        assert_eq!(
            interleave_mix(vec!["k1"], vec!["d1", "d2", "d3"], 0),
            vec!["k1", "d1", "d2", "d3"],
            "conhecidas acabaram: só descoberta"
        );
        assert_eq!(
            interleave_mix(vec!["k1", "k2", "k3", "k4"], Vec::<&str>::new(), 0),
            vec!["k1", "k2", "k3", "k4"],
            "sem descoberta: só conhecidas"
        );
        assert!(interleave_mix(Vec::<u8>::new(), Vec::new(), 2).is_empty());
    }

    #[test]
    fn padrao_sobrevive_ao_refetch_pelo_slot() {
        // Rodada com lookahead 1: cada fetch devolve UMA faixa e o slot anda.
        // Depois de um pulo, o re-fetch chega com o slot corrente — não
        // recomeça em "conhecida, conhecida".
        let servir = |slot: usize| interleave_mix(vec!["k"], vec!["d"], slot)[0];
        let sequencia: Vec<&str> = (0..7).map(servir).collect();
        assert_eq!(sequencia, vec!["k", "k", "d", "k", "k", "d", "k"]);
        // Re-fetch pós-pulo no slot 2 (o terceiro da rodada) serve descoberta.
        assert_eq!(servir(2), "d");
        assert_eq!(interleave_mix(vec!["k1", "k2"], vec!["d1"], 2), vec!["d1", "k1", "k2"]);
        assert_eq!(interleave_mix(vec!["k1", "k2"], vec!["d1"], 1), vec!["k1", "d1", "k2"]);
    }

    #[test]
    fn slots_de_descoberta() {
        let d: Vec<usize> = (0..9).filter(|s| slot_is_discovery(*s)).collect();
        assert_eq!(d, vec![2, 5, 8]);
    }

    #[test]
    fn custo_do_caminho_quente_e_desprezivel() {
        // ~2000 faixas no acervo, 10k eventos: montagem + 1000 partições de
        // 120 candidatas. Medido aqui pra travar a ordem de grandeza (o custo
        // real no autoplay é a lookup, a montagem roda uma vez por processo).
        let mut events = Vec::new();
        for i in 0..10_000u64 {
            events.push(json!({"event_type": if i % 3 == 0 { "track_ended" } else { "track_skipped" },
                               "track_id": i % 2000, "origin": "autoplay", "end_position_ms": 1000}));
        }
        let t0 = std::time::Instant::now();
        let idx = FamiliarityIndex::from_payloads(events.iter());
        let build = t0.elapsed();
        let t1 = std::time::Instant::now();
        for _ in 0..1000 {
            let ranked: Vec<(f64, u64)> = (0..120u64).map(|i| (1.0 - i as f64 / 120.0, i * 13)).collect();
            let (k, d) = partition_known(ranked, |t| *t, &idx, |_| false);
            let _ = interleave_mix(k, d, 1);
        }
        let per_call = t1.elapsed() / 1000;
        eprintln!("familiaridade: montagem {build:?}, partição+mistura {per_call:?} por chamada");
        assert!(per_call < std::time::Duration::from_millis(5));
    }
}
