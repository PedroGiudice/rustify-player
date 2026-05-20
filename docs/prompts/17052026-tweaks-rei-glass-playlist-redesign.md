# Retomada: TweaksPanel hub + glass + playlist redesign + EQ real

## Contexto rapido

Sessao longa de polish do Rustify Player. 9 releases publicados (v0.2.14 ate
v0.2.22), branch `main` esta 25 commits ahead da origin. Tag `dev` no GH ja
contem o build mais recente (`rustify-player_0.2.22_amd64.deb`).

Trabalho concentrado em:
1. Migracao do painel Tweaks legacy (JS innerHTML destrutivo) pro Solid com
   signals — eliminou freeze classico do slider.
2. Pagina da playlist nova (`/playlist/:name`) com hero mosaico 2x2 +
   tracklist com cover por linha. Click em card abre essa view; pins
   persistidos via `src/store/pins.ts`.
3. Glass lyrics ajustavel — slider `Lyrics glass` no Tweaks controla alpha
   do background + brightness do backdrop-filter. Bg ink (cor das linhas do
   spectrum) tambem via color picker no Tweaks.
4. EqCanvas refeito pra desenhar resposta paramétrica real (Lorentziana
   somando bandas) — antes so conectava dots, ignorava Q.
5. CSS portado pro bundle correto (RES button funcional), shuffle adaptive
   por queueScope, spectrum congela sem audio.

**Decisao arquitetural cristalizada:** TweaksPanel eh o hub canonico de
customizacao. Documentado em `CLAUDE.md` (secao "TweaksPanel e o hub de
customizacao"). Antes de propor YAML ou UI dedicada pra um knob, considerar
adicionar no Tweaks.

## Arquivos principais

Documentacao desta sessao:
- `docs/contexto/17052026-tweaks-rei-glass-playlist-redesign.md` — contexto detalhado
- `docs/bugs/17052026-tweaks-font-slider-freeze.md` — bug doc que motivou a migracao Solid

Codigo (hub Tweaks):
- `src/store/tweaks.ts` — schema + applyTweaks + persistencia
- `src/views/Tweaks.tsx` — painel Solid via Portal
- `src/styles/extractor-lab.css` — `.tweaks*`, `.segmented*`, novos blocos `.pl-hero-*`, `.tracks--with-cover`, `.tweaks__color`

Codigo (features da sessao):
- `src/views/Playlist.tsx` — pagina por playlist (hero + tracklist com cover)
- `src/views/Playlists.tsx` — lista com pins reais + navigate
- `src/store/pins.ts` — pins em localStorage
- `src/views/NowPlaying.tsx` — drag/resize com rAF throttle + classe `is-interacting`
- `src/components/dsp/EqCanvas.tsx` — curva real Lorentziana + eixo Y
- `src/components/SpectrumCanvas.tsx` — pausa loop sem audio + le `--bg-ink-rgb`

Regra do projeto:
- `CLAUDE.md` — secao "TweaksPanel e o hub de customizacao"

## Proximos passos (por prioridade)

### 1. Push pra origin/main
**Onde:** raiz do repo
**O que:** `git push origin main` (25 commits locais a sincronizar)
**Por que:** estado local diverge da origin ha tempo
**Verificar:** `git status` -> "Your branch is up to date with 'origin/main'"

### 2. Validar visual do redesign da playlist no v0.2.22
**Onde:** rota `/playlist/:name` no app rodando na cmr-auto
**O que:** abrir uma playlist com varios albuns distintos, conferir:
  - Mosaico 2x2 do hero forma corretamente
  - Tracklist tem cover por linha sem text overflow
  - Botoes Pin/Play funcionais, estado `is-on` no Pin quando pinada
**Por que:** ultimo redesign visual da sessao; user flagou "destoando muito"
no v0.2.18, refeito no v0.2.21. Confirmar resolveu.
**Verificar:** screenshot ou feedback do user

### 3. Decidir destino dos untracked
**Onde:** raiz e `docs/`
**O que:**
  - `docs/Cassette _ Paper Outline.png` — fonte do logo. Ja copiada pra
    `src/assets/logo-cassette.png`. Commitar a fonte ou .gitignore?
  - `docs/rustify-player-new-telas.zip` + pasta — handoff de telas futuras.
    Manter no docs/? Mover pra outro lugar? Adicionar ao .gitignore?
  - `.zed/` — config local do editor. Deve ir pro `.gitignore` global.
**Por que:** `git status` mantem estes 4 itens em untracked desde o inicio
da sessao. Limpar.
**Verificar:** `git status` limpo

### 4. Considerar extensoes do hub Tweaks
**Onde:** `src/store/tweaks.ts` + `src/views/Tweaks.tsx`
**O que:** se aparecer pedido de novo knob de usuario, primeiro avaliar se
cabe no padrao Tweaks (signal + CSS var + applyTweaks). Lista de extensoes
faceis que ja vivem no padrao: density, sidebar, type, scale, glow, lyrics
glass, bg ink.
**Por que:** regra documentada em CLAUDE.md; aplicar.
**Verificar:** review do diff antes de propor YAML/Tauri command novo

### 5. (Opcional) Aplicar .tracks--with-cover em Tracks.tsx/History.tsx
**Onde:** `src/views/Tracks.tsx`, `src/views/History.tsx`
**O que:** trocar `class="tracks"` por `class="tracks tracks--with-cover"` +
adicionar `<div class="tracks__cover">` por linha com `album_cover_path`.
**Por que:** consistencia visual com Playlist.tsx. Validar UX antes —
listagens muito longas podem ficar com ruido visual demais.
**Verificar:** screenshot lado a lado

## Restricoes

- **Nao compilar local na cmr-auto.** Usar `./scripts/release.sh` na VM
  (i5 8th gen da cmr-auto leva minutos; VM Contabo leva segundos). Regra
  ja vive em `CLAUDE.md` do projeto.
- **TweaksPanel eh Rei.** Antes de criar YAML novo, Tauri command novo, ou
  UI dedicada pra um knob de usuario, considerar Tweaks primeiro.
- **`src/styles/components.css` esta orfao no bundle.** O app so importa
  `extractor-lab.css` (via main.tsx + index.html). Antes de adicionar regra
  em components.css, perguntar se eh ainda usado — provavelmente o bloco
  todo deveria sair do repo. (Ver bug do RES button — mesmo padrao.)
- **Tema visual e LIGHT** (paper, branco). `src/styles/tokens.css` define
  um tema DARK mas nao esta importado em lugar nenhum. Nao usar `--surface`,
  `--on-surface` etc — usar `--bg-paper`, `--fg-1` (de extractor-lab.css).

## Como verificar

```bash
# Repo limpo
cd /home/opc/rustify-player
git status                                      # untracked apenas (.zed, docs/*)
git log --oneline -1                            # 5093946 docs(claude): TweaksPanel...

# Build local
cargo check --manifest-path src-tauri/Cargo.toml  # "Finished" sem erros
bunx --bun vite build 2>&1 | tail -1            # "built in ..."

# Versao
python3 -c "import json; print(json.load(open('src-tauri/tauri.conf.json'))['version'])"
# -> 0.2.22

# Estado do release tag dev no GH
gh release view dev -R PedroGiudice/rustify-player --json tagName,assets | jq -r '.tagName, (.assets[].name)'
# -> dev
# -> rustify-player_0.2.22_amd64.deb
```

## Atalhos de teste no app rodando (cmr-auto)

```bash
# Puxar e instalar v0.2.22
gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber
sudo dpkg -i /tmp/rustify-player_0.2.22_amd64.deb

# Conectar via Tauri MCP da VM Contabo (se precisar inspecionar live)
# 1. SSH tunnel
ssh -fN -L 9223:127.0.0.1:9223 cmr-auto@100.102.249.9
# 2. mcp__tauri__driver_session start host=127.0.0.1 port=9223
# CUIDADO: WebKit pode travar quando ha drag/resize ativo no lyrics box
# combinado com injection JS. Evitar mexer durante interacao.
```
