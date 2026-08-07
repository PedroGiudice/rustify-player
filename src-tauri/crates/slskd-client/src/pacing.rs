//! pacing.rs — guard-rails de rede: rate limit de busca + detector de rede
//! fria (spec §6). PURO, clock injetável — nenhum `Instant::now()` interno,
//! nenhum `sleep`. Aplicado no backend, não na UI (a UI é substituível e o
//! MCP bridge chama comandos direto; guard-rail em UI seria decorativo).

use std::time::{Duration, Instant};

const SEARCH_MIN_INTERVAL: Duration = Duration::from_secs(4);
const SEARCH_BURST: usize = 2;
const SEARCH_MAX_PER_HOUR: usize = 40;
const EMPTY_STREAK_TRIP: u8 = 3;
const COLD_BASE: Duration = Duration::from_secs(10 * 60);
const COLD_MAX: Duration = Duration::from_secs(60 * 60);
const SEARCH_HISTORY_WINDOW: Duration = Duration::from_secs(60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PaceDecision {
    Go,
    Cooldown(u64),
    Cold(u64),
    HourlyCapped,
}

pub struct Pacer {
    /// Timestamps de buscas na última janela de 1h (poda a cada chamada).
    search_history: Vec<Instant>,
    /// Zeros consecutivos em `record_result`. Reseta em qualquer resultado
    /// não-vazio ou ao disparar o cold.
    empty_streak: u8,
    /// `Some` enquanto a rede estiver em cold-down.
    cold_until: Option<Instant>,
    /// Penalidade do PRÓXIMO trip — começa em `COLD_BASE`, dobra a cada
    /// reincidência (§6.2), capada em `COLD_MAX`.
    cold_penalty: Duration,
    /// Já disparou cold pelo menos uma vez nesta sessão do Pacer — controla
    /// a duplicação em `record_result`.
    has_tripped_before: bool,
}

impl Pacer {
    pub fn new() -> Self {
        Self {
            search_history: Vec::new(),
            empty_streak: 0,
            cold_until: None,
            cold_penalty: COLD_BASE,
            has_tripped_before: false,
        }
    }

    /// Poda `search_history` para a janela de 1h corrente.
    fn prune_history(&mut self, now: Instant) {
        self.search_history
            .retain(|&t| now.saturating_duration_since(t) < SEARCH_HISTORY_WINDOW);
    }

    /// Quantas buscas caem dentro de `window` terminando em `now`.
    fn count_recent(&self, now: Instant, window: Duration) -> usize {
        self.search_history
            .iter()
            .filter(|&&t| now.saturating_duration_since(t) < window)
            .count()
    }

    pub fn check(&mut self, now: Instant, force: bool) -> PaceDecision {
        if !force {
            if let Some(cold_until) = self.cold_until {
                if now < cold_until {
                    return PaceDecision::Cold(cold_until.duration_since(now).as_secs());
                }
            }
        }

        self.prune_history(now);
        if self.search_history.len() >= SEARCH_MAX_PER_HOUR {
            return PaceDecision::HourlyCapped;
        }

        let recent = self.count_recent(now, SEARCH_MIN_INTERVAL);
        if recent >= SEARCH_BURST {
            let oldest_in_window = self
                .search_history
                .iter()
                .filter(|&&t| now.saturating_duration_since(t) < SEARCH_MIN_INTERVAL)
                .min()
                .copied();
            if let Some(oldest) = oldest_in_window {
                let elapsed = now.saturating_duration_since(oldest);
                let wait = SEARCH_MIN_INTERVAL.saturating_sub(elapsed).as_secs().max(1);
                return PaceDecision::Cooldown(wait);
            }
        }

        PaceDecision::Go
    }

    pub fn record_search(&mut self, now: Instant) {
        self.prune_history(now);
        self.search_history.push(now);
    }

    /// `responses == 0` três vezes seguidas dispara cold. Reincidência
    /// (cold já disparado antes nesta sessão do Pacer) dobra a penalidade
    /// do próximo trip, capada em `COLD_MAX`.
    pub fn record_result(&mut self, now: Instant, responses: u32) {
        if responses == 0 {
            self.empty_streak = self.empty_streak.saturating_add(1);
            if self.empty_streak >= EMPTY_STREAK_TRIP {
                if self.has_tripped_before {
                    self.cold_penalty = (self.cold_penalty * 2).min(COLD_MAX);
                }
                self.cold_until = Some(now + self.cold_penalty);
                self.has_tripped_before = true;
                self.empty_streak = 0;
            }
        } else {
            self.empty_streak = 0;
        }
    }
}

impl Default for Pacer {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cooldown_with_injected_clock() {
        let mut pacer = Pacer::new();
        let t0 = Instant::now();
        assert_eq!(pacer.check(t0, false), PaceDecision::Go);
        pacer.record_search(t0);
        assert_eq!(pacer.check(t0, false), PaceDecision::Go);
        pacer.record_search(t0);
        match pacer.check(t0, false) {
            PaceDecision::Cooldown(secs) => assert!(secs > 0 && secs <= 4),
            other => panic!("expected Cooldown, got {other:?}"),
        }
        let t1 = t0 + Duration::from_secs(4);
        assert_eq!(pacer.check(t1, false), PaceDecision::Go);
    }

    #[test]
    fn search_41_in_hour_blocked() {
        let mut pacer = Pacer::new();
        let t0 = Instant::now();
        for i in 0..40u64 {
            let t = t0 + Duration::from_secs(i * 10);
            assert_eq!(
                pacer.check(t, false),
                PaceDecision::Go,
                "search {i} should be allowed"
            );
            pacer.record_search(t);
        }
        let t41 = t0 + Duration::from_secs(40 * 10);
        assert_eq!(pacer.check(t41, false), PaceDecision::HourlyCapped);
    }

    #[test]
    fn three_empty_trips_cold() {
        let mut pacer = Pacer::new();
        let t0 = Instant::now();
        pacer.record_result(t0, 0);
        pacer.record_result(t0 + Duration::from_secs(5), 0);
        pacer.record_result(t0 + Duration::from_secs(10), 0);
        match pacer.check(t0 + Duration::from_secs(11), false) {
            PaceDecision::Cold(secs) => assert!(secs > 0),
            other => panic!("expected Cold, got {other:?}"),
        }
    }

    #[test]
    fn force_bypasses_cold_not_min_interval() {
        let mut pacer = Pacer::new();
        let t0 = Instant::now();
        pacer.record_result(t0, 0);
        pacer.record_result(t0 + Duration::from_secs(5), 0);
        pacer.record_result(t0 + Duration::from_secs(10), 0);
        let t_cold = t0 + Duration::from_secs(11);
        assert!(matches!(pacer.check(t_cold, false), PaceDecision::Cold(_)));

        assert_eq!(pacer.check(t_cold, true), PaceDecision::Go);

        pacer.record_search(t_cold);
        pacer.record_search(t_cold);
        match pacer.check(t_cold, true) {
            PaceDecision::Cooldown(_) => {}
            other => panic!("expected Cooldown even with force=true, got {other:?}"),
        }
    }

    #[test]
    fn cold_penalty_doubles_on_reincidence() {
        let mut pacer = Pacer::new();
        let t0 = Instant::now();
        let trip1_at = t0 + Duration::from_secs(10);
        pacer.record_result(t0, 0);
        pacer.record_result(t0 + Duration::from_secs(5), 0);
        pacer.record_result(trip1_at, 0);
        let first_cold_secs = match pacer.check(trip1_at, false) {
            PaceDecision::Cold(secs) => secs,
            other => panic!("expected Cold, got {other:?}"),
        };
        assert_eq!(first_cold_secs, 600);

        let base = t0 + Duration::from_secs(700);
        let trip2_at = base + Duration::from_secs(10);
        pacer.record_result(base, 0);
        pacer.record_result(base + Duration::from_secs(5), 0);
        pacer.record_result(trip2_at, 0);
        let second_cold_secs = match pacer.check(trip2_at, false) {
            PaceDecision::Cold(secs) => secs,
            other => panic!("expected Cold, got {other:?}"),
        };
        assert_eq!(second_cold_secs, 1200);
    }
}
