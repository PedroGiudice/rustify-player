# Contexto: Menu de contexto de faixa (right-click) + bg em Playlist/Album + diagnóstico de ícones

**Data:** 2026-06-05
**Sessão:** main
**Duração:** sessão longa (reimplementação + 2 releases + 3 ciclos de debug com subagentes tauri-mcp)

---

## O que foi feito

### 1. Reintrodução do menu de contexto de faixa (right-click)
O `showTrackMenu` legado (era `src/js/components/context-menu.js`, vanilla, morto na migração pra Solid) foi reimplementado como componente Solid:
- **`src/store/contextMenu.ts`**: signal `trackMenu` + `openTrackMenu(e, track, {list?, onPlay?})` + `closeTrackMenu()`. `openTrackMenu` faz `preventDefault`+`stopPropagation`+`setTrackMenu`.
- **`src/components/TrackContextMenu.tsx`**: singleton montado UMA vez no App; renderiza `.track-ctx-menu` via `<Portal mount={document.body}>` quando `trackMenu()!=null`. Posiciona no cursor com clamp ao viewport (rAF), pré-busca like via `libIsLiked`, dismiss em pointerdown-fora/Esc.
- Itens (escopo COMPLETO, com Shuffle a pedido do usuário): Play (reusa `onPlay`=onClick da linha) · Shuffle (só se `list.length>1`: `setQueue(list, idx, "curated")`+`shuffleQueue()`+`playTrack`) · Play Next (`enqueueNext`) · Add to Queue (`enqueueEnd`) · Like/Unlike (`libToggleLike`, não fecha) · Go to Album/Artist (`navigate`, condicionais).
- Backend 100% reusado de `store/player.ts` + `tauri.ts` — **zero comando Tauri novo**. Mesmas funções que o `CommandPalette` já usava.
- Ligado via `onContextMenu` nos 2 TrackRow consolidados (`TrackRowTable` display:contents; `TrackRowList` .row/.qrow). Prop opcional `contextList?: Track[]` passada em Tracks/Album/Playlist/History/Home (habilita Shuffle); Queue/QueueDrawer ganham o menu sem contextList (Shuffle não aparece — fila não é "re-embaralhável" coerente).

### 2. bg em motion vaza em Playlist/Album/Tracks
Diagnóstico (subagente via tauri-mcp ao vivo): a causa NÃO era contraste nem densidade de cover — era o painel `.tracks` com `background: var(--bg-paper)` (#fff sólido) cobrindo o canvas global `.app-bg`. Medição: na Playlist o `.tracks` opaco ocupa ~18.7M px² (100x a `.view__head`). Fix aplicado: `.tracks` → `rgba(255,255,255,0.78)`, **sem backdrop-filter** (o canvas já tem blur 8px no modo ambient; backdrop-filter em tela cheia sobre canvas animado = repaint por frame). Albums/Artists usam `.card-grid` (já transparente) — fora desse fix.

### 3. Diagnóstico: ícones invisíveis (NÃO corrigido — tech-debt)
Subagente via tauri-mcp: todos os `<iconify-icon>` ficavam vazios (0/30 com SVG). Causa: `index.html` carrega `iconify-icon` de CDN externa (`code.iconify.design`) + SVGs sob demanda de `api.iconify.design`; o webview da cmr-auto sem saída pra internet → custom element não registra. Não é contraste, não é regressão de código (tag CDN existe desde 17/05). Intermitente: "voltou" quando a cmr-auto reganhou rede (confundiu o diagnóstico). Viola `no-cdn-assets.md`. **Adiado pelo usuário.** Memória: `project_iconify_cdn_offline_debt`.

### 4. Fix do bug real do menu: CSS em arquivo órfão
Sintoma: right-click na faixa "não fazia nada". Debug sistemático (subagente tauri-mcp): wiring 100% OK — dispatch sintético de `contextmenu` montava o `.track-ctx-menu` no DOM com os 8 itens, mas FORA da viewport (`top:1048`, `width:100%`, `position:static`). Causa raiz: o CSS `.track-ctx-menu` foi adicionado em `src/styles/components.css`, que é **órfão** (não importado; `main.tsx` só importa `extractor-lab.css`). Sem o CSS, o menu caía em position:static. Fix: movido o bloco pra `extractor-lab.css`. Verificado no artefato (`rg track-ctx-menu dist/assets/*.css`). Memória: `project_components_css_orphan`.

### 5. Conversa de produto (sem código)
Right-click na PlayerBar = feature marginal (descoberta zero; só Go to Album/Artist, já alcançável). Rustify ≠ Spotify-clone — joga em "melhor experiência sobre a biblioteca local". Diferenciais baratos de alavancar: DSP audiófilo (já existe), descoberta local via embeddings (infra pronta), busca semântica. Karaoke **despriorizado** (stem-separation é caro — memória corrigida).

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src/store/contextMenu.ts` | Criado (252ff56) | signal + openTrackMenu/closeTrackMenu |
| `src/components/TrackContextMenu.tsx` | Criado (252ff56) | menu Solid singleton via Portal |
| `src/components/TrackRowTable.tsx` | Modificado (252ff56) | +prop contextList, +onContextMenu |
| `src/components/TrackRowList.tsx` | Modificado (252ff56) | +prop contextList, +onContextMenu |
| `src/App.tsx` | Modificado (252ff56) | +import e mount `<TrackContextMenu/>` |
| `src/views/{Tracks,Album,Playlist,History,Home}.tsx` | Modificado (252ff56) | +contextList nos TrackRow |
| `src/styles/extractor-lab.css` | Modificado (252ff56 .tracks rgba; 8ce5755 +.track-ctx-menu) | bg translúcido + CSS do menu (lugar certo) |
| `src/styles/components.css` | Modificado e revertido | +.track-ctx-menu (252ff56, ÓRFÃO) → removido (8ce5755) |
| `src-tauri/tauri.conf.json` | Modificado | version 0.2.30→0.2.31 (252ff56) →0.2.32 (8ce5755) |

## Commits desta sessão

```
252ff56 feat(ui): menu de contexto de faixa (right-click) + bg vaza em Playlist/Album/Tracks
8ce5755 fix(ui): CSS do menu de contexto estava em components.css orfao — move pro extractor-lab.css
```
Branch `main`. **NÃO pushados** (só locais). Releases publicadas na tag rolling `dev`: v0.2.31 (252ff56), v0.2.32 (8ce5755, atual).

## Decisões tomadas

- **Menu Solid limpo, não ponte pro src/js**: alinha com doutrina Solid; o legado usa sprite SVG imperativo. | Descartado: reusar `showTrackMenu` legado via ponte (como a PlayerBar faz).
- **Escopo completo COM Shuffle**: usuário argumentou o caso "clica faixa + shuffle = inicia nela e embaralha a lista". Custo: prop `contextList` nos TrackRow. | Eu havia recomendado sem Shuffle (menos acoplamento) — revertido pelo argumento dele.
- **bg sem backdrop-filter**: perf (repaint por frame sobre canvas animado). | Descartado: glass com `backdrop-filter: blur()` que o subagente sugeriu.
- **bg alpha fixo, sem knob no Tweaks**: usuário disse "tweaks não precisa". | Descartado: `--tracks-bg-alpha` no Tweaks (apesar de alinhar com a doutrina do hub).
- **Ícones CDN: diagnosticado, não corrigido**: usuário adiou ("calma"). Fix real = bundle local.
- **PlayerBar segue na ponte legada**: right-click nela é marginal; unify só limparia dívida, não urgente. O menu legado `.ctx-menu` também está no `components.css` órfão (abre sem estilo).
- **Verificar artefato, não "build passou"**: o CSS órfão passou build+tsc sem erro e sumiu do bundle. Lição registrada em memória.

## Métricas

| Métrica | Valor |
|---------|-------|
| Commits | 2 (252ff56, 8ce5755) |
| Arquivos tocados (líquido) | 12 (2 novos) |
| Releases | v0.2.31, v0.2.32 |
| Subagentes tauri-mcp | 3 (bg, ícones, wiring do menu) — todos conectaram ao app vivo na cmr-auto |
| Build | vite ~1s, tsc 0 erros |
| Memórias gravadas/corrigidas | 3 (components-css-orphan, iconify-cdn-debt, karaoke despriorizado) |

## Pendências identificadas

1. **Validação visual na v0.2.32** (alta) — confirmar: (a) right-click abre o menu no cursor nas listas; (b) bg `.tracks` 0.78 ficou no ponto (ajustar alpha se preciso).
2. **Ícones via CDN → bundle local** (média) — tech-debt que quebra offline; viola `no-cdn-assets`. Plano em `project_iconify_cdn_offline_debt`. Adiado.
3. **PlayerBar unify + matar src/js legado** (baixa) — só limpa dívida; right-click na PlayerBar é marginal. Fazer "de carona" quando tocar a PlayerBar por outro motivo.
4. **Roadmap de produto** (decisão do usuário) — descoberta local (Discover Weekly via embeddings) + busca semântica são os quick wins; karaoke/multi-device são os caros.
5. **`git push origin main`** (baixa) — 252ff56 e 8ce5755 só locais.
6. **CLAUDE.md task #9 herdada** (baixa) — corrigir "Branch atual: `fix-playback-race-condition`" → `main`; nota sobre TrackRow/menu compartilhados.
