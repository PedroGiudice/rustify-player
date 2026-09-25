#!/usr/bin/env python3
"""Testes do validate.py que travam a paridade com o backend (desktop.rs).

Sem pytest: asserts puros + runner, no padrão de scripts/curator/
test_discover_tracks.py. Cobre:
  - sistema-v1: rampa fg invertida. Os YAMLs da cmr-auto declaram fg-8 como
    'dividers.prominent (alias rgb, sem alpha)': o hex do rgba SEM o alpha
    0.16, ou seja, a cor do texto principal. fg-8 == fg-1 em 4 temas e fg-7
    mais claro que fg-5 em 9. O backend corrige na saída (enforce_fg_ramp);
    o validador replica, com os MESMOS números do teste Rust
    fg_ramp_invertida_e_corrigida_como_no_validate_py.

Rodar: python3 scripts/themes/test_validate.py
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import validate as V

FAILS = []


def check(name, got, want):
    status = "ok" if got == want else "FAIL"
    print(f"[{status}] {name}: {got!r}" + ("" if got == want else f" (esperado {want!r})"))
    if got != want:
        FAILS.append(name)


# Recorte do theme-copper-default.yaml da cmr-auto (25/09): rampa invertida.
COPPER = """
name: Copper
author: CI
surfaces:
  lowest: "#111110"
  base: "#151513"
dividers:
  subtle: "rgba(237, 234, 227, 0.08)"
  prominent: "rgba(237, 234, 227, 0.16)"
text:
  primary: "#edeae3"
  secondary: "#a29e94"
  muted: "#85827b"
fg-2: '#e6e2db'
fg-3: '#a29e94'
fg-5: '#85827b'
fg-7: '#afaca5'
fg-8: '#edeae3'
"""

# Rampa já monotônica (really-dark.yaml): nada muda.
MONOTONICA = """
name: Dark
surfaces:
  lowest: "#050505"
dividers:
  prominent: "rgba(255, 255, 255, 0.16)"
text:
  primary: "#F0F0F0"
  muted: "#808080"
fg-7: '#6e6e6e'
fg-8: '#404040'
"""

# Sem fg-7/fg-8 explícitos: o bridge põe fg-8 = rgba do divider (com alpha),
# que já é fraco — fica intocado (string rgba preservada).
BRIDGE_PURO = """
name: Bridge
surfaces:
  lowest: "#111111"
dividers:
  prominent: "rgba(255,255,255,0.16)"
text:
  primary: "#edeae3"
  muted: "#85827b"
"""


def vars_of(yaml_text):
    import yaml
    doc = yaml.safe_load(yaml_text)
    out, dropped = {}, []
    V.flatten(doc, "", out, dropped)
    V.apply_bridge(out)
    return out, dropped


def test_rampa_invertida_corrigida():
    v, _ = vars_of(COPPER)
    fixes = V.enforce_fg_ramp(v)
    # fg-8 = dividers.prominent COMPOSTO sobre o canvas (com o alpha 0.16).
    check("copper fg-8", v["--fg-8"], "#343432")
    # fg-7 = 60% do degrau âncora (fg-6 = text.muted) + 40% do fg-8.
    check("copper fg-7", v["--fg-7"], "#65635e")
    check("copper correções", [k for k, _, _ in fixes], ["--fg-7", "--fg-8"])
    canvas = V.hex_to_rgb(v["--bg-canvas"])
    s = [V.contrast(V.hex_to_rgb(v[f"--fg-{i}"]), canvas) for i in (5, 6, 7, 8)]
    check("copper rampa monotônica (fg-5..fg-8)", all(a >= b for a, b in zip(s, s[1:])), True)


def test_rampa_monotonica_intocada():
    v, _ = vars_of(MONOTONICA)
    fixes = V.enforce_fg_ramp(v)
    check("monotônica sem correção", fixes, [])
    check("monotônica fg-7", v["--fg-7"], "#6e6e6e")
    check("monotônica fg-8", v["--fg-8"], "#404040")


def test_bridge_rgba_intocado():
    v, _ = vars_of(BRIDGE_PURO)
    fixes = V.enforce_fg_ramp(v)
    check("bridge puro sem correção", fixes, [])
    check("bridge puro fg-8 rgba preservado", v["--fg-8"], "rgba(255,255,255,0.16)")


def test_validate_file_avisa_rampa():
    with tempfile.NamedTemporaryFile("w", suffix=".yaml", delete=False) as f:
        f.write(COPPER)
        path = f.name
    try:
        problems, warns = V.validate_file(path)
    finally:
        os.unlink(path)
    check("copper sem reprovação", problems, [])
    check("copper avisa fg-8", any("fg-8" in w and "#343432" in w for w in warns), True)
    check("copper avisa fg-7", any("fg-7" in w and "#65635e" in w for w in warns), True)


def test_prefixo_lyrics():
    v, dropped = vars_of("name: L\nlyrics:\n  bg-alpha: 0.3\n  bg-brightness: 0.7\n")
    check("lyrics-bg-alpha vira var", v.get("--lyrics-bg-alpha"), "0.3")
    check("lyrics-bg-brightness vira var", v.get("--lyrics-bg-brightness"), "0.7")
    check("lyrics nada descartado", dropped, [])


def main():
    for name, fn in list(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
    if FAILS:
        print(f"\n{len(FAILS)} falha(s): {FAILS}")
        return 1
    print("\ntodos ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
