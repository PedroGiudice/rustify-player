# Tema YAML — schema

Themes vivem em `~/.local/share/rustify-player/themes/*.yaml`. São aplicados em runtime via comando Tauri `load_theme(filename)`. Hot-reload está ativo via `watchTheme(filename)`.

## Como funciona

O carregador faz, em ordem:

1. Parse do YAML para um map plano `prefix-key → value` (e.g. `surfaces.lowest: '#111'` vira `surfaces-lowest`).
2. Cada key reconhecida é mapeada para a CSS custom property correspondente.
3. **Bridge legacy → Extractor Lab**: tokens do vocabulário antigo (`surfaces.*`, `text.*`, `accent.primary`, `signal.*`) derivam automaticamente os 30+ tokens do design system atual (`--fg-1..8`, `--bg-*`, `--blue-*`, `--green-*`, etc).
4. CSS custom properties são aplicadas no `:root`.
5. Pares WCAG são computados e devolvidos ao frontend pra exibir na calculadora de contraste.

Resultado: você só precisa preencher o **vocabulário curto**, e o app deriva o resto. Se quiser controle fino sobre algum token específico (e.g. customizar `--green-bg` separado do default derivado), basta declará-lo explicitamente.

## Vocabulário curto (recomendado — preenche tudo via bridge)

```yaml
name: Studio
author: CMR

# Backgrounds em ordem do mais escuro pro mais claro (dark mode)
# ou do mais claro pro mais escuro (light mode).
surfaces:
  lowest:                 '#0a0a0a'   # plano de fundo principal (--bg-canvas)
  base:                   '#111111'   # cards (--bg-paper)
  container-low:          '#1a1a1a'   # sub-cards (--bg-sunken)
  container:              '#222222'   # rows hover (--bg-soft)
  container-high:         '#2a2a2a'   # zonas elevadas (--bg-tint)
  container-highest:      '#333333'   # destaques sutis (--bg-faint)

# Linhas separadoras
dividers:
  subtle:                 'rgba(255,255,255,0.06)'   # entre rows (--divider, --line-2/3)
  prominent:              'rgba(255,255,255,0.14)'   # entre seções (--divider-hi, --line-1, --fg-8)

# Texto — bridge deriva os 8 níveis fg-1..fg-8
text:
  primary:                '#f5f5f5'   # texto principal (--fg-1, --fg-2)
  secondary:              '#a0a0a0'   # secundário (--fg-3, --fg-4)
  muted:                  '#707070'   # muted (--fg-5, --fg-6, --fg-7)
  outline:                'rgba(255,255,255,0.16)'

# Accent — única cor de destaque. Bridge propaga pra blue + purple.
accent:
  primary:                '#8aabff'   # (--blue-fg, --blue-ring, --purple-fg, --purple-ring)
  primary-container:      '#243a8c'
  primary-fixed-dim:      '#243a8c'
  on-primary:             '#000000'
  on-primary-container:   '#dbe2ff'

# Sinais semânticos — bridge propaga pra fg+ring de cada triplet
signal:
  ok:                     '#5fb360'   # (--sig-ok, --green-fg, --green-ring)
  warn:                   '#cfa560'   # (--sig-warn, --amber-fg, --amber-ring)
  error:                  '#c46b58'   # (--sig-err, --rose-fg, --rose-ring)

typography:
  body:                   'Inter, sans-serif'
  display:                'Fraunces, serif'
  technical:              'JetBrains Mono, monospace'

effects:
  glow:                   0.15
  surface-blur:           '20px'
  surface-opacity:        0.85
```

## Override de tokens específicos (opcional)

Se quiser distinguir os backgrounds dos badges semânticos (que por default no bridge compartilham `--surface-container-low`), declare diretamente:

```yaml
# … bloco anterior + adicionar:

green-bg:                 'rgba(95,179,96,0.10)'
amber-bg:                 'rgba(207,165,96,0.10)'
rose-bg:                  'rgba(196,107,88,0.10)'
blue-bg:                  'rgba(138,171,255,0.10)'
purple-bg:                'rgba(180,140,220,0.10)'

# Ou customizar a escala fg-* (anula derivação do bridge):
fg-5:                     '#888'
fg-7:                     '#555'
fg-8:                     'rgba(255,255,255,0.06)'

# Ou layout primitives:
radius-md:                '8px'
shadow-sm:                '0 1px 2px rgba(0,0,0,0.04)'
```

Qualquer key com prefixo abaixo é pass-through direto pra `--{key}`:

- `fg-*`, `bg-*`, `line-*`
- `blue-*`, `green-*`, `amber-*`, `rose-*`, `purple-*`
- `tone-*` (album cover pastels)
- `radius-*`, `shadow-*`, `dur-*`, `ease-*`, `font-*`
- Keys exatas: `ring-focus`, `sidebar-w`, `playerbar-h`, `titlebar-h`

## Hot-reload

Edite o YAML enquanto o app está aberto — o watcher emite `theme-changed`, o frontend re-aplica e a calculadora de contraste re-computa em <2s.

## Validação

Settings → "Tema YAML" mostra:
- Tema atual + nome + autor
- Calculadora de contraste com todos os pares WCAG e badges AAA/AA/AA-large/fail
- Hot-reload status

Se um par WCAG falhar (< 4.5:1), aparece com badge `fail` — sinal pra ajustar os hex correspondentes.
