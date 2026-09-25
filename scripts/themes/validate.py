#!/usr/bin/env python3
"""Valida YAML de temas do Rustify contra a lógica do backend (lib.rs).

Réplica exata de yaml_key_to_css_prop + bridge_legacy_to_extractor_lab +
os pares de contraste WCAG do load_theme. Usado pelo subagente theme-maker
e em verificação manual antes de deploy.

Uso:
    python3 scripts/themes/validate.py <dir-ou-arquivo.yaml> [...]

Sai com código 1 se qualquer tema tiver: parse error, chave descartada,
par de contraste AA reprovado (incluindo on-primary sobre primary/container,
buraco que deixou o Uvinha shippar botão ilegível), ou hex malformado em
token de cor.

Além dos erros, emite AVISOS (não reprovam): colapso semântico entre
sig-ok/warn/err, erro indistinguível do accent, hierarquia de texto
duplicada, rampa fg invertida (fg-7/fg-8 mais fortes que o degrau
anterior — o backend corrige na saída, com os mesmos números daqui). Avisos existem pra guiar a curadoria (theme-maker); temas
monocromáticos legítimos os disparariam como erro, por isso não gateiam.
"""
import sys, glob, os, re
import yaml

# ── Camada 1: aliases (espelho de yaml_key_to_css_prop) ────────────────
LEGACY = {
    "surfaces-lowest": "--surface-lowest",
    "surfaces-base": "--surface",
    "surfaces-container-low": "--surface-container-low",
    "surfaces-container": "--surface-container",
    "surfaces-container-high": "--surface-container-high",
    "surfaces-container-highest": "--surface-container-highest",
    "dividers-subtle": "--divider",
    "dividers-prominent": "--divider-hi",
    "accent-primary": "--primary",
    "accent-primary-container": "--primary-container",
    "accent-primary-fixed-dim": "--primary-fixed-dim",
    "accent-on-primary": "--on-primary",
    "accent-on-primary-container": "--on-primary-container",
    "text-primary": "--on-surface",
    "text-secondary": "--on-surface-variant",
    "text-muted": "--on-surface-mute",
    "text-outline": "--outline-variant",
    "signal-ok": "--sig-ok",
    "signal-warn": "--sig-warn",
    "signal-error": "--sig-err",
    "typography-body": "--font-body",
    "typography-display": "--font-display",
    "typography-mono": "--font-mono",
    "typography-mono-legacy": "--font-mono",
    "typography-technical": "--font-technical",
    "effects-glow": "--glow",
    "effects-halo": "--halo-alpha",
    "effects-surface-blur": "--surface-blur",
    "effects-surface-opacity": "--surface-opacity",
    # ── Schema novo (themes boost 2026-07) ──
    "glass-tint": "--glass-tint",
    "glass-alpha": "--glass-alpha",
    "glass-blur": "--glass-blur",
    "background-ink": "--bg-ink",
    "motion-fast": "--dur-fast",
    "motion-base": "--dur-base",
    "motion-med": "--dur-med",
    "motion-ease": "--ease-out",
}
# tones-*/shadows-* replicam o strip_prefix open-ended do Rust (qualquer
# nome passa; TONE_NAMES fica só pros pares de contraste). radius-* cai na
# camada 2 (prefixo permitido), igual ao backend.
TONE_NAMES = ["mint", "sky", "peach", "rose", "lavender", "butter", "bone", "paper"]

ALLOWED_PREFIXES = ["fg-", "bg-", "line-", "tone-", "blue-", "green-", "amber-",
                    "rose-", "purple-", "radius-", "shadow-", "dur-", "ease-", "font-"]
ALLOWED_EXACT = ["ring-focus", "sidebar-w", "playerbar-h", "titlebar-h"]

BRIDGE = [
    ("--surface-lowest",            ["--bg-canvas"]),
    ("--surface",                   ["--bg-paper"]),
    ("--surface-container-low",     ["--bg-sunken"]),
    ("--surface-container",         ["--bg-soft"]),
    ("--surface-container-high",    ["--bg-tint"]),
    ("--surface-container-highest", ["--bg-faint"]),
    ("--divider",    ["--line-2", "--line-3"]),
    ("--divider-hi", ["--line-1"]),
    ("--on-surface",         ["--fg-1", "--fg-2"]),
    ("--on-surface-variant", ["--fg-3", "--fg-4"]),
    ("--on-surface-mute",    ["--fg-5", "--fg-6", "--fg-7"]),
    ("--divider-hi",         ["--fg-8"]),
    ("--primary",           ["--blue-fg", "--blue-ring"]),
    ("--surface-container", ["--blue-bg"]),
    ("--sig-ok",            ["--green-fg", "--green-ring"]),
    ("--surface-container-low", ["--green-bg"]),
    ("--sig-warn",          ["--amber-fg", "--amber-ring"]),
    ("--surface-container-low", ["--amber-bg"]),
    ("--sig-err",           ["--rose-fg", "--rose-ring"]),
    ("--surface-container-low", ["--rose-bg"]),
    ("--primary",           ["--purple-fg", "--purple-ring"]),
    ("--surface-container-low", ["--purple-bg"]),
]

PAIRS = [
    ("texto/canvas",      "--fg-1",    "--bg-canvas"),
    ("texto/paper",       "--fg-1",    "--bg-paper"),
    ("secundario/canvas", "--fg-3",    "--bg-canvas"),
    ("secundario/paper",  "--fg-3",    "--bg-paper"),
    ("apagado/paper",     "--fg-5",    "--bg-paper"),
    ("apagado/canvas",    "--fg-5",    "--bg-canvas"),
    ("accent/canvas",     "--blue-fg", "--bg-canvas"),
    ("accent/paper",      "--blue-fg", "--bg-paper"),
    ("texto/accent-bg",   "--fg-1",    "--blue-bg"),
    ("ok/canvas",         "--green-fg","--bg-canvas"),
    ("warn/canvas",       "--amber-fg","--bg-canvas"),
    ("erro/canvas",       "--rose-fg", "--bg-canvas"),
    ("on-primary/primary",   "--on-primary", "--primary"),
    ("on-primary/container", "--on-primary-container", "--primary-container"),
]

HEX_RE = re.compile(r"^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$")
COLOR_TOKEN_PREFIXES = ("--fg", "--bg-", "--tone-", "--blue", "--green", "--amber",
                        "--rose", "--purple", "--sig", "--primary", "--on-",
                        "--surface-", "--divider", "--line", "--outline")
# tokens que casam com prefixo de cor mas não são cor (ou aceitam outro formato).
# --bg-ink fica FORA: o frontend deriva --bg-ink-rgb via hexToRgb, que só
# aceita hex — ink não-hex passaria aqui e falharia silencioso no app.
NON_HEX_OK = {"--glass-tint", "--surface-blur", "--surface-opacity"}


def key_to_prop(key):
    if key in LEGACY:
        return LEGACY[key]
    # Seções plurais → tokens singulares (open-ended, espelha o strip_prefix
    # do lib.rs — 'shadows.knob' vira --shadow-knob, 'tones.sage.bg' passa).
    if key.startswith("tones-"):
        return "--tone-" + key[len("tones-"):]
    if key.startswith("shadows-"):
        return "--shadow-" + key[len("shadows-"):]
    if key in ALLOWED_EXACT or any(key.startswith(p) for p in ALLOWED_PREFIXES):
        return f"--{key}"
    return None


def flatten(val, prefix, out, dropped):
    if isinstance(val, dict):
        for k, v in val.items():
            k = str(k)
            if k in ("name", "author"):
                continue
            np = k if not prefix else f"{prefix}-{k}"
            flatten(v, np, out, dropped)
    elif isinstance(val, (str, int, float)):
        prop = key_to_prop(prefix)
        if prop is not None:
            out[prop] = str(val)
        else:
            dropped.append(prefix)


def apply_bridge(vars_):
    """Espelho de bridge_legacy_to_extractor_lab: só preenche o que o YAML
    não declarou."""
    for legacy, targets in BRIDGE:
        if legacy in vars_:
            for t in targets:
                vars_.setdefault(t, vars_[legacy])


def hex_to_rgb(h):
    h = h.lstrip("#")
    if len(h) < 6:
        return None
    try:
        return tuple(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    except ValueError:
        return None


def lum(r, g, b):
    lin = lambda c: c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)


def contrast(c1, c2):
    l1, l2 = lum(*c1), lum(*c2)
    hi, lo = max(l1, l2), min(l1, l2)
    return (hi + 0.05) / (lo + 0.05)


# ── Rampa fg (espelho de enforce_fg_ramp no desktop.rs) ─────────────────
# Mesmas fórmulas, na mesma ordem, pra dar o mesmo hex byte a byte; o
# arredondamento imita o f64::round do Rust (meio pra longe do zero), que o
# round() do Python (banker's) não faz.

def parse_css_color(v):
    """'#rrggbb', '#rrggbbaa', 'rgb(r,g,b)' ou 'rgba(r,g,b,a)' -> (r,g,b,a)
    em 0..1, ou None."""
    v = str(v).strip()
    if v.startswith("#"):
        h = v[1:]
        if len(h) not in (6, 8):
            return None
        try:
            ch = [int(h[i:i + 2], 16) / 255.0 for i in range(0, len(h), 2)]
        except ValueError:
            return None
        return (ch[0], ch[1], ch[2], ch[3] if len(ch) == 4 else 1.0)
    low = v.lower()
    if low.startswith("rgb(") or low.startswith("rgba("):
        if not low.endswith(")"):
            return None
        parts = [p.strip() for p in v[v.index("(") + 1:-1].split(",")]
        if len(parts) not in (3, 4):
            return None
        try:
            r, g, b = (float(p) / 255.0 for p in parts[:3])
            a = float(parts[3]) if len(parts) == 4 else 1.0
        except ValueError:
            return None
        return (r, g, b, min(1.0, max(0.0, a)))
    return None


def _over(c, bg):
    r, g, b, a = c
    return (r * a + bg[0] * (1.0 - a), g * a + bg[1] * (1.0 - a), b * a + bg[2] * (1.0 - a))


def _mix(x, y, t):
    return (x[0] * (1.0 - t) + y[0] * t, x[1] * (1.0 - t) + y[1] * t, x[2] * (1.0 - t) + y[2] * t)


def _round_half_away(x):
    f = float(int(x // 1))
    return f + 1.0 if x - f >= 0.5 else f


def _to_hex(rgb):
    def c(v):
        return int(min(255.0, max(0.0, _round_half_away(v * 255.0))))
    return "#{:02x}{:02x}{:02x}".format(c(rgb[0]), c(rgb[1]), c(rgb[2]))


def enforce_fg_ramp(vars_):
    """fg-7 e fg-8 nunca mais fortes (contraste contra o canvas) que o degrau
    anterior. Corrige no lugar e devolve [(chave, antes, depois)].

    Derivação de reposição: o 'chão' é dividers.prominent COMPOSTO sobre o
    canvas (o que os YAMLs pretendiam ao derivar fg-8 dele, sem descartar o
    alpha); fg-7 = 60% do degrau âncora (fg-6, senão fg-5) + 40% do chão."""
    canvas_c = parse_css_color(vars_.get("--bg-canvas", ""))
    if canvas_c is None:
        return []
    canvas = canvas_c[:3]
    anchor_key = "--fg-6" if parse_css_color(vars_.get("--fg-6", "")) else "--fg-5"
    anchor_c = parse_css_color(vars_.get(anchor_key, ""))
    if anchor_c is None:
        return []
    anchor = _over(anchor_c, canvas)

    def strength(rgb):
        return contrast(rgb, canvas)

    s_anchor = strength(anchor)
    floor = None
    div = parse_css_color(vars_.get("--divider-hi", ""))
    if div is not None:
        d = _over(div, canvas)
        if strength(d) < s_anchor:
            floor = d
    if floor is None:
        floor = _mix(anchor, canvas, 0.5)

    fixes = []
    rgb7 = None
    c7 = parse_css_color(vars_.get("--fg-7", ""))
    if c7 is not None:
        rgb7 = _over(c7, canvas)
        if strength(rgb7) > s_anchor:
            new = _to_hex(_mix(anchor, floor, 0.4))
            fixes.append(("--fg-7", vars_["--fg-7"], new))
            vars_["--fg-7"] = new
            rgb7 = parse_css_color(new)[:3]
    c8 = parse_css_color(vars_.get("--fg-8", ""))
    if c8 is not None:
        ref = strength(rgb7) if rgb7 is not None else s_anchor
        if strength(_over(c8, canvas)) > ref:
            base = rgb7 if rgb7 is not None else anchor
            pick = floor if strength(floor) <= ref else _mix(base, canvas, 0.5)
            new = _to_hex(pick)
            fixes.append(("--fg-8", vars_["--fg-8"], new))
            vars_["--fg-8"] = new
    return fixes


def rgb_to_hsl(r, g, b):
    mx, mn = max(r, g, b), min(r, g, b)
    l = (mx + mn) / 2
    if mx == mn:
        return 0.0, 0.0, l
    d = mx - mn
    s = d / (2 - mx - mn) if l > 0.5 else d / (mx + mn)
    if mx == r:
        h = ((g - b) / d + (6 if g < b else 0)) / 6
    elif mx == g:
        h = ((b - r) / d + 2) / 6
    else:
        h = ((r - g) / d + 4) / 6
    return h, s, l


def hue_dist_deg(h1, h2):
    d = abs(h1 - h2) * 360
    return min(d, 360 - d)


def semantic_warnings(vars_):
    """Avisos de curadoria: só falam quando AMBAS as cores têm chroma real
    (s >= 0.2) — tema monocromático de propósito não dispara nada."""
    warns = []
    def hsl(key):
        v = vars_.get(key)
        rgb = hex_to_rgb(v) if v else None
        return rgb_to_hsl(*rgb) if rgb else None

    sigs = {k: hsl(f"--sig-{k}") for k in ("ok", "warn", "err")}
    for a, b in (("ok", "warn"), ("warn", "err"), ("ok", "err")):
        ca, cb = sigs[a], sigs[b]
        if ca and cb and ca[1] >= 0.2 and cb[1] >= 0.2:
            if hue_dist_deg(ca[0], cb[0]) < 18 and abs(ca[2] - cb[2]) < 0.18:
                warns.append(f"sinais sig-{a} e sig-{b} quase idênticos (colapso semântico)")
    err, prim = hsl("--sig-err"), hsl("--primary")
    if err and prim and err[1] >= 0.2 and prim[1] >= 0.2:
        if hue_dist_deg(err[0], prim[0]) < 10 and abs(err[2] - prim[2]) < 0.10:
            warns.append("sig-err indistinguível do accent (--primary)")
    if vars_.get("--fg-2") and vars_.get("--fg-2") == vars_.get("--fg-3"):
        warns.append("fg-2 == fg-3 (hierarquia de texto duplicada)")
    ink, canvas = vars_.get("--bg-ink"), vars_.get("--bg-canvas")
    if ink and canvas:
        ci, cc = hex_to_rgb(ink), hex_to_rgb(canvas)
        if ci and cc and contrast(ci, cc) < 3.0:
            warns.append(
                f"bg-ink {contrast(ci, cc):.2f}:1 vs canvas — o backend corrige "
                "no load_theme (piso 3:1), mas declare um ink com presença"
            )
    return warns


def validate_file(fn):
    """Retorna (problemas, avisos). Problemas vazios = tema válido."""
    problems = []
    try:
        with open(fn) as f:
            doc = yaml.safe_load(f)
    except Exception as e:
        return [f"PARSE ERROR: {e}"], []
    if not isinstance(doc, dict):
        return ["raiz não é mapping"], []

    vars_, dropped = {}, []
    flatten(doc, "", vars_, dropped)
    apply_bridge(vars_)
    ramp_fixes = enforce_fg_ramp(vars_)

    for d in dropped:
        problems.append(f"chave descartada (não vira var): {d}")

    for k, v in sorted(vars_.items()):
        if k in NON_HEX_OK:
            continue
        if k.startswith(COLOR_TOKEN_PREFIXES):
            if not (HEX_RE.match(v) or v.startswith("rgba(") or v.startswith("rgb(")):
                problems.append(f"valor de cor inválido: {k} = {v!r}")

    # pares fixos + tones declarados (fg-1 sobre QUALQUER --tone-*-bg
    # presente — espelho do loop dinâmico do load_theme, cobre tone custom)
    pairs = list(PAIRS)
    for k in sorted(vars_):
        if k.startswith("--tone-") and k.endswith("-bg"):
            name = k[len("--tone-"):-len("-bg")]
            pairs.append((f"tone-{name}", "--fg-1", k))

    for label, fgk, bgk in pairs:
        fg, bg = vars_.get(fgk), vars_.get(bgk)
        if fg is None or bg is None:
            continue  # par não populado: mesmo comportamento do backend
        c1, c2 = hex_to_rgb(fg), hex_to_rgb(bg)
        if c1 is None or c2 is None:
            continue  # rgba etc: backend também pula
        r = contrast(c1, c2)
        if r < 4.5:
            problems.append(f"contraste AA reprovado {label}: {r:.2f} (fg={fg} bg={bg})")
    warns = semantic_warnings(vars_)
    for key, before, after in ramp_fixes:
        warns.append(
            f"rampa fg invertida: {key[2:]} {before} mais forte que o degrau anterior "
            f"— o backend corrige para {after}; declare a rampa decrescente"
        )
    return problems, warns


def main():
    targets = []
    for arg in sys.argv[1:] or ["."]:
        if os.path.isdir(arg):
            targets.extend(sorted(glob.glob(os.path.join(arg, "*.yaml"))))
            targets.extend(sorted(glob.glob(os.path.join(arg, "*.yml"))))
        else:
            targets.append(arg)
    if not targets:
        print("nenhum YAML encontrado", file=sys.stderr)
        return 1

    failed = 0
    for fn in targets:
        problems, warns = validate_file(fn)
        status = "OK" if not problems else "FALHOU"
        print(f"{os.path.basename(fn)}: {status}")
        for p in problems:
            print(f"  - {p}")
        for w in warns:
            print(f"  - aviso: {w}")
        failed += bool(problems)
    print(f"\n{len(targets) - failed}/{len(targets)} temas válidos")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
