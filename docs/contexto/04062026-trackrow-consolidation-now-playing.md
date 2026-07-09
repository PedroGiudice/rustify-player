# Contexto: Consolidação de listas em TrackRow + indicador now-playing + uniformidade do sprite

**Data:** 2026-06-04
**Sessão:** main
**Duração:** sessão longa (plano → execução em ondas → release → ajuste)

---

## O que foi feito

### 1. Refactor: consolidação das 7 listas-linha
As 7 listas que renderizavam "uma linha de música" (3 markups divergentes) foram
consolidadas em 2 componentes compartilhados + 1 utilitário:

- **`TrackRowTable`** (Família A — grid `.tracks` com `display:contents`): cobre `Tracks`, `Album`, `Playlist`. Composição via slots `coverSlot` (Playlist usa `.tracks--with-cover`, 6 colunas) e `extraCols` (default album+genre). Emite 5 filhos (6 com cover).
- **`TrackRowList`** (Família B/C — grid próprio): cobre `Home` (Recently played), `History`, `Queue`, `QueueDrawer`. Prop `size` (`default`=`.row` / `compact`=`.qrow`), `whenText` (coluna temporal), `noWhen` (Queue, grid override `40px 1fr auto`), `muted` (opacity 0.55).
- **`src/lib/format.ts`**: `fmtDur(ms)` e `relTime(ts)` — eliminou 6 cópias locais.

CommandPalette ficou de fora (item polimórfico track/álbum/artista).

### 2. NowPlayingIndicator — passivo + uniforme
Indicador de "tocando agora" que aparece em toda lista, derivado do store
(`player.currentTrack?.id === trackId`, `player.isPlaying`) — reatividade fina,
sem listener. Variantes `idx` (célula do número, Família A) e `overlay` (sobre a capa, B/C).

**Correção de uniformidade (commit d1f23bc):** a primeira versão criou um sprite
próprio (`.npi` com `scaleY`/`@keyframes npi-bounce`) — divergência visual do
indicador que já existia na sidebar. Reescrito para **reusar `.np-mini__vu`**
(o sprite canônico da sidebar: 3 barras azuis via `@keyframes vu`). Sobraram só
modifiers de contexto: `.npi--overlay` (chip sobre a capa) e `.npi--paused`
(`animation-play-state: paused`).

### 3. Motion free-wins (dentro do refactor)
- `prefers-reduced-motion` desliga a animação do indicador.
- `contain: layout style` em `.row`/`.qrow`.
- `content-visibility: auto` + `contain-intrinsic-size` (61px `.row`, 52px `.qrow`) — **liberado por validação: cmr-auto roda WebKitGTK 2.52.3** (3 ciclos além do corte Skia 2.46). Família A não recebe (`display:contents` não gera box).

### 4. Já commitado junto (trabalho pré-existente, não desta sessão de refactor)
- **Loudness** (sessão anterior): `loudnessNorm`/`loudnessTarget` no Tweaks, target LUFS runtime no backend, Signal lê do store.
- **Lyrics toggle** (usuário): botão no PlayerBar (`tweaks.lyricsVisible`).
- **music-curator** (usuário): subagente em `.claude/agents/music-curator.md`.

### 5. Qdrant — diagnóstico de segurança (NÃO corrigido ainda)
Qdrant da cmr-auto (`/usr/bin/qdrant`, pid manual, sem systemd, sem config.yaml →
default) está bindando **`0.0.0.0:6333` e `0.0.0.0:6334`** sem auth. `ufw` inativo.
O app conecta via `localhost:6333` (`qdrant_process.rs`, `lib.rs:2276` `RUSTIFY_QDRANT_URL`).

## Estado dos arquivos

| Arquivo | Status | Detalhe |
|---------|--------|---------|
| `src/lib/format.ts` | Criado | fmtDur, relTime compartilhados |
| `src/components/NowPlayingIndicator.tsx` | Criado | reusa `.np-mini__vu`; variantes idx/overlay |
| `src/components/TrackRowTable.tsx` | Criado | Família A; slots coverSlot/extraCols |
| `src/components/TrackRowList.tsx` | Criado | Família B/C; size/whenText/noWhen/muted |
| `src/styles/extractor-lab.css` | Modificado | regras current (`.tracks__row--current`, `.row.is-current`), contain+content-visibility, modifiers `.npi--*`; bloco `.npi` antigo removido |
| `src/views/Tracks.tsx` | Modificado | piloto Família A |
| `src/views/Album.tsx` | Modificado | TrackRowTable; index=track_number |
| `src/views/Playlist.tsx` | Modificado | TrackRowTable + coverSlot |
| `src/views/History.tsx` | Modificado | TrackRowList + whenText |
| `src/views/Home.tsx` | Modificado | TrackRowList só na seção Recently played; fmtDur passou a vir de lib/format (usado no hero) |
| `src/views/Queue.tsx` | Modificado | TrackRowList noWhen; removeu QueueRow |
| `src/components/QueueDrawer.tsx` | Modificado | TrackRowList size=compact; removeu QRow |
| `docs/plans/2026-06-04-trackrow-consolidation-now-playing.md` | Criado | plano completo (subagent-driven) |
| `docs/barrinhas.png` | Criado | screenshot de debug (commitado por acidente no git add -A) |
| `src-tauri/src/lib.rs`, `src/main.tsx`, `src/tauri.ts`, `src/store/tweaks.ts`, `src/views/Signal.tsx`, `src/views/Tweaks.tsx` | Modificado | loudness (sessão anterior) |
| `src/components/Icon.tsx`, `src/components/PlayerBar.tsx`, `src/views/NowPlaying.tsx` | Modificado | lyrics toggle (usuário) |
| `.claude/agents/music-curator.md` | Criado | subagente (usuário) |

## Commits desta sessão

```
d1f23bc fix(ui): NowPlayingIndicator reusa o sprite .np-mini__vu da sidebar
c6f493b feat(ui): consolida listas em TrackRow + now-playing indicator; loudness no Tweaks; toggle lyrics
```

Working tree limpo. Branch `main`. **Não foi feito `git push`** (commits só locais).

## Decisões tomadas

- **Núcleo + variantes, não row único nem plug-em-7**: a divergência tabela (A) vs lista-com-capa (B/C) é parcialmente essencial. Descartado: `TrackRow` monolítico (god-component com props booleanas) e plugar o indicador nas 7 listas mantendo os markups (perpetua o debt).
- **content-visibility cravado**: cmr-auto = WebKitGTK 2.52.3 (suporte pleno). Fallback gracioso em engines antigas. Descartado: deixar pendente.
- **Gate = revisão de código minha, não build-do-piloto-humano**: alinhado com "não compilar até o fim" + paralelismo; 1 build só no fim. Risco aceito: defeito de design propaga às 7 telas (baixo, dado plano detalhado; correção do componente é interna, não refaz migrações).
- **Onda 2 sem `schema` nos agentes**: o `StructuredOutput` forçado derrubou o workflow apesar do trabalho feito (edições parciais). Retry sem schema (texto livre) + verificação por Bash.
- **Sprite: reusar `.np-mini__vu`, não criar `.npi`**: uniformidade visual = um equalizer no app inteiro. Sidebar é a fonte canônica; não foi tocada.
- **Qdrant: `ufw` restrito à tailnet, NÃO rebind**: rebind pro IP Tailscale quebraria o app (usa `localhost`). Descartado: rebind puro (`service.host` aceita 1 host, não cobre local+tailnet).
- **Commit único**: a pedido do usuário ("não separa tanto, commita tudo") — git é a rede de segurança.

## Métricas

| Métrica | Valor |
|---------|-------|
| Listas consolidadas | 7 (3 Família A, 4 Família B/C) |
| Componentes novos | 3 (+ format.ts) |
| WebKitGTK na cmr-auto | 2.52.3 |
| Onda 1 (workflow) | 6 agentes paralelos, vite build 861ms |
| Onda 2 | 1ª falhou (StructuredOutput), retry OK em 72s |
| Build release | v0.2.30, cargo 34-39s, vite ~1s |
| Commit final | d1f23bc, working tree limpo |

## Pendências identificadas

1. **Validação visual das 7 telas** (alta) — release v0.2.30 publicado, aguardando teste na cmr-auto. Dois pontos visuais intencionais a confirmar: (a) Home/History agora destacam current (barra azul + título azul + NPI) — antes não tinham; (b) Queue mudou de fundo azul → barra lateral azul.
2. **Qdrant security `ufw`** (média) — cmr-auto exposto em 0.0.0.0. Solução: `ufw` restrito a `lo` + `tailscale0` (comandos no prompt de retomada). Usuário decide quando (não agir foi instrução explícita: "por ora, nada").
3. **Doc CLAUDE.md** (média, task #9) — adicionar nota sobre componentes de lista compartilhados + corrigir linha "Branch atual: fix-playback-race-condition" → `main`.
4. **Sidebar JS `vu` morto** (baixa) — `setInterval`/signal `vu` (Sidebar.tsx:41-53) é visualmente inócuo (o `@keyframes vu` do CSS sobrepõe o `height` inline). Limpeza opcional.
5. **`docs/barrinhas.png`** (baixa) — screenshot de debug commitada por acidente; remover se incomodar (`git rm`).
6. **`git push`** (baixa) — commits só locais; subir pro `origin/main` pra backup remoto.
