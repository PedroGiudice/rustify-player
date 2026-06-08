#!/usr/bin/env python3
"""Testes das funcoes puras de segmentacao do align_lyrics.

Sem pytest: asserts puros + runner (mesmo padrao de scripts/curator/test_discover_tracks.py).

Cobre o bug que motivou o rebuild da quebra de linha:
  - heuristica antiga `raw_words[i][0].isupper()` quebrava verso em nome
    proprio / "I" / "DJ", e nao quebrava nada em texto lowercase (linha-monstro).
  - fix: quebrar pela ESTRUTURA DE VERSO do texto-fonte (scraped-texts), nao
    por capitalizacao. Cada verso = uma linha LRC; timestamp = 1a palavra do verso.

Importar align_lyrics e seguro: torch e importado lazy dentro de align_track.

Rodar: python3 scripts/test_align_lyrics.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import align_lyrics as A


def check(name, got, want):
    status = "ok" if got == want else "FAIL"
    if got != want:
        check.failed += 1
        print(f"  [{status}] {name}\n        got:  {got!r}\n        want: {want!r}")
    else:
        print(f"  [{status}] {name}")


check.failed = 0


def test_count_norm_tokens():
    print("count_norm_tokens:")
    check("verso simples", A.count_norm_tokens("I'm just a piece of fruit"), 6)
    check("hifen vira tokens", A.count_norm_tokens("rock-and-roll music"), 4)
    check("numero some, sobra apostrofo", A.count_norm_tokens("Vacant since '92"), 3)
    check("verso vazio", A.count_norm_tokens(""), 0)
    check("so pontuacao", A.count_norm_tokens("..."), 0)
    check("acento normaliza", A.count_norm_tokens("Coracao partido"), 2)


def test_segment_basico():
    print("segment_by_verses basico:")
    verses = ["I'm just a piece of fruit", "Left in the midday sun"]
    # 6 + 5 = 11 palavras; spans = tempo de inicio de cada palavra
    spans = [0.0, 0.5, 1.0, 1.5, 2.0, 2.5,   # verso 1 (6)
             5.0, 5.5, 6.0, 6.5, 7.0]          # verso 2 (5)
    got = A.segment_by_verses(verses, spans)
    check("2 versos, 2 linhas", len(got), 2)
    check("ts verso 1 = 1a palavra", got[0], (0.0, "I'm just a piece of fruit"))
    check("ts verso 2 = 1a palavra", got[1], (5.0, "Left in the midday sun"))


def test_estrofe_vazia_pulada():
    print("segment_by_verses estrofe vazia:")
    verses = ["First line here", "", "Second line here"]
    spans = [0.0, 0.5, 1.0,   # verso 1 (3)
             4.0, 4.5, 5.0]    # verso 3 (3) — linha vazia nao consome span
    got = A.segment_by_verses(verses, spans)
    check("vazia nao vira linha", len(got), 2)
    check("ts apos estrofe correto", got[1], (4.0, "Second line here"))


def test_lowercase_quebra_igual():
    # O CERNE DO BUG: texto lowercase. A heuristica antiga nunca quebrava aqui
    # (nenhuma maiuscula) -> linha-monstro. Agora quebra pela estrutura de verso.
    print("segment_by_verses lowercase (regressao linha-monstro):")
    verses = ["i'm just a friendly ghost", "and when you shine the light"]
    spans = [0.0, 0.5, 1.0, 1.5, 2.0,        # verso 1 (5)
             5.0, 5.5, 6.0, 6.5, 7.0, 7.5]    # verso 2 (6)
    got = A.segment_by_verses(verses, spans)
    check("lowercase ainda quebra em 2", len(got), 2)
    check("segundo verso inteiro preservado", got[1][1], "and when you shine the light")


def test_maiuscula_meio_nao_quebra():
    # REGRESSAO DIRETA: "London" maiuscula no meio. Heuristica antiga quebraria
    # o verso em "London". Agora o verso fica inteiro (1 linha so).
    print("segment_by_verses maiuscula no meio (regressao heuristica):")
    verses = ["I went to London yesterday"]
    spans = [0.0, 0.5, 1.0, 1.5, 2.0]  # 5 palavras
    got = A.segment_by_verses(verses, spans)
    check("nome proprio no meio nao quebra", len(got), 1)
    check("verso inteiro intacto", got[0], (0.0, "I went to London yesterday"))


def test_spans_insuficientes_nao_crasha():
    # Texto-fonte mais longo que o audio alinhado (spans acabam). Deve parar
    # gracioso, emitir o que conseguiu, sem IndexError.
    print("segment_by_verses spans insuficientes:")
    verses = ["First line here", "Second line here", "Third line here"]
    spans = [0.0, 0.5, 1.0, 4.0]  # so cobre verso 1 + 1 palavra do verso 2
    got = A.segment_by_verses(verses, spans)
    check("nao crasha, emite parcial", len(got) >= 1, True)
    check("primeiro verso ok", got[0], (0.0, "First line here"))


def test_consistencia_tokenizacao_dados_reais():
    # PROPRIEDADE CRITICA: normalizar verso-a-verso e somar tokens DEVE bater
    # com normalizar o texto inteiro junto. Se nao bater, o mapeamento
    # verso->spans desalinha. Testado nos scraped-texts reais.
    print("consistencia tokenizacao (240 scraped-texts reais):")
    base = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "data", "scraped-texts")
    base = os.path.normpath(base)
    if not os.path.isdir(base):
        check("scraped-texts presente", False, True)
        return
    import glob
    mismatches = []
    n = 0
    for fp in glob.glob(os.path.join(base, "*.txt")):
        raw = open(fp, encoding="utf-8", errors="ignore").read()
        verses = raw.splitlines()
        per_verse = sum(A.count_norm_tokens(v) for v in verses)
        flat = len(A.normalize_text(raw).split())
        n += 1
        if per_verse != flat:
            mismatches.append((os.path.basename(fp), per_verse, flat))
    check(f"soma por verso == flat ({n} arquivos)", mismatches, [])


def main():
    test_count_norm_tokens()
    test_segment_basico()
    test_estrofe_vazia_pulada()
    test_lowercase_quebra_igual()
    test_maiuscula_meio_nao_quebra()
    test_spans_insuficientes_nao_crasha()
    test_consistencia_tokenizacao_dados_reais()
    print()
    if check.failed:
        print(f"{check.failed} teste(s) FALHARAM")
        sys.exit(1)
    print("todos os testes passaram")


if __name__ == "__main__":
    main()
