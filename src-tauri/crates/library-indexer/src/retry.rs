//! Retry com backoff exponencial para operações de rede transitórias.
//!
//! Os clients de embedding (MERT via VM, lyrics via cogmem) fazem requests
//! HTTP síncronos. Falhas transitórias — timeout, connection reset, 5xx do
//! servidor — devem ser repetidas algumas vezes antes de marcar a track como
//! `failed`. Falhas determinísticas (4xx, payload inválido) não são repetidas.
//!
//! O retry é genérico sobre o tipo de erro e recebe um predicado
//! `is_transient` que decide se vale a pena tentar de novo. Isso mantém a
//! lógica pura e testável sem precisar de servidor HTTP de verdade.

use std::time::Duration;

/// Política de retry. Sem retry infinito por design: `max_attempts` é o teto
/// absoluto de tentativas (incluindo a primeira).
#[derive(Clone, Copy, Debug)]
pub(crate) struct RetryPolicy {
    /// Número total de tentativas (1 = sem retry). Deve ser >= 1.
    pub max_attempts: u32,
    /// Backoff base entre tentativas. Dobra a cada tentativa (exponencial).
    pub base_delay: Duration,
    /// Teto do backoff para não explodir em esperas absurdas.
    pub max_delay: Duration,
}

impl RetryPolicy {
    /// Política padrão dos embed clients: 3 tentativas, backoff 500ms → 1s → 2s
    /// (a última espera nunca acontece pois não há 4ª tentativa).
    pub(crate) const fn default_embed() -> Self {
        Self {
            max_attempts: 3,
            base_delay: Duration::from_millis(500),
            max_delay: Duration::from_secs(4),
        }
    }

    /// Delay antes da tentativa de índice `attempt` (0-based). Tentativa 0 não
    /// espera; tentativa 1 espera `base_delay`; tentativa 2 espera `2*base`, etc.
    fn delay_for(&self, attempt: u32) -> Duration {
        if attempt == 0 {
            return Duration::ZERO;
        }
        // base * 2^(attempt-1), saturando em max_delay.
        let factor = 1u64.checked_shl(attempt - 1).unwrap_or(u64::MAX);
        let scaled = self
            .base_delay
            .checked_mul(factor.min(u32::MAX as u64) as u32)
            .unwrap_or(self.max_delay);
        scaled.min(self.max_delay)
    }
}

/// Executa `op` com retry sob `policy`. Repete enquanto o erro for transitório
/// (`is_transient` retorna `true`) e ainda houver tentativas. Em erro não
/// transitório, retorna imediatamente sem repetir. `sleep` é injetável para
/// que testes não precisem dormir de verdade.
pub(crate) fn retry_transient<T, E, Op, Tr, Sl>(
    policy: RetryPolicy,
    is_transient: Tr,
    mut sleep: Sl,
    mut op: Op,
) -> Result<T, E>
where
    Op: FnMut() -> Result<T, E>,
    Tr: Fn(&E) -> bool,
    Sl: FnMut(Duration),
{
    let attempts = policy.max_attempts.max(1);
    let mut last_err: Option<E> = None;
    for attempt in 0..attempts {
        if attempt > 0 {
            sleep(policy.delay_for(attempt));
        }
        match op() {
            Ok(v) => return Ok(v),
            Err(e) => {
                if !is_transient(&e) {
                    return Err(e);
                }
                last_err = Some(e);
            }
        }
    }
    // Esgotou as tentativas — devolve o último erro transitório visto.
    Err(last_err.expect("loop roda ao menos uma vez quando max_attempts >= 1"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    /// Erro de teste com flag de transitoriedade.
    #[derive(Debug, PartialEq)]
    struct TestErr {
        transient: bool,
    }

    fn noop_sleep(_: Duration) {}

    #[test]
    fn succeeds_on_first_attempt_without_retry() {
        let calls = RefCell::new(0u32);
        let policy = RetryPolicy::default_embed();
        let result: Result<&str, TestErr> = retry_transient(
            policy,
            |_| true,
            noop_sleep,
            || {
                *calls.borrow_mut() += 1;
                Ok("ok")
            },
        );
        assert_eq!(result.unwrap(), "ok");
        assert_eq!(*calls.borrow(), 1, "não deve repetir quando passa de primeira");
    }

    #[test]
    fn retries_transient_then_succeeds() {
        let calls = RefCell::new(0u32);
        let policy = RetryPolicy {
            max_attempts: 3,
            base_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(1),
        };
        let result: Result<&str, TestErr> = retry_transient(
            policy,
            |e: &TestErr| e.transient,
            noop_sleep,
            || {
                let n = {
                    let mut c = calls.borrow_mut();
                    *c += 1;
                    *c
                };
                if n < 3 {
                    Err(TestErr { transient: true })
                } else {
                    Ok("ok")
                }
            },
        );
        assert_eq!(result.unwrap(), "ok");
        assert_eq!(*calls.borrow(), 3, "deve tentar 3 vezes até o sucesso");
    }

    #[test]
    fn exhausts_retries_and_returns_last_error() {
        let calls = RefCell::new(0u32);
        let policy = RetryPolicy {
            max_attempts: 3,
            base_delay: Duration::from_millis(1),
            max_delay: Duration::from_millis(1),
        };
        let result: Result<(), TestErr> = retry_transient(
            policy,
            |e: &TestErr| e.transient,
            noop_sleep,
            || {
                *calls.borrow_mut() += 1;
                Err(TestErr { transient: true })
            },
        );
        assert!(result.is_err(), "deve falhar após esgotar tentativas");
        assert_eq!(*calls.borrow(), 3, "deve parar exatamente em max_attempts");
    }

    #[test]
    fn does_not_retry_non_transient_error() {
        let calls = RefCell::new(0u32);
        let policy = RetryPolicy::default_embed();
        let result: Result<(), TestErr> = retry_transient(
            policy,
            |e: &TestErr| e.transient,
            noop_sleep,
            || {
                *calls.borrow_mut() += 1;
                Err(TestErr { transient: false })
            },
        );
        assert!(result.is_err());
        assert_eq!(*calls.borrow(), 1, "erro determinístico não deve ser repetido");
    }

    #[test]
    fn delay_grows_exponentially_capped_at_max() {
        let policy = RetryPolicy {
            max_attempts: 6,
            base_delay: Duration::from_millis(500),
            max_delay: Duration::from_secs(4),
        };
        assert_eq!(policy.delay_for(0), Duration::ZERO);
        assert_eq!(policy.delay_for(1), Duration::from_millis(500));
        assert_eq!(policy.delay_for(2), Duration::from_secs(1));
        assert_eq!(policy.delay_for(3), Duration::from_secs(2));
        // 4ª espera seria 4s (==max), 5ª seria 8s mas satura em 4s.
        assert_eq!(policy.delay_for(4), Duration::from_secs(4));
        assert_eq!(policy.delay_for(5), Duration::from_secs(4));
    }
}
