# Retomada: Menu de contexto de faixa + bg + ícones

## Contexto rápido

Rustify Player (Tauri 2 + SolidJS, biblioteca local). Nesta sessão: (1) reintroduzi o menu de contexto de faixa (right-click) — morto na migração pra Solid — como `TrackContextMenu.tsx` (singleton Solid via Portal) + `store/contextMenu.ts`, ligado nos 2 TrackRow consolidados, backend 100% reusado; (2) tornei o painel `.tracks` translúcido (rgba 0.78) pro background animado vazar em Playlist/Album/Tracks; (3) diagnostiquei (não corrigi) os "ícones invisíveis" = dependência de CDN externa (`code.iconify.design`) com o webview da cmr-auto offline.

Um bug crítico desta sessão e a lição: o menu "não abria" porque coloquei o CSS `.track-ctx-menu` em `src/styles/components.css`, que é **órfão** (não importado — `main.tsx` só importa `extractor-lab.css`). Build e tsc passaram, mas o CSS sumiu do bundle e o menu renderizava fora da tela. Corrigido (movido pro `extractor-lab.css`) e **verificado no dist**. Tudo em `main`, releases v0.2.31 e v0.2.32 (tag rolling `dev`) publicadas, **commits não pushados**.

<session_metadata>
branch: main
commits: 252ff56 (feat menu+bg), 8ce5755 (fix CSS órfão)
working_tree: limpo p/ esta feature (untracked alheios: docs/, scripts/curator/, CLAUDE.md/music-curator.md modificados pré-sessão)
version: 0.2.32
pushed: no
release_tag: dev (rolling)
</session_metadata>

## Arquivos principais

- `src/components/TrackContextMenu.tsx` — menu Solid singleton (Portal), itens + ações
- `src/store/contextMenu.ts` — signal trackMenu + openTrackMenu/closeTrackMenu
- `src/components/TrackRowTable.tsx` / `TrackRowList.tsx` — onContextMenu + prop contextList
- `src/styles/extractor-lab.css` — ÚNICO CSS no bundle; `.tracks` (bg 0.78) + `.track-ctx-menu` (fim do arquivo)
- `src/styles/components.css` — ÓRFÃO, não importado; NÃO adicionar CSS aqui
- `index.html` (linha 9) — tag CDN do iconify (causa dos ícones offline)
- `docs/contexto/05062026-context-menu-fix-bg-icons.md` — contexto detalhado desta sessão
- Memórias: `project_components_css_orphan`, `project_iconify_cdn_offline_debt`

## Próximos passos (por prioridade)

### 1. Aguardar validação visual do usuário (v0.2.32)
**Onde:** app na cmr-auto.
**O que:** confirmar (a) right-click numa faixa abre o menu no cursor (Tracks/Álbum/Playlist/Home/Histórico); (b) bg `.tracks` 0.78 — canvas atrás da tabela no ponto.
**Por que:** o build passa com defeito visual (foi o caso do CSS órfão); só o olho valida.
**Verificar:** usuário testa; se bg sutil/forte demais, ajustar o alpha em `extractor-lab.css` `.tracks` (menor = mais canvas).

### 2. Ícones offline → bundle local (quando o usuário liberar)
**Onde:** `index.html` (remover tag CDN linha 9), `src/main.tsx` (+`import "iconify-icon"` + `addCollection(lucide)`), `src-tauri/tauri.conf.json` (limpar `code.iconify.design`/`api.iconify.design` do CSP).
**O que:** `npm i iconify-icon @iconify-json/lucide`; registrar lucide via addCollection; `ph:heart-fill` via `addIcon` individual (set ph inteiro ~3MB).
**Por que:** ícones somem offline (cmr-auto); viola `no-cdn-assets`.
**Verificar:** após build, `rg 'iconify' dist/assets/*.js` deve mostrar a lib bundlada; testar com webview sem rede.

### 3. (Opcional) PlayerBar unify + matar src/js legado
**Onde:** `src/components/PlayerBar.tsx` (troca `showPlayerMenu` de `../js/...` pelo `openTrackMenu`).
**O que:** PlayerBar usa o TrackContextMenu novo; remove `src/js/components/context-menu.js`.
**Por que:** o menu legado da PlayerBar está no `components.css` órfão (abre sem estilo) e mantém o src/js vivo. Baixa prioridade — fazer de carona.
**Verificar:** right-click no `.pb-meta` abre menu estilizado.

### 4. (Decisão de produto) Discover local + busca semântica
Quick wins discutidos; alavancam Qdrant/embeddings/music-curator já existentes. Decisão do usuário sobre quando.

## Como verificar

```bash
cd /home/opc/rustify-player
git status --short                  # só untracked alheios (docs/, scripts/curator/)
npm run build 2>&1 | tail -2        # "built in ~1s"
npx tsc --noEmit 2>&1 | rg -c 'error TS' || echo 0   # 0
rg -l 'track-ctx-menu' dist/assets/*.css   # DEVE achar (CSS no bundle)
# instalar/atualizar na cmr-auto:
# gh release download -R PedroGiudice/rustify-player -p '*.deb' -D /tmp --clobber && sudo dpkg -i /tmp/rustify-player_0.2.32_amd64.deb
```

## Restrições

- **CSS novo SÓ em `extractor-lab.css`** — `components.css` é órfão (não bundlado). Sempre verificar a classe em `dist/assets/*.css` após build, não confiar em "build passou".
- **NÃO compilar local na cmr-auto** — `release.sh` na VM é o único caminho; bumpar `tauri.conf.json` antes (o metadata usa o commit do HEAD, então commitar antes do release).
- **NÃO rebindar nada de rede** sem o usuário; os ícones offline são tema dele decidir.
- **Karaoke é despriorizado e caro** — não trazer como diferencial em conversa de produto.
- Frontend é **SolidJS/TSX** (`src/views/*.tsx`, `src/components/*.tsx`) — nunca `src/js/`.
- tauri-mcp conecta no app vivo da cmr-auto (host 100.102.249.9, port 9223) — usar via subagente (frontend-developer) pra diagnóstico visual/DOM ao vivo.
