//! LRC lyrics parser.
//!
//! Parses standard `.lrc` files with timestamped lines:
//!
//! ```text
//! [ti:Song Title]
//! [ar:Artist Name]
//! [al:Album Name]
//! [01:23.45] Some lyric text
//! [01:30.00] [Verse 2]
//! ```
//!
//! Metadata tags (`[ti:]`, `[ar:]`, `[al:]`, `[offset:]`, etc.) are skipped.
//! Returns a sorted `Vec<LyricLine>` with millisecond timestamps.

use serde::{Deserialize, Serialize};
use std::path::Path;

use crate::error::IndexerError;

/// A single parsed lyric line.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct LyricLine {
    /// Timestamp in seconds (fractional).
    pub t: f64,
    /// The lyric text.
    pub line: String,
    /// Whether this line looks like a section header (e.g. `[Verse 1]`, `[Chorus]`).
    pub header: bool,
}

/// Parse an `.lrc` file from disk.
pub fn parse_lrc_file(path: &Path) -> Result<Vec<LyricLine>, IndexerError> {
    let content = std::fs::read_to_string(path).map_err(IndexerError::Io)?;
    Ok(parse_lrc(&content))
}

/// Parse LRC content from a string.
pub fn parse_lrc(content: &str) -> Vec<LyricLine> {
    let mut lines = Vec::new();

    for raw_line in content.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // Try to extract all timestamps from the line. LRC allows multiple
        // timestamps per line: `[00:01.00][00:15.00] shared text`.
        let mut timestamps = Vec::new();
        let mut rest = trimmed;

        loop {
            let Some(open) = rest.find('[') else {
                break;
            };
            let Some(close) = rest[open..].find(']') else {
                break;
            };
            let tag_content = &rest[open + 1..open + close];

            // Check if it's a timestamp [mm:ss.xx] or [mm:ss:xx]
            if let Some(ts_ms) = parse_timestamp(tag_content) {
                timestamps.push(ts_ms);
                rest = &rest[open + close + 1..];
            } else if is_metadata_tag(tag_content) {
                // Skip metadata tags entirely
                break;
            } else {
                // Not a timestamp, not a metadata tag -- could be a section
                // marker like [Verse 1] embedded in the text. Stop consuming
                // tags and treat the rest as text.
                break;
            }
        }

        if timestamps.is_empty() {
            continue;
        }

        let text = rest.trim().to_string();
        let header = is_section_header(&text);

        for ts_ms in timestamps {
            let t = ts_ms as f64 / 1000.0;
            lines.push(LyricLine {
                t,
                line: text.clone(),
                header,
            });
        }
    }

    // Sort by timestamp (stable sort preserves line order for equal timestamps).
    lines.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    lines
}

/// Parse a timestamp tag content like `"01:23.45"` or `"01:23:45"` into
/// milliseconds. Supports `mm:ss.xx`, `mm:ss.xxx`, `mm:ss`, and
/// `mm:ss:xx` (colon as decimal separator, used by some tools).
fn parse_timestamp(tag: &str) -> Option<u64> {
    let tag = tag.trim();

    // Must start with digits (to distinguish from metadata tags like "ti:...")
    if !tag.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }

    let colon_pos = tag.find(':')?;
    let minutes: u64 = tag[..colon_pos].parse().ok()?;

    let after_colon = &tag[colon_pos + 1..];

    // Check for second colon (mm:ss:xx format) or dot (mm:ss.xx format)
    let (seconds, frac_ms) = if let Some(dot_pos) = after_colon.find('.') {
        let secs: u64 = after_colon[..dot_pos].parse().ok()?;
        let frac_str = &after_colon[dot_pos + 1..];
        let frac_ms = parse_fractional_ms(frac_str)?;
        (secs, frac_ms)
    } else if let Some(colon2_pos) = after_colon.find(':') {
        // mm:ss:xx format (colon as decimal separator)
        let secs: u64 = after_colon[..colon2_pos].parse().ok()?;
        let frac_str = &after_colon[colon2_pos + 1..];
        let frac_ms = parse_fractional_ms(frac_str)?;
        (secs, frac_ms)
    } else {
        // mm:ss format (no fractional part)
        let secs: u64 = after_colon.parse().ok()?;
        (secs, 0)
    };

    Some(minutes * 60_000 + seconds * 1000 + frac_ms)
}

/// Parse fractional seconds into milliseconds. Handles 1, 2, or 3 digits.
fn parse_fractional_ms(s: &str) -> Option<u64> {
    if s.is_empty() {
        return Some(0);
    }
    // Only parse digits
    let digits: &str = s.trim_end_matches(|c: char| !c.is_ascii_digit());
    if digits.is_empty() {
        return Some(0);
    }
    let val: u64 = digits.parse().ok()?;
    match digits.len() {
        1 => Some(val * 100), // tenths
        2 => Some(val * 10),  // hundredths
        3 => Some(val),       // milliseconds
        _ => None,
    }
}

/// Check if a tag is a metadata tag (not a timestamp). Metadata tags have
/// the form `key:value` where key is alphabetic.
fn is_metadata_tag(tag: &str) -> bool {
    // Known metadata keys
    let known = [
        "ti:", "ar:", "al:", "au:", "by:", "offset:", "re:", "ve:", "length:",
        "id:", "la:",
    ];
    let lower = tag.to_ascii_lowercase();
    known.iter().any(|k| lower.starts_with(k))
}

/// Check if a lyric text looks like a section header: `[Verse 1]`,
/// `[Chorus]`, `[Bridge]`, etc.
fn is_section_header(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.starts_with('[') && trimmed.ends_with(']') && trimmed.len() > 2 {
        let inner = &trimmed[1..trimmed.len() - 1];
        let lower = inner.to_ascii_lowercase();
        // Common section markers
        lower.starts_with("verse")
            || lower.starts_with("chorus")
            || lower.starts_with("bridge")
            || lower.starts_with("outro")
            || lower.starts_with("intro")
            || lower.starts_with("pre-chorus")
            || lower.starts_with("hook")
            || lower.starts_with("interlude")
            || lower.starts_with("refrain")
            || lower.starts_with("coda")
            || lower.starts_with("solo")
            || lower.starts_with("instrumental")
    } else {
        false
    }
}

/// Check if a sidecar `.lrc` file exists for the given audio file path.
/// Returns the path to the `.lrc` file if found, or `None`.
pub fn find_lrc_sidecar(audio_path: &Path) -> Option<std::path::PathBuf> {
    let stem = audio_path.file_stem()?;
    let parent = audio_path.parent()?;
    let lrc_path = parent.join(format!("{}.lrc", stem.to_string_lossy()));
    if lrc_path.is_file() {
        Some(lrc_path)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_basic_lrc() {
        let content = "\
[ti:Test Song]
[ar:Test Artist]
[al:Test Album]

[00:00.00] Intro
[00:05.50] First line
[00:10.00] Second line
[01:00.00] One minute in
";
        let lines = parse_lrc(content);
        assert_eq!(lines.len(), 4);
        assert_eq!(lines[0].t, 0.0);
        assert_eq!(lines[0].line, "Intro");
        assert!(!lines[0].header);

        assert_eq!(lines[1].t, 5.5);
        assert_eq!(lines[1].line, "First line");

        assert_eq!(lines[2].t, 10.0);
        assert_eq!(lines[2].line, "Second line");

        assert_eq!(lines[3].t, 60.0);
        assert_eq!(lines[3].line, "One minute in");
    }

    #[test]
    fn parse_section_headers() {
        let content = "\
[00:00.00] [Verse 1]
[00:10.00] Lyric line
[00:20.00] [Chorus]
[00:30.00] Chorus line
";
        let lines = parse_lrc(content);
        assert_eq!(lines.len(), 4);
        assert!(lines[0].header);
        assert_eq!(lines[0].line, "[Verse 1]");
        assert!(!lines[1].header);
        assert!(lines[2].header);
        assert_eq!(lines[2].line, "[Chorus]");
        assert!(!lines[3].header);
    }

    #[test]
    fn parse_colon_decimal_separator() {
        let content = "[01:23:45] Text\n";
        let lines = parse_lrc(content);
        assert_eq!(lines.len(), 1);
        // 1*60000 + 23*1000 + 450 = 83450
        assert_eq!(lines[0].t, 83.45);
    }

    #[test]
    fn parse_no_fractional() {
        let content = "[01:30] Half past one\n";
        let lines = parse_lrc(content);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].t, 90.0);
    }

    #[test]
    fn parse_three_digit_ms() {
        let content = "[00:01.123] Precise\n";
        let lines = parse_lrc(content);
        assert_eq!(lines.len(), 1);
        assert_eq!(lines[0].t, 1.123);
    }

    #[test]
    fn parse_multiple_timestamps_per_line() {
        let content = "[00:05.00][00:25.00] Repeated line\n";
        let lines = parse_lrc(content);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].t, 5.0);
        assert_eq!(lines[0].line, "Repeated line");
        assert_eq!(lines[1].t, 25.0);
        assert_eq!(lines[1].line, "Repeated line");
    }

    #[test]
    fn skip_metadata_tags() {
        let content = "\
[ti:Title]
[ar:Artist]
[al:Album]
[offset:+100]
[by:Tool]
[re:LRC Editor]
[ve:1.0]
";
        let lines = parse_lrc(content);
        assert!(lines.is_empty());
    }

    #[test]
    fn parse_empty_content() {
        assert!(parse_lrc("").is_empty());
        assert!(parse_lrc("   \n\n  ").is_empty());
    }

    #[test]
    fn parse_empty_lyric_line() {
        let content = "[00:10.00] \n[00:20.00] Has text\n";
        let lines = parse_lrc(content);
        assert_eq!(lines.len(), 2);
        assert_eq!(lines[0].line, "");
        assert_eq!(lines[1].line, "Has text");
    }

    #[test]
    fn find_lrc_sidecar_found() {
        let tmp = tempfile::tempdir().unwrap();
        let flac = tmp.path().join("track.flac");
        let lrc = tmp.path().join("track.lrc");
        std::fs::write(&flac, b"fake").unwrap();
        std::fs::write(&lrc, b"[00:00.00] text").unwrap();

        let found = find_lrc_sidecar(&flac);
        assert_eq!(found, Some(lrc));
    }

    #[test]
    fn find_lrc_sidecar_not_found() {
        let tmp = tempfile::tempdir().unwrap();
        let flac = tmp.path().join("track.flac");
        std::fs::write(&flac, b"fake").unwrap();

        assert!(find_lrc_sidecar(&flac).is_none());
    }

    #[test]
    fn lines_sorted_by_timestamp() {
        let content = "\
[00:30.00] Third
[00:10.00] First
[00:20.00] Second
";
        let lines = parse_lrc(content);
        assert_eq!(lines[0].line, "First");
        assert_eq!(lines[1].line, "Second");
        assert_eq!(lines[2].line, "Third");
    }

    #[test]
    fn parse_timestamp_edge_cases() {
        // Single digit fractional
        assert_eq!(parse_timestamp("00:01.5"), Some(1500));
        // Two digit fractional
        assert_eq!(parse_timestamp("00:01.50"), Some(1500));
        // Three digit fractional
        assert_eq!(parse_timestamp("00:01.500"), Some(1500));
        // Zero
        assert_eq!(parse_timestamp("00:00.00"), Some(0));
        // Large minute value
        assert_eq!(parse_timestamp("99:59.99"), Some(99 * 60_000 + 59 * 1000 + 990));
    }
}
