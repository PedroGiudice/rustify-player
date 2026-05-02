# Lyrics Scraping Pipeline — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch lyrics for ~510 tracks missing coverage via a multi-source fallback chain (Musixmatch → Genius → Vagalume → Letras.com), then forced-align plain-text results into timestamped LRC.

**Architecture:** Single Python script (`scripts/scrape_lyrics.py`) that reads `data/tracks_pending_v2.csv`, tries each source in order, saves plain text to `data/scraped-texts/{id}.txt` and synced LRC to `data/scraped-lyrics/{id}.lrc`. Sources that return synced lyrics (Musixmatch via syncedlyrics) write LRC directly. Plain-text results are aligned later via the existing `scripts/align_lyrics.py` (wav2vec2 MMS forced alignment on BS-Roformer stems). A report CSV tracks what was found where.

**Tech Stack:** Python 3, `syncedlyrics` (Musixmatch+lrclib+others), `lyricsgenius` (Genius API+scraping), `requests`+`BeautifulSoup4` (Vagalume API, Letras.com scraping)

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `scripts/scrape_lyrics.py` | Create | Main orchestrator: reads CSV, runs fallback chain, writes outputs |
| `scripts/lyrics_sources.py` | Create | Source implementations: Musixmatch, Genius, Vagalume, Letras.com |
| `scripts/align_lyrics.py` | Modify (minor) | Accept `--texts-dir` flag to read scraped texts instead of hardcoded `data/output-v2/` |
| `data/scraped-texts/` | Create (dir) | Plain-text lyrics from Genius/Vagalume/Letras.com, one file per track: `{id}.txt` |
| `data/scraped-lyrics/` | Create (dir) | Final LRC files from all sources, one file per track: `{id}.lrc` |
| `data/scrape-report.csv` | Create (output) | Report: `id,title,artist,source,type(synced|plain|miss),timestamp` |

---

### Task 1: Install dependencies and create lyrics_sources.py with Musixmatch provider

**Files:**
- Create: `scripts/lyrics_sources.py`

**Dependencies needed:** `syncedlyrics`, `lyricsgenius`, `requests`, `beautifulsoup4`

- [ ] **Step 1: Install dependencies**

```bash
uv pip install --python /home/opc/rustify-player/.venv/bin/python syncedlyrics lyricsgenius requests beautifulsoup4
```

If no .venv exists:
```bash
uv venv /home/opc/rustify-player/.venv
uv pip install --python /home/opc/rustify-player/.venv/bin/python syncedlyrics lyricsgenius requests beautifulsoup4
```

- [ ] **Step 2: Create lyrics_sources.py with base interface and Musixmatch provider**

```python
#!/usr/bin/env python3
"""Lyrics source providers for the scraping pipeline."""

from dataclasses import dataclass


@dataclass
class LyricsResult:
    text: str
    source: str
    synced: bool  # True = text is LRC with timestamps


def fetch_musixmatch(title: str, artist: str) -> LyricsResult | None:
    """Fetch synced lyrics via syncedlyrics (Musixmatch provider)."""
    import syncedlyrics
    query = f"{artist} {title}"
    lrc = syncedlyrics.search(query, providers=["musixmatch"])
    if lrc and lrc.strip():
        return LyricsResult(text=lrc, source="musixmatch", synced=True)
    return None
```

- [ ] **Step 3: Smoke test Musixmatch provider**

```bash
cd /home/opc/rustify-player
.venv/bin/python -c "
from scripts.lyrics_sources import fetch_musixmatch
r = fetch_musixmatch('Bohemian Rhapsody', 'Queen')
print(f'source={r.source} synced={r.synced} lines={len(r.text.splitlines())}' if r else 'MISS')
"
```

Expected: `source=musixmatch synced=True lines=~70` or similar hit.

- [ ] **Step 4: Commit**

```bash
git add scripts/lyrics_sources.py
git commit -m "feat(lyrics): add lyrics_sources.py with Musixmatch provider via syncedlyrics"
```

---

### Task 2: Add Genius provider

**Files:**
- Modify: `scripts/lyrics_sources.py`

**Pre-requisite:** Genius API token. The user needs to create one at https://genius.com/api-clients. Store in env var `GENIUS_API_TOKEN`.

- [ ] **Step 1: Add Genius provider to lyrics_sources.py**

Append to `scripts/lyrics_sources.py`:

```python
def fetch_genius(title: str, artist: str) -> LyricsResult | None:
    """Fetch plain lyrics from Genius (API search + HTML scraping)."""
    import os
    token = os.environ.get("GENIUS_API_TOKEN")
    if not token:
        return None
    import lyricsgenius
    genius = lyricsgenius.Genius(token, verbose=False, remove_section_headers=False)
    genius.skip_non_songs = True
    genius.excluded_terms = ["(Remix)", "(Live)"]
    try:
        song = genius.search_song(title, artist)
    except Exception:
        return None
    if song and song.lyrics and len(song.lyrics) > 20:
        # lyricsgenius prepends song title and appends "Embed" — clean up
        text = song.lyrics
        # Remove trailing "NNNEmbed" pattern
        import re
        text = re.sub(r"\d*Embed$", "", text).strip()
        # Remove leading title line if present (e.g., "Song Title Lyrics")
        lines = text.split("\n")
        if lines and lines[0].lower().endswith("lyrics"):
            lines = lines[1:]
        text = "\n".join(lines).strip()
        if text:
            return LyricsResult(text=text, source="genius", synced=False)
    return None
```

- [ ] **Step 2: Smoke test Genius provider**

```bash
cd /home/opc/rustify-player
GENIUS_API_TOKEN="<token>" .venv/bin/python -c "
from scripts.lyrics_sources import fetch_genius
r = fetch_genius('Bohemian Rhapsody', 'Queen')
print(f'source={r.source} synced={r.synced} lines={len(r.text.splitlines())}' if r else 'MISS')
"
```

Expected: `source=genius synced=False lines=~70`

- [ ] **Step 3: Commit**

```bash
git add scripts/lyrics_sources.py
git commit -m "feat(lyrics): add Genius provider (API + scraping)"
```

---

### Task 3: Add Vagalume provider

**Files:**
- Modify: `scripts/lyrics_sources.py`

**Pre-requisite:** Vagalume API key. Register at https://auth.vagalume.com.br/ then create credential at https://auth.vagalume.com.br/settings/api/. Store in env var `VAGALUME_API_KEY`.

- [ ] **Step 1: Add Vagalume provider to lyrics_sources.py**

Append to `scripts/lyrics_sources.py`:

```python
def fetch_vagalume(title: str, artist: str) -> LyricsResult | None:
    """Fetch plain lyrics from Vagalume official API."""
    import os
    import json
    import urllib.parse
    import urllib.request
    api_key = os.environ.get("VAGALUME_API_KEY")
    if not api_key:
        return None
    params = urllib.parse.urlencode({
        "art": artist,
        "mus": title,
        "apikey": api_key,
    })
    url = f"https://api.vagalume.com.br/search.php?{params}"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "RustifyPlayer/0.1.0"})
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read())
    except Exception:
        return None
    if data.get("type") == "exact" or data.get("type") == "aprox":
        mus = data.get("mus")
        if mus and len(mus) > 0:
            text = mus[0].get("text", "")
            if text and len(text) > 20:
                return LyricsResult(text=text, source="vagalume", synced=False)
    return None
```

- [ ] **Step 2: Smoke test Vagalume provider**

```bash
cd /home/opc/rustify-player
VAGALUME_API_KEY="<key>" .venv/bin/python -c "
from scripts.lyrics_sources import fetch_vagalume
r = fetch_vagalume('A Palo Seco', 'Belchior')
print(f'source={r.source} synced={r.synced} lines={len(r.text.splitlines())}' if r else 'MISS')
"
```

Expected: `source=vagalume synced=False lines=~20` (Belchior is very well covered on Vagalume)

- [ ] **Step 3: Commit**

```bash
git add scripts/lyrics_sources.py
git commit -m "feat(lyrics): add Vagalume provider (official API)"
```

---

### Task 4: Add Letras.com scraper provider

**Files:**
- Modify: `scripts/lyrics_sources.py`

- [ ] **Step 1: Add Letras.com provider to lyrics_sources.py**

Append to `scripts/lyrics_sources.py`:

```python
def fetch_letras(title: str, artist: str) -> LyricsResult | None:
    """Fetch plain lyrics by scraping Letras.mus.br."""
    import re
    import unicodedata
    import time
    import requests
    from bs4 import BeautifulSoup

    def slugify(text):
        text = unicodedata.normalize("NFD", text)
        text = "".join(c for c in text if unicodedata.category(c) != "Mn")
        text = text.lower()
        text = re.sub(r"[^a-z0-9]+", "-", text)
        return text.strip("-")

    artist_slug = slugify(artist)
    title_slug = slugify(title)
    url = f"https://www.letras.mus.br/{artist_slug}/{title_slug}/"

    try:
        resp = requests.get(url, headers={"User-Agent": "RustifyPlayer/0.1.0"}, timeout=10)
        if resp.status_code != 200:
            return None
    except Exception:
        return None

    soup = BeautifulSoup(resp.text, "html.parser")
    lyrics_div = soup.find("div", class_="cnt-letra")
    if not lyrics_div:
        return None

    paragraphs = lyrics_div.find_all("p")
    if not paragraphs:
        return None

    text = "\n\n".join(p.get_text("\n") for p in paragraphs).strip()
    if len(text) < 20:
        return None

    return LyricsResult(text=text, source="letras.com", synced=False)
```

- [ ] **Step 2: Smoke test Letras.com provider**

```bash
cd /home/opc/rustify-player
.venv/bin/python -c "
from scripts.lyrics_sources import fetch_letras
r = fetch_letras('A Palo Seco', 'Belchior')
print(f'source={r.source} synced={r.synced} lines={len(r.text.splitlines())}' if r else 'MISS')
"
```

Expected: `source=letras.com synced=False lines=~20`

- [ ] **Step 3: Commit**

```bash
git add scripts/lyrics_sources.py
git commit -m "feat(lyrics): add Letras.com scraper provider"
```

---

### Task 5: Create main orchestrator script (scrape_lyrics.py)

**Files:**
- Create: `scripts/scrape_lyrics.py`

- [ ] **Step 1: Create scrape_lyrics.py**

```python
#!/usr/bin/env python3
"""Fetch lyrics for pending tracks via multi-source fallback chain.

Sources (in order): Musixmatch (synced) → Genius (plain) → Vagalume (plain) → Letras.com (plain)

Input: data/tracks_pending_v2.csv (no header): id, path, title, artist, album, duration_ms
Output:
  - data/scraped-lyrics/{id}.lrc   (synced results written directly)
  - data/scraped-texts/{id}.txt    (plain results for later forced alignment)
  - data/scrape-report.csv         (id, title, artist, source, type, timestamp)

Usage:
    python3 scripts/scrape_lyrics.py
    python3 scripts/scrape_lyrics.py --id 863            # single track
    python3 scripts/scrape_lyrics.py --source genius      # single source only
    python3 scripts/scrape_lyrics.py --dry-run            # report what would be fetched
"""

import argparse
import csv
import os
import sys
import time
from datetime import datetime, timezone

PENDING_CSV = "data/tracks_pending_v2.csv"
LYRICS_DIR = "data/scraped-lyrics"
TEXTS_DIR = "data/scraped-texts"
REPORT_CSV = "data/scrape-report.csv"

SOURCES = ["musixmatch", "genius", "vagalume", "letras"]

# Delay between requests per source to avoid rate limiting
SOURCE_DELAYS = {
    "musixmatch": 2.0,
    "genius": 1.5,
    "vagalume": 0.5,
    "letras": 2.0,
}


def load_source_fn(name):
    from scripts.lyrics_sources import (
        fetch_musixmatch, fetch_genius, fetch_vagalume, fetch_letras,
    )
    return {
        "musixmatch": fetch_musixmatch,
        "genius": fetch_genius,
        "vagalume": fetch_vagalume,
        "letras": fetch_letras,
    }[name]


def already_done(track_id):
    return (
        os.path.exists(os.path.join(LYRICS_DIR, f"{track_id}.lrc"))
        or os.path.exists(os.path.join(TEXTS_DIR, f"{track_id}.txt"))
    )


def save_result(track_id, result):
    if result.synced:
        os.makedirs(LYRICS_DIR, exist_ok=True)
        path = os.path.join(LYRICS_DIR, f"{track_id}.lrc")
        with open(path, "w", encoding="utf-8") as f:
            f.write(result.text)
    else:
        os.makedirs(TEXTS_DIR, exist_ok=True)
        path = os.path.join(TEXTS_DIR, f"{track_id}.txt")
        with open(path, "w", encoding="utf-8") as f:
            f.write(result.text)


def append_report(track_id, title, artist, source, result_type):
    write_header = not os.path.exists(REPORT_CSV)
    with open(REPORT_CSV, "a", encoding="utf-8", newline="") as f:
        w = csv.writer(f)
        if write_header:
            w.writerow(["id", "title", "artist", "source", "type", "timestamp"])
        w.writerow([
            track_id, title, artist, source, result_type,
            datetime.now(timezone.utc).isoformat(timespec="seconds"),
        ])


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--id", help="Process single track ID")
    parser.add_argument("--source", choices=SOURCES, help="Use only this source")
    parser.add_argument("--dry-run", action="store_true", help="Report without fetching")
    parser.add_argument("--force", action="store_true", help="Overwrite existing results")
    args = parser.parse_args()

    with open(PENDING_CSV, newline="", encoding="utf-8") as f:
        tracks = list(csv.reader(f))

    if args.id:
        tracks = [t for t in tracks if t[0] == args.id]
        if not tracks:
            print(f"Track {args.id} not found in {PENDING_CSV}", file=sys.stderr)
            sys.exit(1)

    sources = [args.source] if args.source else SOURCES
    source_fns = {s: load_source_fn(s) for s in sources}

    stats = {"synced": 0, "plain": 0, "miss": 0, "skip": 0}
    total = len(tracks)

    for i, row in enumerate(tracks):
        track_id = row[0]
        title = row[2]
        artist = row[3]

        if not args.force and already_done(track_id):
            stats["skip"] += 1
            continue

        if args.dry_run:
            print(f"[{i+1}/{total}] WOULD FETCH {track_id}: {artist} - {title}")
            continue

        result = None
        for src_name in sources:
            fn = source_fns[src_name]
            try:
                result = fn(title, artist)
            except Exception as e:
                print(f"  [{src_name}] ERROR: {e}", file=sys.stderr)
                result = None

            if result:
                break

            delay = SOURCE_DELAYS.get(src_name, 1.0)
            time.sleep(delay)

        pct = (i + 1) / total * 100

        if result:
            save_result(track_id, result)
            rtype = "synced" if result.synced else "plain"
            stats[rtype] += 1
            append_report(track_id, title, artist, result.source, rtype)
            print(f"[{i+1}/{total} {pct:.0f}%] {rtype.upper():6s} [{result.source}] {artist} - {title}")
        else:
            stats["miss"] += 1
            append_report(track_id, title, artist, "none", "miss")
            print(f"[{i+1}/{total} {pct:.0f}%] MISS   {artist} - {title}")

    print(f"\nDone. synced={stats['synced']} plain={stats['plain']} miss={stats['miss']} skip={stats['skip']} total={total}")


if __name__ == "__main__":
    main()
```

- [ ] **Step 2: Test with --dry-run**

```bash
cd /home/opc/rustify-player
.venv/bin/python scripts/scrape_lyrics.py --dry-run | head -20
```

Expected: list of `WOULD FETCH` lines for each pending track.

- [ ] **Step 3: Test single track**

```bash
cd /home/opc/rustify-player
GENIUS_API_TOKEN="<token>" VAGALUME_API_KEY="<key>" \
  .venv/bin/python scripts/scrape_lyrics.py --id 10
```

Expected: fetches "A Palo Seco" by Belchior from one of the sources.

- [ ] **Step 4: Commit**

```bash
git add scripts/scrape_lyrics.py
git commit -m "feat(lyrics): add multi-source lyrics scraper orchestrator"
```

---

### Task 6: Adapt align_lyrics.py to accept scraped texts

**Files:**
- Modify: `scripts/align_lyrics.py`

The existing `align_lyrics.py` reads texts from hardcoded `data/output-v2/` (Whisper output). We need it to also work with `data/scraped-texts/` (plain text from Genius/Vagalume/Letras.com) and output to `data/scraped-lyrics/`.

- [ ] **Step 1: Add --texts-dir and --output-dir flags to align_lyrics.py**

In `scripts/align_lyrics.py`, replace the hardcoded constants and argparse section:

Change lines 24-27:
```python
STEMS_DIR = "data/stems-v2"
TEXTS_DIR = "data/output-v2"
OUTPUT_DIR = "data/lyrics-v2"
```

To defaults only, and add argparse flags in `main()`. After the existing argparse lines (around line 176), add:

```python
parser.add_argument("--texts-dir", default="data/output-v2", help="Directory with .txt files")
parser.add_argument("--output-dir", default="data/lyrics-v2", help="Output directory for .lrc files")
parser.add_argument("--stems-dir", default="data/stems-v2", help="Directory with vocal stems")
```

Then replace all uses of the global constants `STEMS_DIR`, `TEXTS_DIR`, `OUTPUT_DIR` in `align_track()` with function parameters. Change the `align_track` signature to:

```python
def align_track(track_id, force=False, stems_dir="data/stems-v2", texts_dir="data/output-v2", output_dir="data/lyrics-v2"):
    stem_path = os.path.join(stems_dir, f"{track_id}_vocals.wav")
    text_path = os.path.join(texts_dir, f"{track_id}.txt")
    out_path = os.path.join(output_dir, f"{track_id}.lrc")
```

And update all call sites in `main()` to pass `args.stems_dir`, `args.texts_dir`, `args.output_dir`.

- [ ] **Step 2: Verify existing behavior unchanged**

```bash
cd /home/opc/rustify-player
.venv/bin/python scripts/align_lyrics.py --id 137
```

Expected: same result as before (uses default dirs).

- [ ] **Step 3: Test with scraped texts dir**

```bash
cd /home/opc/rustify-player
.venv/bin/python scripts/align_lyrics.py --texts-dir data/scraped-texts --output-dir data/scraped-lyrics --id 10
```

Expected: either "aligned" (if stem and text exist) or "no_stem"/"no_text" (if not yet available).

- [ ] **Step 4: Commit**

```bash
git add scripts/align_lyrics.py
git commit -m "feat(lyrics): make align_lyrics.py configurable for scraped texts"
```

---

### Task 7: Full batch run and deploy LRCs to cmr-auto

**Files:**
- No new files — operational task

This task runs the pipeline end-to-end and deploys results.

- [ ] **Step 1: Run the scraper on all pending tracks**

```bash
cd /home/opc/rustify-player
GENIUS_API_TOKEN="<token>" VAGALUME_API_KEY="<key>" \
  .venv/bin/python scripts/scrape_lyrics.py 2>&1 | tee /tmp/scrape-run.log
```

This will take ~30-60 minutes depending on rate limits. Monitor progress.

- [ ] **Step 2: Check report**

```bash
cd /home/opc/rustify-player
# Summary by source
cut -d',' -f4 data/scrape-report.csv | sort | uniq -c | sort -rn
# Summary by type
cut -d',' -f5 data/scrape-report.csv | sort | uniq -c | sort -rn
```

Expected: majority from musixmatch (synced), remainder from genius/vagalume/letras (plain), some misses.

- [ ] **Step 3: Run forced alignment on plain-text results**

Only needed for tracks that got plain text (not synced). The scraper already saved synced results as `.lrc` in `data/scraped-lyrics/`.

```bash
cd /home/opc/rustify-player
.venv/bin/python scripts/align_lyrics.py \
  --texts-dir data/scraped-texts \
  --output-dir data/scraped-lyrics \
  --workers 4
```

Note: this requires BS-Roformer stems in `data/stems-v2/`. Tracks without stems will be skipped (`no_stem`).

- [ ] **Step 4: Deploy LRCs to cmr-auto**

```bash
# Combine all LRC sources into one directory
mkdir -p /tmp/all-lyrics
cp data/lyrics/*.lrc /tmp/all-lyrics/ 2>/dev/null       # existing lrclib
cp data/scraped-lyrics/*.lrc /tmp/all-lyrics/ 2>/dev/null # new scraped+aligned

# Deploy to cmr-auto via rsync
rsync -avz /tmp/all-lyrics/ cmr-auto@100.102.249.9:/home/cmr-auto/Music/.lyrics/
```

- [ ] **Step 5: Commit data and report**

```bash
git add data/scrape-report.csv
git commit -m "feat(lyrics): batch scrape results — report"
```

Note: the actual .lrc and .txt files in `data/scraped-lyrics/` and `data/scraped-texts/` should be gitignored (binary-adjacent data). Only the report is committed.

---

## Notes

- **API keys required:** `GENIUS_API_TOKEN` and `VAGALUME_API_KEY` must be set before running. These are free to obtain.
- **Stems dependency:** Forced alignment (Task 6-7) requires BS-Roformer vocal stems in `data/stems-v2/`. If stems don't exist for a track, alignment is skipped. Stem generation is a separate pipeline (Modal GPU) not covered in this plan.
- **Rate limiting:** The script has per-source delays (`SOURCE_DELAYS`). If a source starts returning errors, increase the delay for that source.
- **Incremental:** The script skips tracks that already have results (`already_done` check). Safe to re-run after fixing issues or adding new tracks.
- **lrclib not in chain:** Already exhausted for existing tracks. Only Musixmatch, Genius, Vagalume, Letras.com are in the fallback chain.
