#!/usr/bin/env python3
"""Proposta de separação do rap e trap brasileiros de `Rap & Hip-Hop` (CMR-300).

Decisão do CEO: artista BRASILEIRO vai para `Rap & Trap Brasileiro` (inclusive quando canta em
inglês); o gringo (inclusive latino/espanhol) fica em `Rap & Hip-Hop`. A unidade de decisão é o
ARTISTA principal da faixa (nome normalizado, variações de grafia juntas), com a evidência de
TODAS as faixas dele; todas as faixas do artista seguem o mesmo destino. Sinais:

  1. Idioma da letra (forte): `embedded_lyrics` (tags, costuma ser LRC), `lyrics_text` do payload
     e o `.lrc` lido na cmr-auto (uma chamada ssh para todos). Detector por proporção de
     stopwords pt/en/es (stdlib).
       - texto mínimo: MIN_CHARS (150) caracteres depois de tirar timestamps;
       - o 1º idioma precisa de >= MIN_SCORE (0,10) de stopwords por token e de margem
         >= MIN_MARGIN (0,05) sobre o 2º; senão `None` (indeterminado).
  2. País do artista no MusicBrainz: só vale com nome normalizado idêntico E score >= 95; se dois
     resultados assim discordam de país, é homônimo e o país fica indeterminado (a letra das
     outras faixas do mesmo artista resolve).
  3. Idioma do título (fraco: só rebaixa suspeita de homônimo, nunca promove).

Artista brasileiro = MusicBrainz BR sem ambiguidade OU (ao menos uma faixa com letra pt e as
faixas pt >= as de outro idioma). Confiança do artista: alta = MB BR e letra pt majoritária
concordam (ou MB de fora e letra de fora); media = um sinal só; baixa = conflito (letra pt com
MB de fora, MB BR com letra só de fora) ou nenhum sinal. Pastas genéricas (Various Artists,
_Compilations, CD 01...) saem por faixa, usando a decisão do artista de cada faixa.

Só LEITURA: Qdrant da cmr-auto (túnel 16333) e ssh para ler .lrc. Não move nada. Uso:
  python3 scripts/curator/rap_br_classify.py [--out docs/contexto/14102026-rap-br-proposta.json]
"""
import argparse
import json
import re
import subprocess
import time
import unicodedata
import urllib.parse
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

SRC = "Rap & Hip-Hop"
DEST_BR = "Rap & Trap Brasileiro"
MUSIC = "/home/cmr-auto/Music/"
QDRANT = "http://127.0.0.1:16333"
SSH = "cmr-auto@100.102.249.9"
MB_CACHE = Path.home() / ".cache/rustify-curator/mb-artist-country.json"
MB_UA = "rustify-curator/0.1 (pedrogr1707@gmail.com)"

MIN_CHARS = 150
MIN_SCORE = 0.10
MIN_MARGIN = 0.05
MB_MIN_SCORE = 95
# países lusófonos que NÃO são Brasil: letra em português ali não faz o artista brasileiro
LUSO_NON_BR = {"PT", "AO", "MZ", "CV", "GW", "ST", "TL"}
ORDER = {"alta": 3, "media": 2, "baixa": 1}

_PT = """o a os as um uma uns umas de do da dos das em no na nos nas por pro pra para com sem
sobre entre mas porém também então porque pois quando onde como quem qual quais que se já mais
muito muita muitos muitas tudo todo toda todos todas nada ninguém eu tu você vocês ele ela eles
elas nós me te lhe lhes meu minha meus minhas teu tua seu sua seus suas nosso nossa isso isto
esse essa esses essas aquele aquela aquilo aqui ali lá cá não sim ser é são foi era estou está
estão tá tô vou vai vão tem têm tinha ter fazer faz fiz quero pode vem sou né cê mano cara""".split()
_ES = """el la los las un una unos unas de del al en por para con sin sobre entre pero también
entonces porque pues cuando donde como quien cual cuales que se ya más muy mucho mucha muchos
muchas todo toda todos todas nada nadie yo tú vos usted ustedes él ella ellos ellas nosotros me
te le les mi mis tu tus su sus nuestro nuestra esto eso esa ese esos esas aquel aquello aquí
allí allá no sí es son fue era estoy está están voy va van tiene tienen tenía tener hacer hace
hice quiero puede viene soy hay pa""".split()
_EN = """the a an and or but of to in on at for with without about between because when where
how who which that this these those it its is are was were am be been being i you he she we
they me him her us them my your his our their mine yours not no yes do does did done have has
had will would can could should just like get got go going know now all more one up out so if
then than too very what there here from gonna wanna ain't don't i'm it's you're""".split()


def _fold(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", s) if unicodedata.category(c) != "Mn")


def _build() -> dict[str, set[str]]:
    sets = {"pt": set(_PT), "es": set(_ES), "en": set(_EN)}
    # palavras presentes em mais de um idioma não discriminam: saem de todos
    comuns = set()
    for a in sets:
        for b in sets:
            if a < b:
                comuns |= sets[a] & sets[b]
    return {k: v - comuns for k, v in sets.items()}


STOP = _build()
TOKEN = re.compile(r"[^\W\d_]+(?:'[^\W\d_]+)?", re.UNICODE)


def strip_lrc(text: str) -> str:
    """Tira timestamps `[mm:ss.xx]`, tags `[ar:...]`/`<00:01.00>` e linhas vazias."""
    if not text:
        return ""
    text = re.sub(r"\[\d+:\d+(?:[.:]\d+)?\]", " ", text)
    text = re.sub(r"<\d+:\d+(?:[.:]\d+)?>", " ", text)
    text = re.sub(r"^\s*\[[a-zA-Z]+:[^\]]*\]\s*$", " ", text, flags=re.M)
    return re.sub(r"\s+", " ", text).strip()


def lang_scores(text: str) -> dict[str, float]:
    toks = [t.lower() for t in TOKEN.findall(text)]
    if not toks:
        return {k: 0.0 for k in STOP}
    n = len(toks)
    return {k: sum(1 for t in toks if t in v) / n for k, v in STOP.items()}


def detect_lang(text: str, min_chars: int = MIN_CHARS, min_score: float = MIN_SCORE,
                min_margin: float = MIN_MARGIN) -> tuple[str | None, int]:
    """(idioma | None, nº de caracteres úteis). None = texto curto, ambíguo ou sem margem."""
    clean = strip_lrc(text)
    n = len(clean)
    if n < min_chars:
        return None, n
    sc = sorted(lang_scores(clean).items(), key=lambda kv: -kv[1])
    (l1, s1), (_, s2) = sc[0], sc[1]
    if s1 < min_score or s1 - s2 < min_margin:
        return None, n
    return l1, n


def title_lang(title: str) -> str | None:
    """Fraco: um idioma só se os indícios (stopwords, acentos típicos) apontam para um."""
    toks = [t.lower() for t in TOKEN.findall(title or "")]
    hits = {k: sum(1 for t in toks if t in v) for k, v in STOP.items()}
    if re.search(r"[ãõçâêô]", (title or "").lower()):
        hits["pt"] += 2
    if re.search(r"[ñ¿¡]", (title or "").lower()):
        hits["es"] += 2
    vivos = [k for k, v in hits.items() if v > 0]
    return vivos[0] if len(vivos) == 1 else None


def normalize_name(s: str) -> str:
    """Casefold, sem acento, só alfanumérico ('A$AP Rocky' -> 'aap rocky' nos dois lados)."""
    s = _fold(s or "").casefold()
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9]+", " ", s)).strip()


PROTEGIDOS = {"tyler, the creator"}  # vírgula faz parte do nome
SEP = re.compile(r"\s+(?:feat\.?|ft\.?|featuring|with|x|vs\.?)\s+|\s*[&,;]\s*|\s+e\s+", re.I)


def primary_artist(artist: str) -> str:
    """O primeiro artista da faixa (feat./&/vírgula separam; o primeiro manda)."""
    a = (artist or "").strip()
    low = a.casefold()
    for p in PROTEGIDOS:
        if low.startswith(p):
            return a[: len(p)]
    return SEP.split(a, maxsplit=1)[0].strip()


def decide(lang: str | None, country: str | None, tlang: str | None) -> tuple[str, str, str]:
    """(dest, confiança, motivo). `country` já é None se indeterminado/não achado."""
    lyr_br = lang == "pt"
    lyr_out = lang in ("en", "es")
    c_br = country == "BR"
    c_out = country is not None and not c_br
    if lang and country:
        if lyr_br and c_br:
            return DEST_BR, "alta", "letra pt + artista BR"
        if lyr_out and c_out:
            return SRC, "alta", "letra en/es + artista de fora"
        if lyr_br and country in LUSO_NON_BR:
            return SRC, "baixa", "letra pt mas artista lusófono não brasileiro"
        return (DEST_BR if lyr_br else SRC), "baixa", "letra e país discordam"
    if lang:
        dest = DEST_BR if lyr_br else SRC
        if tlang == lang:
            return dest, "alta", "letra forte, país não achado, título concorda"
        return dest, "media", "só a letra"
    if country:
        if c_out and tlang == "pt":
            # país de fora + título em português sem letra: homônimo provável, não confia
            return SRC, "baixa", "país de fora mas título em português (homônimo?)"
        return (DEST_BR if c_br else SRC), "media", "só o país"
    if tlang:
        return (DEST_BR if tlang == "pt" else SRC), "baixa", "só o título"
    return SRC, "baixa", "sem sinal"


GENERICOS = {"variousartists", "various", "va", ""}


def artist_key(artist: str) -> str:
    """Chave de agrupamento do artista principal: sem acento, pontuação e espaços
    ('J. Cole' = 'J Cole', 'J.I.D' = 'JID')."""
    return normalize_name(primary_artist(artist)).replace(" ", "")


def decide_artist(n_pt: int, n_other: int, country: str | None, candidates: list[str],
                  pt_titles: int) -> tuple[str, str, str]:
    """Decisão do ARTISTA. n_pt/n_other = faixas com letra pt / com letra en ou es.
    `country` é None se indeterminado; `candidates` = países do homônimo ambíguo (informativo)."""
    lyr_pt = n_pt >= 1 and n_pt >= n_other
    lyr_out = n_other > n_pt
    tem_letra = n_pt + n_other > 0
    c_br = country == "BR"
    c_out = country is not None and not c_br
    if c_br:
        if lyr_pt:
            return DEST_BR, "alta", "MusicBrainz BR e letra pt majoritária"
        if not tem_letra:
            return DEST_BR, "media", "MusicBrainz BR, sem letra"
        return DEST_BR, "baixa", "MusicBrainz BR mas letra só de fora (canta em inglês/espanhol?)"
    if c_out:
        if lyr_pt:
            if country in LUSO_NON_BR:
                return SRC, "baixa", "letra pt mas artista lusófono não brasileiro"
            return DEST_BR, "baixa", f"letra pt mas MusicBrainz {country} (homônimo?)"
        if lyr_out:
            return SRC, "alta", "MusicBrainz de fora e letra de fora"
        if pt_titles:
            return SRC, "baixa", f"MusicBrainz {country}, sem letra, título em português (homônimo?)"
        return SRC, "media", f"MusicBrainz {country}, sem letra"
    amb = " (MusicBrainz ambíguo: " + "/".join(candidates) + ")" if candidates else ""
    if lyr_pt:
        return DEST_BR, "media", "só a letra pt" + amb
    if lyr_out:
        return SRC, "media", "só a letra de fora" + amb
    return (DEST_BR if pt_titles else SRC), "baixa", "sem sinal" + amb


def mb_for_artist(variants: set[str], cache: dict) -> tuple[str | None, list[str], bool]:
    """Junta o MusicBrainz das grafias do artista: (país, candidatos, achou)."""
    paises, cands, achou = set(), set(), False
    for v in variants:
        e = cache.get(normalize_name(v), {})
        achou = achou or bool(e.get("found"))
        if e.get("country"):
            paises.add(e["country"])
        cands |= set(e.get("candidates") or [])
    if len(paises) == 1:
        return next(iter(paises)), [], achou
    return None, sorted(paises | cands), achou


def classify_tracks(base: list[dict], cache: dict) -> list[dict]:
    """base: faixas com artist, title, lyrics_lang, lyrics_chars, title_lang, artist_dir,
    album_dir, file. Devolve as faixas com dest/confidence/reason decididos POR ARTISTA.
    Artista genérico (Various Artists...) é decidido faixa a faixa pelos próprios sinais."""
    grupos = defaultdict(list)
    for t in base:
        grupos[artist_key(t["artist"] or "")].append(t)
    out = []
    for key, ts in grupos.items():
        nomes = Counter(primary_artist(t["artist"] or "") for t in ts)
        canon = nomes.most_common(1)[0][0]
        country, cands, achou = mb_for_artist(set(nomes), cache)
        n_pt = sum(1 for t in ts if t["lyrics_lang"] == "pt")
        n_other = sum(1 for t in ts if t["lyrics_lang"] in ("en", "es"))
        pt_titles = sum(1 for t in ts if t["title_lang"] == "pt")
        for t in ts:
            if key in GENERICOS:
                dest, conf, why = decide(t["lyrics_lang"], None, t["title_lang"])
                why = "faixa de artista genérico: " + why
            else:
                dest, conf, why = decide_artist(n_pt, n_other, country, cands, pt_titles)
            out.append({**t, "dest": dest, "confidence": conf, "reason": why,
                        "canonical_artist": canon if key not in GENERICOS else (canon or t["artist_dir"]),
                        "artist_key": key, "artist_tracks": len(ts), "artist_n_pt": n_pt,
                        "artist_n_other": n_other, "mb_country": country,
                        "mb_found": achou, "mb_ambiguous": bool(cands) and country is None})
    return out


def folder_confidence(confs: list[str]) -> str:
    return min(confs, key=lambda c: ORDER[c])


def aggregate(tracks: list[dict]) -> list[dict]:
    """Agrega por pasta só quando todas as faixas concordam no destino: artista > álbum > faixa.
    Cada faixa: {artist_dir, album_dir, file, dest, confidence, canonical_artist, ...evidência}.
    A linha de pasta leva a pior confiança das faixas e o resumo da evidência."""
    por_artista = defaultdict(list)
    for t in tracks:
        por_artista[t["artist_dir"]].append(t)

    rows = []

    def linha(ts, artist_dir, album_dir):
        canon = Counter(t["canonical_artist"] for t in ts).most_common(1)[0][0]
        return {
            "artist_dir": artist_dir, "album_dir": album_dir, "dest": ts[0]["dest"],
            "confidence": folder_confidence([t["confidence"] for t in ts]),
            "canonical_artist": canon, "n_tracks": len(ts),
            "lyrics_lang": dict(Counter(t["lyrics_lang"] or "?" for t in ts)),
            "lyrics_chars": sum(t["lyrics_chars"] for t in ts),
            "mb_country": dict(Counter(t["mb_country"] or "?" for t in ts)),
            "title_lang": dict(Counter(t["title_lang"] or "?" for t in ts)),
        }

    for adir, ts in sorted(por_artista.items()):
        if len({t["dest"] for t in ts}) == 1:
            rows.append(linha(ts, adir, None))
            continue
        por_album = defaultdict(list)
        for t in ts:
            por_album[t["album_dir"]].append(t)
        for alb, ats in sorted(por_album.items(), key=lambda kv: str(kv[0])):
            if len({t["dest"] for t in ats}) == 1 and alb is not None:
                rows.append(linha(ats, adir, alb))
                continue
            for t in sorted(ats, key=lambda x: x["file"]):
                rows.append({
                    "artist_dir": adir, "album_dir": alb, "file": t["file"], "dest": t["dest"],
                    "confidence": t["confidence"], "canonical_artist": t["canonical_artist"],
                    "title": t["title"], "lyrics_lang": t["lyrics_lang"],
                    "lyrics_chars": t["lyrics_chars"], "mb_country": t["mb_country"],
                    "title_lang": t["title_lang"], "reason": t["reason"],
                })
    return rows


GENERICA = re.compile(r"^(cd ?\d|disc ?\d|digital media|_|various)|compilation", re.I)
BAGUNCADA = re.compile(r"^(cd|disc|disk|digital media|_)|compilation|^various|mixtape|^\d+ ?-|\[flac\]|\.flac$", re.I)


def pasta_bagunçada(adir: str, ts: list[dict]) -> bool:
    """Pasta de 2º nível que não é nome de artista: padrão de disco/leva/compilação ou nome
    que não bate com nenhum artista das faixas."""
    if BAGUNCADA.search(adir):
        return True
    n = normalize_name(adir)
    return not any(normalize_name(t["canonical_artist"]) == n for t in ts)


def _evid_artista(ts: list[dict]) -> str:
    t0 = ts[0]
    pais = t0["mb_country"] or ("ambíguo" if t0["mb_ambiguous"] else "não achado" if not t0["mb_found"] else "sem país")
    n = len(ts)
    sem = sum(1 for t in ts if not t["lyrics_lang"])
    return (f"{n} faixa(s); letra pt {t0['artist_n_pt']}, en/es {t0['artist_n_other']}, sem letra {sem}; "
            f"país {pais}; motivo: {t0['reason']}")


def artistas(tracks: list[dict]) -> dict:
    """artist_key -> faixas (artistas genéricos entram por faixa, sob a própria chave)."""
    g = defaultdict(list)
    for t in tracks:
        g[t["artist_key"]].append(t)
    return g


def write_report(tracks: list[dict], rows: list[dict], path: str) -> None:
    br = [t for t in tracks if t["dest"] == DEST_BR]
    fica = [t for t in tracks if t["dest"] == SRC]
    cc = Counter((t["dest"], t["confidence"]) for t in tracks)
    g = artistas(tracks)
    nomeados = {k: ts for k, ts in g.items() if k not in GENERICOS}
    ca = Counter((ts[0]["dest"], ts[0]["confidence"]) for ts in nomeados.values())
    L = ["# Rap e trap brasileiros: proposta de separação (CMR-300)", "",
         "Data: 14/10/2026. Nada foi movido. Esta é só a proposta.", "",
         "A decisão é por ARTISTA: artista brasileiro vai com todas as faixas, mesmo as em inglês",
         "e as sem letra. Só as pastas genéricas (Various Artists, compilações) saem faixa a faixa.", "",
         "## Resumo", "",
         f"- Faixas em `{SRC}` hoje: **{len(tracks)}** de **{len(nomeados)}** artistas "
         f"(mais as faixas de artista genérico).",
         f"- Vão para `{DEST_BR}`: **{len(br)}** faixas.",
         f"- Ficam em `{SRC}`: **{len(fica)}** faixas.", "",
         "Faixas por confiança:", "",
         "| Destino | Alta | Média | Baixa |", "|---|---:|---:|---:|"]
    for d in (DEST_BR, SRC):
        L.append(f"| {d} | {cc[(d, 'alta')]} | {cc[(d, 'media')]} | {cc[(d, 'baixa')]} |")
    L += ["", "Artistas por confiança:", "", "| Destino | Alta | Média | Baixa |", "|---|---:|---:|---:|"]
    for d in (DEST_BR, SRC):
        L.append(f"| {d} | {ca[(d, 'alta')]} | {ca[(d, 'media')]} | {ca[(d, 'baixa')]} |")
    sem = [t for t in tracks if not t["lyrics_lang"] and not t["mb_country"]]
    L += ["", "Como ler: **alta** = letra e país do artista concordam. **Média** = só um dos dois sinais.",
          "**Baixa** = os sinais brigam ou não há sinal. Na execução, só alta e média andam;",
          "baixa fica onde está até você decidir.", "",
          f"Faixas sem letra utilizável e sem país: **{len(sem)}**.", ""]

    L += ["## Artistas que vão com confiança alta", ""]
    alta = sorted(((ts[0]["canonical_artist"], len(ts)) for k, ts in nomeados.items()
                   if ts[0]["dest"] == DEST_BR and ts[0]["confidence"] == "alta"), key=lambda x: x[0].casefold())
    L.append(", ".join(f"{a} ({n})" for a, n in alta) or "nenhum")
    L.append("")

    rev = {k: ts for k, ts in g.items() if ts[0]["confidence"] != "alta"}
    L += ["## Lista para revisão (por artista)", "",
          f"{len(rev)} artistas ou grupos (média e baixa). VAI = proposta de ir para `{DEST_BR}`; "
          f"fica = continua em `{SRC}`.", ""]
    for conf in ("media", "baixa"):
        L += [f"### {'Média' if conf == 'media' else 'Baixa (não anda sem sua decisão)'}", ""]
        itens = sorted(((k, ts) for k, ts in rev.items() if ts[0]["confidence"] == conf and k not in GENERICOS),
                       key=lambda kv: (kv[1][0]["dest"], kv[1][0]["canonical_artist"].casefold()))
        for k, ts in itens:
            alvo = "VAI" if ts[0]["dest"] == DEST_BR else "fica"
            L.append(f"- {alvo} | {ts[0]['canonical_artist']} | {_evid_artista(ts)}")
        for k in GENERICOS & set(g):
            for t in g[k]:
                if t["confidence"] == conf:
                    alvo = "VAI" if t["dest"] == DEST_BR else "fica"
                    L.append(f"- {alvo} | (artista genérico) {t['title']} | pasta `{t['artist_dir']}` | {t['reason']}")
        L.append("")

    por_dir = defaultdict(list)
    for t in tracks:
        por_dir[t["artist_dir"]].append(t)
    solta = {a: ts for a, ts in por_dir.items() if pasta_bagunçada(a, ts)}
    mistas = {a for a, ts in por_dir.items() if len({t["dest"] for t in ts}) > 1}
    generica = {a for a in solta if GENERICA.search(a)}
    com_vao = {a for a in solta if any(t["dest"] == DEST_BR for t in solta[a])}
    listar = generica | mistas | com_vao
    resto = [a for a in solta if a not in listar]
    L += ["## Pastas bagunçadas e pastas divididas", "",
          f"Pastas de 2º nível que não são nome de artista (disco, leva, compilação, nome de álbum "
          f"solto): **{len(solta)}**. Pastas cujas faixas vão para destinos diferentes: **{len(mistas)}**.", ""]
    if mistas:
        L += ["Pastas ainda divididas e por quê (cada faixa segue o destino do seu artista):", ""]
        for a in sorted(mistas, key=str.casefold):
            def nome(t):
                return f'faixa "{t["title"]}"' if t["artist_key"] in GENERICOS else t["canonical_artist"]
            vao = sorted({nome(t) for t in por_dir[a] if t["dest"] == DEST_BR})
            fic = sorted({nome(t) for t in por_dir[a] if t["dest"] == SRC})
            L.append(f"- `{a}`: vão {', '.join(vao)}; ficam {', '.join(fic)}")
        L.append("")
    L += [f"Outras {len(resto)} pastas com nome de álbum solto, com {sum(len(solta[a]) for a in resto)} "
          "faixas, ficam inteiras em `Rap & Hip-Hop` (nenhuma faixa vai) e não estão listadas.", "",
          "Pastas listadas (genéricas, divididas ou com alguma faixa que vai):", ""]
    for a in sorted(listar, key=str.casefold):
        ts = por_dir[a]
        v = sum(1 for t in ts if t["dest"] == DEST_BR)
        L.append(f"- `{a}`: {len(ts)} faixa(s), {v} vão, {len(ts) - v} ficam"
                 + (" (dividida)" if a in mistas else ""))
    L.append("")
    Path(path).write_text("\n".join(L), encoding="utf-8")


# ---------------------------------------------------------------- E/S (não testado)

def qdrant_tracks() -> list[dict]:
    pts, off = [], None
    while True:
        body = {"limit": 500, "with_payload": True, "with_vector": False,
                "filter": {"must": [{"key": "path", "match": {"text": SRC}}]}}
        if off is not None:
            body["offset"] = off
        req = urllib.request.Request(f"{QDRANT}/collections/rustify_tracks/points/scroll",
                                     data=json.dumps(body).encode(), headers={"Content-Type": "application/json"})
        res = json.load(urllib.request.urlopen(req, timeout=60))["result"]
        pts += res["points"]
        off = res.get("next_page_offset")
        if off is None:
            break
    pre = MUSIC + SRC + "/"
    return [p for p in pts if p["payload"]["path"].startswith(pre)]


REMOTE = r'''
import json, sys
out = {}
for p in paths:
    try:
        out[p] = open(p, encoding="utf-8", errors="replace").read()
    except OSError:
        pass
json.dump(out, sys.stdout)
'''


def read_lrcs(paths: list[str]) -> dict[str, str]:
    """Lê vários .lrc na cmr-auto em UMA chamada ssh."""
    # o script inteiro vai por stdin (python3 -), com a lista de caminhos embutida
    prog = f"paths = json.loads({json.dumps(json.dumps(paths))})\n"
    r = subprocess.run(["ssh", SSH, "python3", "-"], input="import json\n" + prog + REMOTE,
                       capture_output=True, text=True, timeout=300)
    if r.returncode != 0:
        raise SystemExit(f"ssh falhou: {r.stderr[:300]}")
    return json.loads(r.stdout)


def _mb_get(url: str) -> dict:
    req = urllib.request.Request(url, headers={"User-Agent": MB_UA})
    return json.load(urllib.request.urlopen(req, timeout=30))


def area_country(area: dict | None, cache: dict, depth: int = 0) -> str | None:
    """País ISO de uma área do MB. Cidade costuma vir sem código: sobe pelas relações
    `part of` (subdivisão 'BR-MG' -> 'BR'), com cache e no máximo 3 níveis."""
    if not area:
        return None
    for c in area.get("iso-3166-1-codes") or []:
        return c
    for c in area.get("iso-3166-2-codes") or []:
        return c.split("-")[0]
    if depth >= 3 or not area.get("id"):
        return None
    key = "area:" + area["id"]
    if key not in cache:
        time.sleep(1.05)
        d = _mb_get(f"https://musicbrainz.org/ws/2/area/{area['id']}?inc=area-rels&fmt=json")
        pais = None
        for r in d.get("relations", []):
            if r.get("type") == "part of" and r.get("direction") == "backward":
                pais = area_country(r.get("area"), cache, depth + 1)
                if pais:
                    break
        cache[key] = {"country": pais}
    return cache[key]["country"]


def mb_lookup(name: str, cache: dict) -> dict:
    key = normalize_name(name)
    if key in cache:
        return cache[key]
    url = "https://musicbrainz.org/ws/2/artist?" + urllib.parse.urlencode(
        {"query": f'artist:"{name}"', "fmt": "json", "limit": 8})
    entry = {"country": None, "found": False, "ambiguous": False, "mb_name": None, "score": None}
    for tentativa in range(3):
        try:
            data = _mb_get(url)
            ok = [a for a in data.get("artists", [])
                  if a.get("score", 0) >= MB_MIN_SCORE and normalize_name(a.get("name", "")) == key]
            if ok:
                paises = {a.get("country") or area_country(a.get("area") or a.get("begin-area"), cache)
                          for a in ok}
                paises.discard(None)
                entry.update(found=True, mb_name=ok[0]["name"], score=ok[0]["score"])
                if len(paises) == 1:
                    entry["country"] = paises.pop()
                elif len(paises) > 1:
                    entry["ambiguous"] = True
                    entry["candidates"] = sorted(paises)
            break
        except Exception as e:  # rate limit / rede: espera e tenta de novo; não cacheia falha
            time.sleep(5 * (tentativa + 1))
            if tentativa == 2:
                return {**entry, "error": str(e)[:80]}
    cache[key] = entry
    return entry


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="docs/contexto/14102026-rap-br-proposta.json")
    ap.add_argument("--report", default="docs/contexto/14102026-rap-br-proposta.md")
    ap.add_argument("--faixas", default="docs/contexto/14102026-rap-br-faixas.json",
                    help="evidência por faixa (sidecar)")
    a = ap.parse_args()

    pts = qdrant_tracks()
    print(f"faixas sob {SRC}: {len(pts)}")

    texts: dict[int, str] = {}
    falta: dict[int, str] = {}
    for p in pts:
        d = p["payload"]
        t = ""
        for campo in ("embedded_lyrics", "lyrics_text"):
            if d.get(campo) and detect_lang(d[campo])[1] >= MIN_CHARS:
                t = d[campo]
                break
        if t:
            texts[p["id"]] = t
        else:
            cands = [d.get("lrc_path"), re.sub(r"\.[^.]+$", ".lrc", d["path"])]
            falta[p["id"]] = [c for c in cands if c and c != "None"]
    todos = sorted({c for cs in falta.values() for c in cs})
    lrcs = read_lrcs(todos) if todos else {}
    for pid, cs in falta.items():
        for c in cs:
            if c in lrcs and detect_lang(lrcs[c])[1] >= MIN_CHARS:
                texts[pid] = lrcs[c]
                break
    print(f"faixas com letra utilizável: {len(texts)}")

    MB_CACHE.parent.mkdir(parents=True, exist_ok=True)
    cache = json.loads(MB_CACHE.read_text()) if MB_CACHE.exists() else {}
    nomes = {}
    for p in pts:
        n = primary_artist(p["payload"].get("artist") or "")
        if n:
            nomes.setdefault(normalize_name(n), n)
    novos = [n for k, n in nomes.items() if k not in cache]
    print(f"artistas distintos: {len(nomes)} (a consultar no MusicBrainz: {len(novos)})")
    for i, n in enumerate(novos):
        mb_lookup(n, cache)
        MB_CACHE.write_text(json.dumps(cache, ensure_ascii=False, indent=1))
        time.sleep(1.05)
        if i % 25 == 0:
            print(f"  mb {i}/{len(novos)}", flush=True)

    pre = MUSIC + SRC + "/"
    base = []
    for p in pts:
        d = p["payload"]
        rel = d["path"][len(pre):]
        partes = rel.split("/")
        lang, nchars = detect_lang(texts.get(p["id"], ""))
        base.append({"id": str(p["id"]), "artist_dir": partes[0],
                     "album_dir": partes[1] if len(partes) > 2 else None, "file": rel,
                     "artist": d.get("artist"), "title": d.get("title"), "lyrics_lang": lang,
                     "lyrics_chars": nchars, "title_lang": title_lang(d.get("title") or "")})
    tracks = sorted(classify_tracks(base, cache), key=lambda t: t["file"])
    rows = aggregate(tracks)
    Path(a.out).write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    Path(a.faixas).write_text(json.dumps(tracks, ensure_ascii=False, indent=1))
    write_report(tracks, rows, a.report)
    c = Counter((t["dest"], t["confidence"]) for t in tracks)
    for k, v in sorted(c.items()):
        print(k, v)
    print(f"linhas: {len(rows)} -> {a.out}")


if __name__ == "__main__":
    main()
