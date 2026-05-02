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


def fetch_genius(title: str, artist: str) -> LyricsResult | None:
    """Fetch plain lyrics from Genius (official API search + page scraping).

    The API returns song metadata and URL; lyrics text comes from scraping
    the page HTML. Scraping may fail from datacenter IPs (Cloudflare) but
    works from residential IPs.
    """
    import os
    import re
    import requests
    from bs4 import BeautifulSoup

    token = os.environ.get("GENIUS_API_TOKEN")
    if not token:
        return None

    resp = requests.get(
        "https://api.genius.com/search",
        params={"q": f"{artist} {title}"},
        headers={"Authorization": f"Bearer {token}"},
        timeout=10,
    )
    if resp.status_code != 200:
        return None

    hits = resp.json().get("response", {}).get("hits", [])
    if not hits:
        return None

    # Pick best match: prefer exact title match
    song_url = None
    title_lower = title.lower()
    for hit in hits:
        result = hit.get("result", {})
        if result.get("title", "").lower() == title_lower:
            song_url = result.get("url")
            break
    if not song_url:
        song_url = hits[0]["result"].get("url")
    if not song_url:
        return None

    page = requests.get(song_url, headers={
        "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                       "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
    }, timeout=15)
    if page.status_code != 200:
        return None

    soup = BeautifulSoup(page.text, "html.parser")
    containers = soup.find_all("div", attrs={"data-lyrics-container": "true"})
    if not containers:
        return None

    # Each container has lyrics with <br> for line breaks
    parts = []
    for c in containers:
        # Replace <br> with newlines before extracting text
        for br in c.find_all("br"):
            br.replace_with("\n")
        parts.append(c.get_text())
    text = "\n".join(parts).strip()

    # Clean up Genius artifacts
    text = re.sub(r"\d*Embed$", "", text).strip()
    lines = text.split("\n")
    if lines and lines[0].lower().endswith("lyrics"):
        lines = lines[1:]
    text = "\n".join(lines).strip()

    if len(text) < 20:
        return None
    return LyricsResult(text=text, source="genius", synced=False)


def fetch_letras(title: str, artist: str) -> LyricsResult | None:
    """Fetch plain lyrics by scraping Letras.mus.br."""
    import re
    import unicodedata
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
        resp = requests.get(url, headers={
            "User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
                           "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        }, timeout=10)
        if resp.status_code != 200:
            return None
    except Exception:
        return None

    soup = BeautifulSoup(resp.text, "html.parser")
    lyrics_div = soup.find("div", class_="lyric-original")
    if not lyrics_div:
        return None

    paragraphs = lyrics_div.find_all("p")
    if not paragraphs:
        return None

    text = "\n\n".join(p.get_text("\n") for p in paragraphs).strip()
    if len(text) < 20:
        return None

    return LyricsResult(text=text, source="letras.com", synced=False)
