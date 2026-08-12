#!/usr/bin/env python3
"""Backfill de AQUISIÇÃO de letras para o acervo legado.

O app já resolve o ciclo de uma faixa NOVA: o worker `slsk-lyrics` busca no
lrclib logo após o download e (desde 2026-08-12) grava payload + vetor na hora.
O que ele nunca cobriu é o acervo que entrou antes disso — track copiada à mão,
levas do `baixar_soulseek_teste.py`, tudo que existia antes do Crate. Essas
faixas nunca tiveram UMA tentativa de busca de letra: o backfill que roda no
boot do app (`backfill_lyrics`, pipeline.rs) só embeda letra que JÁ está no
disco ou no payload — ele não vai atrás dela.

Medição que motivou o script (2026-08-12, amostra de 40 das 495 sem letra):
30% tinham letra no lrclib, 25% eram instrumentais legítimas, 45% não existiam.

Roda NA cmr-auto (precisa do disco pra gravar o sidecar e do Qdrant local):

    scp scripts/lyrics/backfill_acquire.py cmr-auto@100.102.249.9:/tmp/
    ssh cmr-auto@100.102.249.9 'python3 /tmp/backfill_acquire.py --limit 20 --dry-run'
    ssh cmr-auto@100.102.249.9 'python3 /tmp/backfill_acquire.py'

Idempotente: pula quem já tem vetor `lyrics`; marca `lyrics_status` no payload
pra não bater no lrclib de novo em faixa que já deu miss (o campo é lido por
este script, não pelo app).
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

QDRANT = "http://127.0.0.1:6333"
COLLECTION = "rustify_tracks"
# cogmem BGE-M3 na VM, mesmo endpoint do LyricsEmbedClient do app.
COGMEM = "http://100.123.73.128:3939"
LRCLIB = "https://lrclib.net"
USER_AGENT = "rustify-player-backfill/1.0 (+https://github.com/PedroGiudice/rustify-player)"

# Espelha MIN_LYRICS_CHARS do pipeline.rs: abaixo disso é placeholder de
# instrumental ou fragmento, não letra.
MIN_LYRICS_CHARS = 20
# Cortesia com um serviço gratuito (o worker do app usa 500ms).
REQUEST_GAP = 0.6

TIMESTAMP_RE = re.compile(r"\[\d{1,2}:\d{2}(?:[.:]\d{1,3})?\]")
METADATA_RE = re.compile(r"^\[[a-z]+:.*\]$", re.IGNORECASE)


def clean_lyrics_text(raw: str) -> str:
    """Remove timestamps e linhas de metadado — espelha lyrics::clean_lyrics_text."""
    out = []
    for line in raw.splitlines():
        line = line.strip()
        if not line or METADATA_RE.match(line):
            continue
        line = TIMESTAMP_RE.sub("", line).strip()
        if line:
            out.append(line)
    return "\n".join(out)


def post(url: str, body: dict, timeout: int = 60) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def put(url: str, body: dict, timeout: int = 60) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="PUT",
    )
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.load(r)


def scroll_candidates() -> list[dict]:
    """Pontos SEM vetor `lyrics` (o Qdrant não filtra ausência de vetor nomeado
    server-side, então pedimos o vetor e olhamos a resposta)."""
    out, offset = [], None
    while True:
        body = {
            "limit": 500,
            "with_payload": {
                "include": [
                    "path", "artist", "title", "album_title", "duration_ms",
                    "lrc_path", "embedded_lyrics", "lyrics_status",
                ]
            },
            "with_vector": ["lyrics"],
        }
        if offset is not None:
            body["offset"] = offset
        res = post(f"{QDRANT}/collections/{COLLECTION}/points/scroll", body)["result"]
        for p in res["points"]:
            vec = (p.get("vector") or {}).get("lyrics")
            if vec:
                continue
            out.append({"id": p["id"], **p["payload"]})
        offset = res.get("next_page_offset")
        if offset is None:
            break
    return out


def existing_text(pt: dict) -> str | None:
    """Texto de letra que o ponto JÁ tem (payload ou sidecar no disco)."""
    emb = pt.get("embedded_lyrics")
    if emb and len(clean_lyrics_text(emb)) > MIN_LYRICS_CHARS:
        return emb
    for candidate in (pt.get("lrc_path"), sidecar_for(pt.get("path"))):
        if not candidate:
            continue
        try:
            raw = Path(candidate).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        if len(clean_lyrics_text(raw)) > MIN_LYRICS_CHARS:
            return raw
    return None


def sidecar_for(audio_path: str | None) -> Path | None:
    if not audio_path:
        return None
    return Path(audio_path).with_suffix(".lrc")


def fetch_lrclib(pt: dict) -> tuple[str | None, str | None, str]:
    """(synced, plain, status). status: found | none | instrumental | error."""
    params = {"artist_name": pt.get("artist") or "", "track_name": pt.get("title") or ""}
    if pt.get("album_title"):
        params["album_name"] = pt["album_title"]
    if pt.get("duration_ms"):
        params["duration"] = round(pt["duration_ms"] / 1000)
    url = f"{LRCLIB}/api/get?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            d = json.load(r)
    except urllib.error.HTTPError as e:
        return (None, None, "none" if e.code == 404 else "error")
    except Exception:
        return (None, None, "error")
    if d.get("instrumental"):
        return (None, None, "instrumental")
    synced = (d.get("syncedLyrics") or "").strip() or None
    plain = (d.get("plainLyrics") or "").strip() or None
    if not synced and not plain:
        return (None, None, "none")
    return (synced, plain, "found")


def embed(text: str) -> list[float]:
    body = {"inputs": [text[:8000]], "model": "bge-m3"}
    return post(f"{COGMEM}/api/embed", body, timeout=120)["embeddings"][0]


def set_payload(point_id: int, payload: dict) -> None:
    post(
        f"{QDRANT}/collections/{COLLECTION}/points/payload?wait=true",
        {"payload": payload, "points": [point_id]},
    )


def set_vector(point_id: int, vector: list[float]) -> None:
    put(
        f"{QDRANT}/collections/{COLLECTION}/points/vectors?wait=true",
        {"points": [{"id": point_id, "vector": {"lyrics": vector}}]},
    )


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="processa no máximo N faixas")
    ap.add_argument("--dry-run", action="store_true", help="não escreve nada")
    ap.add_argument("--retry-misses", action="store_true",
                    help="reconsulta faixas já marcadas como miss")
    args = ap.parse_args()

    candidates = scroll_candidates()
    print(f"sem vetor de letra: {len(candidates)}")

    já_tem_texto, a_buscar = [], []
    for pt in candidates:
        if existing_text(pt):
            já_tem_texto.append(pt)
        elif pt.get("lyrics_status") in ("none", "instrumental") and not args.retry_misses:
            continue
        else:
            a_buscar.append(pt)

    print(f"  com texto no disco/payload (só falta embeddar): {len(já_tem_texto)}")
    print(f"  a consultar no lrclib: {len(a_buscar)}")
    fila = já_tem_texto + a_buscar
    if args.limit:
        fila = fila[: args.limit]
    if args.dry_run:
        for pt in fila[:20]:
            print(f"   - {pt.get('artist')} — {pt.get('title')}")
        return 0

    stats = {"vetor": 0, "sidecar": 0, "plain": 0, "miss": 0, "erro": 0}
    for i, pt in enumerate(fila, 1):
        text = existing_text(pt)
        wrote_sidecar = False
        if text is None:
            synced, plain, status = fetch_lrclib(pt)
            time.sleep(REQUEST_GAP)
            if status != "found":
                stats["miss" if status != "error" else "erro"] += 1
                try:
                    set_payload(pt["id"], {"lyrics_status": status})
                except Exception as e:
                    print(f"   ! set_payload status falhou: {e}", file=sys.stderr)
                continue
            # Só letra SINCRONIZADA vira sidecar (a view de letra do app conta
            # com os timestamps); plain vai pro payload e alimenta só o vetor.
            if synced:
                sc = sidecar_for(pt.get("path"))
                if sc and not sc.exists():
                    try:
                        sc.write_text(synced, encoding="utf-8")
                        wrote_sidecar = True
                        stats["sidecar"] += 1
                    except OSError as e:
                        print(f"   ! sidecar falhou: {e}", file=sys.stderr)
                text = synced
            else:
                text = plain
                stats["plain"] += 1

        cleaned = clean_lyrics_text(text)
        if len(cleaned) <= MIN_LYRICS_CHARS:
            stats["miss"] += 1
            try:
                set_payload(pt["id"], {"lyrics_status": "instrumental"})
            except Exception:
                pass
            continue

        try:
            vec = embed(cleaned)
            payload = {"lyrics_status": "found"}
            if wrote_sidecar:
                payload["lrc_path"] = str(sidecar_for(pt["path"]))
            elif not pt.get("lrc_path"):
                payload["embedded_lyrics"] = text
            set_payload(pt["id"], payload)
            set_vector(pt["id"], vec)
            stats["vetor"] += 1
        except Exception as e:
            stats["erro"] += 1
            print(f"   ! embed/upsert falhou ({pt.get('title')}): {e}", file=sys.stderr)

        if i % 25 == 0:
            print(f"  [{i}/{len(fila)}] {stats}")

    print(f"FIM: {stats}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
