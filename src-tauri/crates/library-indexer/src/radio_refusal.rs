//! "Fora do rádio" e recusa com escopo (B9, varredura de 31/10/2026).
//!
//! Até aqui o único jeito de uma faixa sair do rádio era o filtro de
//! nunca-termina ([`crate::familiarity::never_ends`]): 3 pulos cedo quando o
//! motor a serviu, zero fins, sem like. Ele não expira e a tela nunca dizia.
//! Este módulo guarda, por faixa, o que o CEO decidiu sobre o rádio:
//!
//! - **nunca no rádio** (`radio_never_at`): sai do autoplay e de TODAS as
//!   stations até ser devolvida;
//! - **fora desta station** (`radio_off_stations`): sai só das stations
//!   listadas (id da station); o autoplay e as outras stations seguem;
//! - **devolvida ao rádio** (`radio_release_skips`/`radio_released_at`): os
//!   pulos cedo contados até a devolução são perdoados. O nunca-termina volta
//!   a valer se ela for pulada cedo mais [`NEVER_ENDS_MIN_ATTEMPTS`] vezes.
//!
//! O estado mora em `track_enrichments`, como o like: o mover para playlist
//! (CMR-298) já leva o enrichment para o id novo, e o export do S24 lê de lá.
//! Não é `play_event`: a semântica dos eventos não muda (sem bump de
//! `SIGNAL_SCHEMA`); o que muda é o conjunto de candidatas que o motor
//! considera.
//!
//! [`NEVER_ENDS_MIN_ATTEMPTS`]: crate::familiarity::NEVER_ENDS_MIN_ATTEMPTS

use crate::familiarity::{self, TrackFamiliarity};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;

pub const FIELD_NEVER_AT: &str = "radio_never_at";
pub const FIELD_OFF_STATIONS: &str = "radio_off_stations";
pub const FIELD_RELEASE_SKIPS: &str = "radio_release_skips";
pub const FIELD_RELEASED_AT: &str = "radio_released_at";

/// O que o CEO decidiu sobre o rádio para uma faixa.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct RadioState {
    /// Unix (s) do "nunca no rádio"; `None` = não recusada.
    pub never_at: Option<i64>,
    /// Ids das stations de onde a faixa saiu ("fora desta station").
    pub off_stations: Vec<String>,
    /// Pulos cedo perdoados na última devolução (baseline do nunca-termina).
    pub release_skips: u32,
    /// Unix (s) da última devolução.
    pub released_at: Option<i64>,
}

impl RadioState {
    /// Lê os quatro campos do payload de `track_enrichments`. Campo ausente,
    /// nulo ou de tipo errado = valor neutro.
    pub fn from_enrichment(p: &Value) -> Self {
        let mut off: Vec<String> = p[FIELD_OFF_STATIONS]
            .as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default();
        off.sort();
        off.dedup();
        Self {
            never_at: p[FIELD_NEVER_AT].as_i64().filter(|t| *t > 0),
            off_stations: off,
            release_skips: p[FIELD_RELEASE_SKIPS].as_u64().map(|n| n.min(u32::MAX as u64) as u32).unwrap_or(0),
            released_at: p[FIELD_RELEASED_AT].as_i64().filter(|t| *t > 0),
        }
    }

    /// Patch com os quatro campos SEMPRE presentes (`null` quando vazio): o
    /// `set_enrichment` mescla por chave, então apagar exige escrever `null`.
    pub fn to_patch(&self) -> Value {
        json!({
            FIELD_NEVER_AT: self.never_at,
            FIELD_OFF_STATIONS: if self.off_stations.is_empty() { Value::Null } else { json!(self.off_stations) },
            FIELD_RELEASE_SKIPS: if self.release_skips == 0 { Value::Null } else { json!(self.release_skips) },
            FIELD_RELEASED_AT: self.released_at,
        })
    }

    /// Recusada pelo CEO no contexto dado (`station` = id da station que
    /// está gerando o lote; `None` = autoplay).
    pub fn refuses(&self, station: Option<&str>) -> bool {
        self.never_at.is_some() || station.is_some_and(|s| self.off_stations.iter().any(|o| o == s))
    }
}

/// Escopo de uma recusa.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Refusal {
    /// "Nunca no rádio": autoplay e todas as stations.
    Never,
    /// "Fora desta station" (id da station).
    Station(String),
}

/// O que devolver ao rádio.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Return {
    /// Tudo: tira as recusas e perdoa os pulos cedo (o "Devolver" da lista).
    All,
    /// Só o "nunca no rádio" (desfazer da recusa).
    Never,
    /// Só a station dada (desfazer do "fora desta station").
    Station(String),
    /// Só perdoa os pulos cedo do nunca-termina.
    Motor,
}

/// Aplica uma recusa.
pub fn refuse(state: &RadioState, scope: &Refusal, now: i64) -> RadioState {
    let mut s = state.clone();
    match scope {
        Refusal::Never => s.never_at = Some(now.max(1)),
        Refusal::Station(id) => {
            if !s.off_stations.iter().any(|o| o == id) {
                s.off_stations.push(id.clone());
                s.off_stations.sort();
            }
        }
    }
    s
}

/// Devolve ao rádio. `early_skips` = pulos cedo contados HOJE para a faixa
/// (familiaridade): é o que a devolução perdoa.
pub fn give_back(state: &RadioState, scope: &Return, early_skips: u32, now: i64) -> RadioState {
    let mut s = state.clone();
    let forgive = |s: &mut RadioState| {
        s.release_skips = early_skips;
        s.released_at = Some(now.max(1));
    };
    match scope {
        Return::All => {
            s.never_at = None;
            s.off_stations.clear();
            forgive(&mut s);
        }
        Return::Never => s.never_at = None,
        Return::Station(id) => s.off_stations.retain(|o| o != id),
        Return::Motor => forgive(&mut s),
    }
    s
}

/// Nunca-termina descontando os pulos perdoados na devolução.
pub fn never_ends_after_release(f: TrackFamiliarity, liked: bool, release_skips: u32) -> bool {
    familiarity::never_ends(
        TrackFamiliarity { early_skips: f.early_skips.saturating_sub(release_skips), ..f },
        liked,
    )
}

/// Estado do rádio de todas as faixas com alguma decisão, para UM contexto
/// (autoplay ou uma station). Montado uma vez por pedido ao motor.
#[derive(Debug, Clone, Default)]
pub struct RadioGate {
    states: HashMap<u64, RadioState>,
    station: Option<String>,
}

impl RadioGate {
    pub fn new(states: HashMap<u64, RadioState>, station: Option<&str>) -> Self {
        Self { states, station: station.map(str::to_string) }
    }

    /// Faixas que o CEO tirou deste contexto (filtro duro, `must_not has_id`).
    pub fn refused_ids(&self) -> Vec<u64> {
        let mut ids: Vec<u64> = self
            .states
            .iter()
            .filter(|(_, s)| s.refuses(self.station.as_deref()))
            .map(|(id, _)| *id)
            .collect();
        ids.sort_unstable();
        ids
    }

    pub fn is_refused(&self, id: u64) -> bool {
        self.states.get(&id).is_some_and(|s| s.refuses(self.station.as_deref()))
    }

    pub fn release_skips(&self, id: u64) -> u32 {
        self.states.get(&id).map(|s| s.release_skips).unwrap_or(0)
    }

    /// Nunca-termina desta faixa, com o perdão da devolução.
    pub fn never_ends(&self, id: u64, f: TrackFamiliarity, liked: bool) -> bool {
        never_ends_after_release(f, liked, self.release_skips(id))
    }

    pub fn state(&self, id: u64) -> Option<&RadioState> {
        self.states.get(&id)
    }

    pub fn states(&self) -> &HashMap<u64, RadioState> {
        &self.states
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fam(ended: u32, early: u32) -> TrackFamiliarity {
        TrackFamiliarity { ended, motor_attempts: early, early_skips: early }
    }

    #[test]
    fn estado_le_campos_e_ignora_lixo() {
        let p = json!({
            "radio_never_at": 1_800_000_000i64,
            "radio_off_stations": ["b", "a", "b", 3],
            "radio_release_skips": 4,
            "radio_released_at": null,
            "liked_at": 5
        });
        let s = RadioState::from_enrichment(&p);
        assert_eq!(s.never_at, Some(1_800_000_000));
        assert_eq!(s.off_stations, vec!["a".to_string(), "b".to_string()]);
        assert_eq!(s.release_skips, 4);
        assert_eq!(s.released_at, None);
        assert_eq!(RadioState::from_enrichment(&json!({})), RadioState::default());
        assert_eq!(
            RadioState::from_enrichment(&json!({"radio_never_at": 0})).never_at,
            None,
            "zero não é recusa"
        );
    }

    #[test]
    fn patch_escreve_null_para_apagar_e_volta_igual() {
        let vazio = RadioState::default().to_patch();
        for k in [FIELD_NEVER_AT, FIELD_OFF_STATIONS, FIELD_RELEASE_SKIPS, FIELD_RELEASED_AT] {
            assert!(vazio.get(k).is_some_and(Value::is_null), "{k} precisa ir como null");
        }
        let s = RadioState {
            never_at: Some(10),
            off_stations: vec!["your-mix".into()],
            release_skips: 3,
            released_at: Some(9),
        };
        assert_eq!(RadioState::from_enrichment(&s.to_patch()), s);
    }

    #[test]
    fn nunca_no_radio_vale_em_todo_contexto_e_station_so_na_propria() {
        let nunca = refuse(&RadioState::default(), &Refusal::Never, 100);
        assert!(nunca.refuses(None));
        assert!(nunca.refuses(Some("qualquer")));
        let fora = refuse(&RadioState::default(), &Refusal::Station("chuva".into()), 100);
        assert!(!fora.refuses(None), "o autoplay segue servindo");
        assert!(!fora.refuses(Some("outra")));
        assert!(fora.refuses(Some("chuva")));
        let duas = refuse(&fora, &Refusal::Station("chuva".into()), 101);
        assert_eq!(duas.off_stations, vec!["chuva".to_string()], "recusar de novo não duplica");
    }

    #[test]
    fn desfazer_tira_so_o_escopo_pedido() {
        let s = refuse(&refuse(&RadioState::default(), &Refusal::Never, 100), &Refusal::Station("a".into()), 100);
        let sem_nunca = give_back(&s, &Return::Never, 9, 200);
        assert_eq!(sem_nunca.never_at, None);
        assert_eq!(sem_nunca.off_stations, vec!["a".to_string()]);
        assert_eq!(sem_nunca.release_skips, 0, "desfazer recusa não perdoa pulos");
        let sem_a = give_back(&s, &Return::Station("a".into()), 9, 200);
        assert!(sem_a.off_stations.is_empty());
        assert_eq!(sem_a.never_at, Some(100));
    }

    #[test]
    fn devolver_perdoa_os_pulos_e_o_filtro_volta_depois_de_mais_tres() {
        // Pulada cedo 3 vezes: fora do rádio.
        assert!(never_ends_after_release(fam(0, 3), false, 0));
        let devolvida = give_back(&RadioState::default(), &Return::All, 3, 500);
        assert_eq!(devolvida.release_skips, 3);
        assert_eq!(devolvida.released_at, Some(500));
        assert!(!never_ends_after_release(fam(0, 3), false, devolvida.release_skips));
        assert!(!never_ends_after_release(fam(0, 5), false, 3), "dois pulos depois ainda não bastam");
        assert!(never_ends_after_release(fam(0, 6), false, 3), "três pulos cedo depois: sai de novo");
        // Like e fim continuam tirando do filtro, com ou sem perdão.
        assert!(!never_ends_after_release(fam(0, 9), true, 0));
        assert!(!never_ends_after_release(fam(1, 9), false, 0));
    }

    #[test]
    fn portao_por_contexto() {
        let mut states = HashMap::new();
        let big = u64::MAX - 5;
        states.insert(big, refuse(&RadioState::default(), &Refusal::Never, 1));
        states.insert(2, refuse(&RadioState::default(), &Refusal::Station("chuva".into()), 1));
        states.insert(3, give_back(&RadioState::default(), &Return::Motor, 4, 1));
        let autoplay = RadioGate::new(states.clone(), None);
        assert_eq!(autoplay.refused_ids(), vec![big]);
        assert!(autoplay.is_refused(big));
        assert!(!autoplay.is_refused(2));
        let chuva = RadioGate::new(states, Some("chuva"));
        assert_eq!(chuva.refused_ids(), vec![2, big]);
        assert_eq!(chuva.release_skips(3), 4);
        assert!(!chuva.never_ends(3, fam(0, 4), false));
        assert!(chuva.never_ends(9, fam(0, 3), false), "faixa sem estado: regra de sempre");
        assert!(RadioGate::default().refused_ids().is_empty());
    }
}
