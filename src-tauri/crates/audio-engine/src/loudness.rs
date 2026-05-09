//! Loudness normalization helpers (pure math).
//!
//! Translates measured LUFS Integrated values into the linear gain factor
//! that should be fed to the GStreamer `volume` element sitting inside the
//! DSP bin (`norm_gain` stage).
//!
//! # Conventions
//!
//! - All inputs/outputs are in dB (decibels) unless stated.
//! - Gain in dB is converted to linear amplitude via `10^(dB / 20)`.
//! - To protect downstream stages (limiter still has to clamp), the gain is
//!   clamped to `[-24 dB, +24 dB]`. Tracks measured at extreme loudness
//!   values clip to the edge instead of pushing absurd boosts.
//! - NaN / infinite inputs are treated as `0 dB` (passthrough).

/// Hard safety bounds applied to any gain value before exponentiation.
/// Anything outside this range is clamped silently.
pub const MIN_GAIN_DB: f32 = -24.0;
pub const MAX_GAIN_DB: f32 = 24.0;

/// Convert a gain value in decibels to a linear amplitude multiplier.
///
/// ```text
/// linear = 10 ^ (db_clamped / 20)
/// ```
///
/// Non-finite inputs (`NaN`, `±inf`) collapse to `1.0` (unity gain) so we
/// never feed garbage into the GStreamer `volume` element.
#[must_use]
pub fn gain_db_to_linear(db: f32) -> f32 {
    if !db.is_finite() {
        return 1.0;
    }
    let clamped = db.clamp(MIN_GAIN_DB, MAX_GAIN_DB);
    10.0_f32.powf(clamped / 20.0)
}

/// Compute the gain (in dB) needed to bring a track measured at
/// `lufs_integrated` up (or down) to the given `target_lufs`.
///
/// ```text
/// gain_db = target_lufs - lufs_integrated
/// ```
///
/// Result is clamped to `[MIN_GAIN_DB, MAX_GAIN_DB]`. Non-finite inputs
/// return `0.0` (passthrough).
#[must_use]
pub fn lufs_to_gain_db(lufs_integrated: f32, target_lufs: f32) -> f32 {
    if !lufs_integrated.is_finite() || !target_lufs.is_finite() {
        return 0.0;
    }
    (target_lufs - lufs_integrated).clamp(MIN_GAIN_DB, MAX_GAIN_DB)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f32, b: f32, eps: f32) -> bool {
        (a - b).abs() <= eps
    }

    // ----- gain_db_to_linear -------------------------------------------------

    #[test]
    fn zero_db_is_unity() {
        assert!(approx(gain_db_to_linear(0.0), 1.0, 1e-6));
    }

    #[test]
    fn six_db_doubles_amplitude() {
        // +6.0206 dB ≈ 2× linear amplitude
        assert!(approx(gain_db_to_linear(6.0206), 2.0, 1e-3));
    }

    #[test]
    fn minus_six_db_halves_amplitude() {
        assert!(approx(gain_db_to_linear(-6.0206), 0.5, 1e-3));
    }

    #[test]
    fn nan_returns_unity() {
        assert_eq!(gain_db_to_linear(f32::NAN), 1.0);
    }

    #[test]
    fn positive_infinity_returns_unity() {
        assert_eq!(gain_db_to_linear(f32::INFINITY), 1.0);
    }

    #[test]
    fn negative_infinity_returns_unity() {
        assert_eq!(gain_db_to_linear(f32::NEG_INFINITY), 1.0);
    }

    #[test]
    fn very_large_positive_clamps_to_max() {
        // 1000 dB clamps to MAX_GAIN_DB (+24 dB ≈ 15.85 linear).
        let expected = 10.0_f32.powf(MAX_GAIN_DB / 20.0);
        assert!(approx(gain_db_to_linear(1000.0), expected, 1e-3));
    }

    #[test]
    fn very_large_negative_clamps_to_min() {
        // -1000 dB clamps to MIN_GAIN_DB (-24 dB ≈ 0.0631 linear).
        let expected = 10.0_f32.powf(MIN_GAIN_DB / 20.0);
        assert!(approx(gain_db_to_linear(-1000.0), expected, 1e-3));
    }

    // ----- lufs_to_gain_db ---------------------------------------------------

    #[test]
    fn at_target_returns_zero_gain() {
        assert!(approx(lufs_to_gain_db(-14.0, -14.0), 0.0, 1e-6));
    }

    #[test]
    fn quiet_track_needs_positive_gain() {
        // Jazz master at -23 LUFS, target -14 LUFS → +9 dB.
        assert!(approx(lufs_to_gain_db(-23.0, -14.0), 9.0, 1e-6));
    }

    #[test]
    fn loud_track_needs_negative_gain() {
        // Pop master at -8 LUFS, target -14 LUFS → -6 dB.
        assert!(approx(lufs_to_gain_db(-8.0, -14.0), -6.0, 1e-6));
    }

    #[test]
    fn extreme_quiet_clamps_to_max() {
        // Track at -80 LUFS, target -14 → +66 dB requested, clamp to +24.
        assert_eq!(lufs_to_gain_db(-80.0, -14.0), MAX_GAIN_DB);
    }

    #[test]
    fn extreme_loud_clamps_to_min() {
        // Synthetic track at +20 LUFS, target -14 → -34 dB, clamp to -24.
        assert_eq!(lufs_to_gain_db(20.0, -14.0), MIN_GAIN_DB);
    }

    #[test]
    fn non_finite_inputs_passthrough() {
        assert_eq!(lufs_to_gain_db(f32::NAN, -14.0), 0.0);
        assert_eq!(lufs_to_gain_db(-14.0, f32::NAN), 0.0);
        assert_eq!(lufs_to_gain_db(f32::NEG_INFINITY, -14.0), 0.0);
    }

    #[test]
    fn full_pipeline_quiet_track_to_linear() {
        // Track at -23 LUFS, target -14 → +9 dB → 10^(9/20) ≈ 2.818.
        let db = lufs_to_gain_db(-23.0, -14.0);
        let linear = gain_db_to_linear(db);
        assert!(approx(linear, 10.0_f32.powf(9.0 / 20.0), 1e-3));
    }
}
