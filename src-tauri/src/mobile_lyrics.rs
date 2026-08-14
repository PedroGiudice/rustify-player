// Parser LRC do mobile — ESPELHO de crates/library-indexer/src/lyrics.rs
// (fonte da verdade; mudou lá, muda aqui). O library-indexer não compila
// pra Android (deps desktop target-gated), e o parser é std puro — mesma
// solução do weighted_pick_prefix em mobile_intel.rs. Wire idêntico ao
// desktop: `LyricLine { t: f64 segundos, line, header }` (src/tauri.ts).

use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct LyricLine {
    pub t: f64,
    pub line: String,
    pub header: bool,
}

pub fn parse_lrc(content: &str) -> Vec<LyricLine> {
    let mut lines = Vec::new();

    for raw_line in content.lines() {
        let trimmed = raw_line.trim();
        if trimmed.is_empty() {
            continue;
        }

        // LRC permite múltiplos timestamps por linha:
        // `[00:01.00][00:15.00] texto compartilhado`.
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

            if let Some(ts_ms) = parse_timestamp(tag_content) {
                timestamps.push(ts_ms);
                rest = &rest[open + close + 1..];
            } else if is_metadata_tag(tag_content) {
                break;
            } else {
                // Marcador de seção embutido no texto ([Verse 1]) — para de
                // consumir tags e trata o resto como texto.
                break;
            }
        }

        if timestamps.is_empty() {
            continue;
        }

        let text = rest.trim().to_string();
        let header = is_section_header(&text);

        for ts_ms in timestamps {
            lines.push(LyricLine {
                t: ts_ms as f64 / 1000.0,
                line: text.clone(),
                header,
            });
        }
    }

    lines.sort_by(|a, b| a.t.partial_cmp(&b.t).unwrap_or(std::cmp::Ordering::Equal));
    lines
}

/// `"01:23.45"` / `"01:23:45"` / `"01:23"` → milissegundos.
fn parse_timestamp(tag: &str) -> Option<u64> {
    let tag = tag.trim();
    if !tag.starts_with(|c: char| c.is_ascii_digit()) {
        return None;
    }

    let colon_pos = tag.find(':')?;
    let minutes: u64 = tag[..colon_pos].parse().ok()?;
    let after_colon = &tag[colon_pos + 1..];

    let (seconds, frac_ms) = if let Some(dot_pos) = after_colon.find('.') {
        let secs: u64 = after_colon[..dot_pos].parse().ok()?;
        (secs, parse_fractional_ms(&after_colon[dot_pos + 1..])?)
    } else if let Some(colon2_pos) = after_colon.find(':') {
        let secs: u64 = after_colon[..colon2_pos].parse().ok()?;
        (secs, parse_fractional_ms(&after_colon[colon2_pos + 1..])?)
    } else {
        (after_colon.parse().ok()?, 0)
    };

    Some(minutes * 60_000 + seconds * 1000 + frac_ms)
}

fn parse_fractional_ms(s: &str) -> Option<u64> {
    if s.is_empty() {
        return Some(0);
    }
    let digits: &str = s.trim_end_matches(|c: char| !c.is_ascii_digit());
    if digits.is_empty() {
        return Some(0);
    }
    let val: u64 = digits.parse().ok()?;
    match digits.len() {
        1 => Some(val * 100),
        2 => Some(val * 10),
        3 => Some(val),
        _ => None,
    }
}

fn is_metadata_tag(tag: &str) -> bool {
    let known = [
        "ti:", "ar:", "al:", "au:", "by:", "offset:", "re:", "ve:", "length:",
        "id:", "la:",
    ];
    let lower = tag.to_ascii_lowercase();
    known.iter().any(|k| lower.starts_with(k))
}

fn is_section_header(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.starts_with('[') && trimmed.ends_with(']') && trimmed.len() > 2 {
        let lower = trimmed[1..trimmed.len() - 1].to_ascii_lowercase();
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_basico_ordenado_e_metadata_fora() {
        let lrc = "[ti:Song]\n[00:12.50] segunda\n[00:01.00] primeira\n\n[00:30] [Chorus]";
        let lines = parse_lrc(lrc);
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0].t, 1.0);
        assert_eq!(lines[0].line, "primeira");
        assert_eq!(lines[1].t, 12.5);
        assert!(lines[2].header);
    }

    #[test]
    fn multiplos_timestamps_e_colon_decimal() {
        let lines = parse_lrc("[00:01.00][00:15.00] refrão\n[01:02:30] colon");
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[2].t, 62.3);
    }

    #[test]
    fn texto_plano_vira_vazio() {
        assert!(parse_lrc("só texto\nsem timestamp").is_empty());
    }
}
