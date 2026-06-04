# TrackRow Consolidation + Now Playing Indicator

> **For Claude (sessão principal):** Antes de despachar qualquer subagente,
> invocar `superpowers:subagent-driven-development` via Skill tool.
> Cada tarefa abaixo é autossuficiente — o subagente executor não tem o
> histórico desta conversa. O contexto necessário está embutido em cada task.

**Goal:** Consolidar as 6 listas de tracks em dois componentes compartilhados
(`TrackRowTable` e `TrackRowList`) + criar o `NowPlayingIndicator` que aparece
em toda lista de forma passiva/reativa via store.

**Architecture:** Dois componentes de linha (um para a família table com
`display:contents`, outro para a família list/row com grid próprio) consomem
um `NowPlayingIndicator` centralizado que lê `player.currentTrack` e
`player.isPlaying` diretamente. Funções utilitárias duplicadas (`fmtDur`,
`relTime`) migram para `src/lib/format.ts`. QueueDrawer é migrado de `QRow`
para `TrackRowList` com `size="compact"`. CommandPalette fica fora do refactor.

---

## Anchors validados (2026-06-04)

| Arquivo | Linha real | Nota |
|---------|-----------|------|
| `src/views/Tracks.tsx` | L72 — `<div class="tracks__row">` | Grid `.tracks` 5-col: `36px 1fr 180px 120px 70px` |
| `src/views/Album.tsx` | L84 — `<div class="tracks__row">` | Mesmo grid, sem cover. Usa `t.track_number ?? i() + 1` |
| `src/views/Playlist.tsx` | L159 — `<div class="tracks__row">` | `.tracks--with-cover` 6-col: `36px 44px 1fr 180px 110px 70px` |
| `src/views/Home.tsx` | L162 — `<div class="row">` | Grid `.row` 5-col CSS: `40px 1fr 220px 120px 60px`. Seção "Recently played". |
| `src/views/History.tsx` | L59 — `<div class="row">` | Mesmo padrão de Home, inclui `row__when` |
| `src/views/Queue.tsx` | L78 — `<div class="row">` dentro de `QueueRow` (L75) | **Override inline**: `grid-template-columns: "40px 1fr auto 60px"` (4 colunas, sem `row__when`) |
| `src/components/QueueDrawer.tsx` | L114 — `<div class="qrow...">` dentro de `QRow` (L111) | `.qrow--current` + `::before` bar azul definidos em CSS L1166–1173 |
| `.tracks` CSS | `src/styles/extractor-lab.css` L860 | `grid-template-columns: 36px 1fr 180px 120px 70px` |
| `.tracks--with-cover` CSS | L874 | `grid-template-columns: 36px 44px 1fr 180px 110px 70px` |
| `.row` CSS | L500 | `grid-template-columns: 40px 1fr 220px 120px 60px` |
| `.qrow` CSS | L1152 | `grid-template-columns: 36px 1fr auto` |
| `player.currentTrack` | `src/store/player.ts` L34 | `Track | null` |
| `player.isPlaying` | `src/store/player.ts` L42 | `boolean` |

**Descobertas que afetam a implementação:**
- `Queue.tsx` usa `.row` com grid **sobrescrito inline** (4 colunas). `TrackRowList`
  precisa de prop `noWhen` que aplica `grid-template-columns: 40px 1fr auto` inline.
- `fmtDur` duplicada em 6 arquivos incluindo `QueueDrawer.tsx`.
- `Playlist.tsx` tem `fmtTotalDur` (duração total do header) que NÃO migra para
  `format.ts` — é específica da view, manter local.
- `CoverArt` não declara `children` mas `Home.tsx` passa `<button class="card__play">`
  como children na seção de albums — bug pré-existente silencioso, fora do escopo.

---

## Grafo de dependências

```
FASE 1 ──────────────────────────────────── paralelo
  [A] format.ts          (sem deps)
  [B] NowPlayingIndicator (sem deps de código; CSS em extractor-lab.css)

FASE 2 ──────────────────────────────────── paralelo entre si, depende de FASE 1
  [C] TrackRowTable      (depende de A + B)
  [D] TrackRowList       (depende de A + B)

FASE 3 ──────────────────────────────────── GATE: piloto sequencial
  [E] Migrar Tracks.tsx  (depende de C; piloto OBRIGATÓRIO antes do fan-out)
      └── GATE HUMANO: validação visual em /tracks antes de despachar [F], [G]

FASE 4 ──────────────────────────────────── paralelo pós-piloto (Família A)
  [F] Migrar Album.tsx   (depende de C + gate [E])
  [G] Migrar Playlist.tsx (depende de C + gate [E])

FASE 5 ──────────────────────────────────── paralelo pós-piloto (Família B/C)
  [H] Migrar History.tsx  (depende de D + gate [E])
  [I] Migrar Home.tsx     (depende de D + gate [E])
  [J] Migrar Queue.tsx    (depende de D + gate [E])
  [K] Migrar QueueDrawer  (depende de D + gate [E])

FASE 6 ──────────────────────────────────── sequencial final
  [L] Limpeza + verificação (depende de todas as migrações)
```

**Paralelismo:**
- Fase 1: [A] e [B] em paralelo (escrevem arquivos diferentes).
- Fase 2: [C] e [D] em paralelo (escrevem arquivos diferentes, lêem [A] e [B]).
- Fase 4: [F] e [G] em paralelo entre si (após gate [E] aprovado).
- Fase 5: [H], [I], [J], [K] em paralelo entre si (após gate [E] aprovado).
- Fase 4 e Fase 5 podem rodar em paralelo entre si (Família A e B/C são independentes).

**Gates de validação humana:**
1. Após [E] (Tracks.tsx piloto) — humano valida visualmente em /tracks na cmr-auto.
   Só após aprovação explícita despachar [F], [G], [H], [I], [J], [K].
2. Após cada migração de view — subagente entrega checklist preenchido;
   sessão principal valida ou solicita correção antes do próximo commit.

**Worktree obrigatório:** Todas as tarefas de Fase 1, 2, 4 e 5 que rodam em
paralelo exigem `isolation: "worktree"`. Tarefas sequenciais ([E] piloto, [L]
limpeza) podem rodar na branch principal.

---

## FASE 1 — Utilitários e indicador (paralelo)

### Tarefa A — Criar `src/lib/format.ts`

**Worktree:** sim (paralelo com B)
**Dependências:** nenhuma
**Arquivo-alvo:** criar `src/lib/format.ts` (não existe ainda)
**Repo:** `/home/opc/rustify-player` | Branch base: `fix-playback-race-condition`

**Contexto para o subagente:**

Este projeto é Tauri 2 + SolidJS (TSX). O frontend vive em `src/`. A função
`fmtDur(ms: number): string` está duplicada em 6 arquivos de views:
- `src/views/Tracks.tsx` (L15)
- `src/views/Album.tsx` (L14)
- `src/views/Playlist.tsx` (L25)
- `src/views/History.tsx` (L11)
- `src/views/Home.tsx` (L18)
- `src/views/Queue.tsx` (L12) e `src/components/QueueDrawer.tsx`

A função `relTime` existe em `src/views/History.tsx` (L16, nome `relTime`) e em
`src/views/Home.tsx` (L23, nome `relativeTime`) — são idênticas em lógica.

**O que fazer:**
Criar o arquivo `src/lib/format.ts` com o conteúdo exato abaixo. Não alterar
nenhum outro arquivo — as views são migradas em tarefas separadas.

```typescript
// src/lib/format.ts — Utilitários de formatação compartilhados entre views.
// NÃO modificar as views aqui — cada view tem tarefa de migração própria.

/** Formata duração em ms para "MM:SS". */
export function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Tempo relativo a partir de unix timestamp em segundos. */
export function relTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}
```

**O que NÃO fazer:**
- Não alterar nenhum arquivo de view ou componente.
- Não criar subdiretórios além de `src/lib/`.
- Não adicionar mais funções além das duas acima.

**Critérios de aceitação:**
- [ ] Arquivo `src/lib/format.ts` existe com as duas exportações.
- [ ] `grep -rn "export function fmtDur\|export function relTime" src/lib/format.ts`
  retorna 2 linhas.
- [ ] Nenhum outro arquivo foi modificado
  (`git diff --name-only` mostra só `src/lib/format.ts`).

---

### Tarefa B — Criar `NowPlayingIndicator`

**Worktree:** sim (paralelo com A)
**Dependências:** nenhuma de código (não importa format.ts)
**Arquivos-alvo:**
- Criar `src/components/NowPlayingIndicator.tsx`
- Modificar `src/styles/extractor-lab.css` (adicionar bloco CSS ao final da seção `.qrow`)
**Repo:** `/home/opc/rustify-player` | Branch base: `fix-playback-race-condition`

**Contexto para o subagente:**

Este projeto é Tauri 2 + SolidJS (TSX). O estado global de reprodução vive em
`src/store/player.ts`. Campos relevantes:
- `player.currentTrack: Track | null` (L34) — track atual; `Track` tem campo `id: string`
- `player.isPlaying: boolean` (L42)

O store é importado com: `import { player } from "../store/player";`

O padrão de "linha atual" já existe no `QueueDrawer` via `.qrow--current` com
`::before` (barra azul lateral, CSS L1166–1173). O novo componente é o indicador
visual de equalizer — animação de 3 barras quando tocando, barras estáticas
quando pausado, invisível quando a track não é a current.

Duas variantes de uso:
- `variant="idx"` — substitui o número da faixa na célula `.tracks__idx` (Família A: tabela)
- `variant="overlay"` — sobrepõe a capa de álbum (Família B/C: listas com cover)

**O que criar:**

**`src/components/NowPlayingIndicator.tsx`:**
```tsx
// src/components/NowPlayingIndicator.tsx
import { Show } from "solid-js";
import { player } from "../store/player";

interface NowPlayingIndicatorProps {
  trackId: string;
  /** "idx" = substitui número na célula .tracks__idx. "overlay" = sobre a capa. */
  variant?: "idx" | "overlay";
}

export function NowPlayingIndicator(props: NowPlayingIndicatorProps) {
  const isCurrent = () => player.currentTrack?.id === props.trackId;
  const isPlaying = () => player.isPlaying;

  return (
    <Show when={isCurrent()}>
      <span
        class="npi"
        classList={{
          "npi--playing": isPlaying(),
          "npi--paused": !isPlaying(),
          "npi--overlay": props.variant === "overlay",
        }}
        aria-label={isPlaying() ? "Tocando agora" : "Pausado"}
        role="img"
      >
        <span class="npi__bar" />
        <span class="npi__bar" />
        <span class="npi__bar" />
      </span>
    </Show>
  );
}
```

**CSS a adicionar em `src/styles/extractor-lab.css`:**

Localizar a linha que contém `.qrow--current::before {` (atualmente L1168).
O bloco `.qrow--current::before { ... }` termina por volta de L1173 com `}`.
Inserir o bloco abaixo APÓS essa seção (após o `}` de fechamento de
`.qrow--current::before`), antes da próxima seção `/* ─── PANELS ─── */`:

```css
/* ────────────────────────────────────────────────────────────
   NOW PLAYING INDICATOR (.npi)
   ──────────────────────────────────────────────────────────── */
.npi {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 14px;
  width: 18px;
}
.npi__bar {
  display: block;
  width: 3px;
  border-radius: 2px;
  background: var(--blue-fg);
}
.npi--playing .npi__bar {
  animation: npi-bounce var(--dur, 0.9s) ease-in-out infinite alternate;
  /* (b) will-change cirúrgico: só nas barras que de fato animam (estado playing).
     O NPI só existe na track current — 1 elemento por vez — custo de VRAM trivial.
     NÃO colocar will-change permanente nem fora deste seletor. */
  will-change: transform;
}
.npi--playing .npi__bar:nth-child(1) { --dur: 0.7s; height: 8px; }
.npi--playing .npi__bar:nth-child(2) { --dur: 0.9s; height: 14px; }
.npi--playing .npi__bar:nth-child(3) { --dur: 0.8s; height: 5px; }
@keyframes npi-bounce {
  from { transform: scaleY(0.35); }
  to   { transform: scaleY(1); }
}
.npi--paused .npi__bar:nth-child(1) { height: 8px;  opacity: 0.6; }
.npi--paused .npi__bar:nth-child(2) { height: 14px; opacity: 0.6; }
.npi--paused .npi__bar:nth-child(3) { height: 5px;  opacity: 0.6; }
.npi--overlay {
  position: absolute; inset: 0;
  display: flex; align-items: center; justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  border-radius: inherit;
  width: auto; height: auto;
}
.npi--overlay .npi__bar { background: #fff; }
/* (a) prefers-reduced-motion: desliga a animação para usuários que pedem menos movimento
   (a11y + máquinas lentas). As barras ficam estáticas na altura final — indicador
   de "current" permanece visível, só não pulsa. */
@media (prefers-reduced-motion: reduce) {
  .npi--playing .npi__bar {
    animation: none;
    will-change: auto;
  }
  .npi--playing .npi__bar:nth-child(1) { height: 8px; }
  .npi--playing .npi__bar:nth-child(2) { height: 14px; }
  .npi--playing .npi__bar:nth-child(3) { height: 5px; }
}
```

**O que NÃO fazer:**
- Não alterar views nem outros componentes.
- Não remover o bloco `.qrow--current` existente — o novo CSS vem DEPOIS dele.
- Não criar CSS em arquivo separado — tudo em `extractor-lab.css`.

**Critérios de aceitação:**
- [ ] `src/components/NowPlayingIndicator.tsx` existe e exporta `NowPlayingIndicator`.
- [ ] CSS contém `.npi`, `.npi__bar`, `.npi--playing`, `.npi--paused`, `.npi--overlay`,
  `@keyframes npi-bounce`.
- [ ] `grep -n "will-change" src/styles/extractor-lab.css` retorna hit dentro de
  `.npi--playing .npi__bar` (e apenas ali).
- [ ] `grep -n "prefers-reduced-motion" src/styles/extractor-lab.css` retorna hit
  com o bloco `@media` que desliga `animation` e `will-change`.
- [ ] `grep -n "npi--overlay\|npi-bounce" src/styles/extractor-lab.css` retorna hits.
- [ ] O bloco `.qrow--current::before` original ainda existe intacto
  (`grep -n "qrow--current::before" src/styles/extractor-lab.css` retorna resultado).
- [ ] `git diff --name-only` mostra exatamente 2 arquivos:
  `src/components/NowPlayingIndicator.tsx` e `src/styles/extractor-lab.css`.

---

## FASE 2 — Componentes core (paralelo entre si, após Fase 1 mergeada)

> **Sessão principal:** Aguardar merge das tarefas A e B na branch principal
> antes de despachar C e D. C e D podem ser despachadas em paralelo.

### Tarefa C — Criar `TrackRowTable`

**Worktree:** sim (paralelo com D)
**Dependências:** Tarefa A (format.ts) e Tarefa B (NowPlayingIndicator) mergeadas
**Arquivos-alvo:**
- Criar `src/components/TrackRowTable.tsx`
- Modificar `src/styles/extractor-lab.css` (adicionar 2 regras CSS para `.tracks__row--current`)
**Repo:** `/home/opc/rustify-player` | Branch base: `fix-playback-race-condition`

**Contexto para o subagente:**

Este projeto é Tauri 2 + SolidJS (TSX). Este componente serve a "Família A":
listas `.tracks` com `display: contents` nas linhas — os filhos do componente
colam no grid do container pai. O container pai é sempre `<div class="tracks">`
ou `<div class="tracks tracks--with-cover">` e NÃO deve ser alterado.

Grid padrão `.tracks` (5 colunas): `36px 1fr 180px 120px 70px`
Grid `.tracks--with-cover` (6 colunas): `36px 44px 1fr 180px 110px 70px`

Views que usam este componente (cada uma tem tarefa de migração própria):
- `src/views/Tracks.tsx` — 5 colunas, sem cover slot
- `src/views/Album.tsx` — 5 colunas, sem cover slot, usa `t.track_number ?? i() + 1`
- `src/views/Playlist.tsx` — 6 colunas, com cover slot (`.tracks--with-cover`)

Imports disponíveis (já existem no projeto):
- `import { Show } from "solid-js";`
- `import type { JSX } from "solid-js";`
- `import { player } from "../store/player";` — `player.currentTrack?.id`, `player.isPlaying`
- `import { NowPlayingIndicator } from "./NowPlayingIndicator";` (criado na Tarefa B)
- `import type { Track } from "../tauri";` — tipo Track tem: `id`, `title`, `artist_name`, `album_title`, `genre_name`, `duration_ms`, `track_number`
- `import { fmtDur } from "../lib/format";` (criado na Tarefa A)

**O que criar:**

**`src/components/TrackRowTable.tsx`:**
```tsx
// src/components/TrackRowTable.tsx — linha de track para listas .tracks (Família A).
// Uso: dentro de <div class="tracks"> ou <div class="tracks tracks--with-cover">.
// O container pai gerencia o grid; este componente emite filhos com display:contents.
import { Show } from "solid-js";
import type { JSX } from "solid-js";
import { player } from "../store/player";
import { NowPlayingIndicator } from "./NowPlayingIndicator";
import type { Track } from "../tauri";
import { fmtDur } from "../lib/format";

interface TrackRowTableProps {
  track: Track;
  /** Número exibido em .tracks__idx quando não é a track atual. */
  index: number;
  onClick: () => void;
  /**
   * Slot para coluna de capa — usado APENAS em Playlist (.tracks--with-cover).
   * Quando fornecido, ocupa a 2ª coluna do grid (44px).
   * Quando ausente (undefined), a célula não é renderizada e o grid tem 5 colunas.
   */
  coverSlot?: JSX.Element;
  /**
   * Colunas após .tracks__title. Default quando ausente: album + genre.
   * Passado explicitamente para customizar (ex: remover genre em alguma view futura).
   */
  extraCols?: JSX.Element;
}

export function TrackRowTable(props: TrackRowTableProps) {
  const isCurrent = () => player.currentTrack?.id === props.track.id;

  return (
    <div
      class="tracks__row"
      classList={{ "tracks__row--current": isCurrent() }}
      onClick={props.onClick}
      style={{ display: "contents" }}
      role="row"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") props.onClick(); }}
    >
      {/* Célula índice: NPI quando current, número formatado quando não */}
      <div class="tracks__idx">
        <Show when={isCurrent()} fallback={String(props.index).padStart(2, "0")}>
          <NowPlayingIndicator trackId={props.track.id} variant="idx" />
        </Show>
      </div>

      {/* Cover slot opcional (apenas Playlist) */}
      <Show when={props.coverSlot !== undefined}>
        {props.coverSlot}
      </Show>

      {/* Título + artista */}
      <div class="tracks__title">
        <b>{props.track.title || "—"}</b>
        <small>{props.track.artist_name || "—"}</small>
      </div>

      {/* Colunas extras — default: album + genre */}
      <Show
        when={props.extraCols !== undefined}
        fallback={
          <>
            <div class="tracks__cell">{props.track.album_title ?? "—"}</div>
            <div class="tracks__cell">{props.track.genre_name ?? "—"}</div>
          </>
        }
      >
        {props.extraCols}
      </Show>

      {/* Duração — sempre última coluna */}
      <div class="tracks__mono">{fmtDur(props.track.duration_ms)}</div>
    </div>
  );
}
```

**CSS a adicionar em `src/styles/extractor-lab.css`:**

Localizar `.tracks__row { cursor: pointer; transition: background var(--dur-base); }` (L891).
Inserir as duas regras abaixo IMEDIATAMENTE APÓS essa linha:

```css
.tracks__row--current > div { background: var(--blue-bg); }
.tracks__row--current .tracks__title b { color: var(--blue-fg); }
```

> **Nota (c) — transições compositor-friendly:** As regras acima animam apenas
> `background-color` e `color` — propriedades que o browser pode transicionar
> sem reflow. NÃO usar `transition: all`. A transição existente em `.tracks__row`
> já segue esse padrão (`transition: background var(--dur-base)`); as novas
> regras de estado-current seguem o mesmo princípio. Não adicionar `transition`
> explícita nas regras `--current` — o estado current muda atomicamente (track
> troca, não anima a troca).

**O que NÃO fazer:**
- Não alterar nenhuma view — as migrações são tarefas separadas.
- Não alterar o CSS de `.tracks`, `.tracks--with-cover`, `.tracks__row` existentes.
- Não importar `coverUrl` nem `CoverArt` neste componente — o cover slot é
  passado pronto pelo caller.
- Não usar `transition: all` em nenhuma regra nova — apenas propriedades
  específicas (`background-color`, `color`).

**Critérios de aceitação:**
- [ ] `src/components/TrackRowTable.tsx` existe e exporta `TrackRowTable`.
- [ ] `grep -n "tracks__row--current" src/styles/extractor-lab.css` retorna
  2 linhas (as duas regras adicionadas).
- [ ] A linha `.tracks__row { cursor: pointer` ainda existe intacta logo antes.
- [ ] `git diff --name-only` mostra exatamente 2 arquivos:
  `src/components/TrackRowTable.tsx` e `src/styles/extractor-lab.css`.

---

### Tarefa D — Criar `TrackRowList`

**Worktree:** sim (paralelo com C)
**Dependências:** Tarefa A (format.ts) e Tarefa B (NowPlayingIndicator) mergeadas
**Arquivos-alvo:**
- Criar `src/components/TrackRowList.tsx`
- Modificar `src/styles/extractor-lab.css` (adicionar 2 regras CSS para `.row.is-current`)
**Repo:** `/home/opc/rustify-player` | Branch base: `fix-playback-race-condition`

**Contexto para o subagente:**

Este projeto é Tauri 2 + SolidJS (TSX). Este componente serve a "Família B/C":
listas com cover à esquerda e grid próprio (não `display:contents`).

Dois modos controlados pela prop `size`:

**`size="default"` → Família B (Home, History, Queue)**
- Classe raiz: `.row`
- Grid CSS existente (L500): `40px 1fr 220px 120px 60px` (5 colunas)
- Filhos: cover (40px) | meta (1fr) | when (220px, opcional) | time (60px)
- **ATENÇÃO:** Queue.tsx usa `.row` mas com grid sobrescrito inline a 4 colunas
  (sem coluna `when`). A prop `noWhen?: boolean` aplica
  `grid-template-columns: "40px 1fr auto"` via style inline quando `true`.
  Sem `noWhen`, o grid padrão do CSS é usado (5 colunas).
- Cover: 40px × 40px, classe `row__cover`

**`size="compact"` → Família C (QueueDrawer)**
- Classe raiz: `.qrow` e quando current também `.qrow--current`
- Grid CSS existente (L1152): `36px 1fr auto` (3 colunas)
- Cover: 36px × 36px, classe `qrow__cover`
- O CSS `.qrow--current::before` (barra azul lateral) aplica automaticamente.
  Não adicionar `background` azul — o `.qrow--current` já tem `background: var(--blue-bg)`.

Estado current: derivado do store (`player.currentTrack?.id === props.track.id`),
nunca de prop. O componente lê `player` diretamente — reactive tracking passivo.

Imports disponíveis:
- `import { Show } from "solid-js";`
- `import { coverUrl, type Track } from "../tauri";`
- `import { player } from "../store/player";`
- `import { CoverArt } from "./CoverArt";` — props: `seed`, `src`, `size="sm"`, `class`, `style`
- `import { NowPlayingIndicator } from "./NowPlayingIndicator";`
- `import { fmtDur } from "../lib/format";`

**O que criar:**

**`src/components/TrackRowList.tsx`:**
```tsx
// src/components/TrackRowList.tsx — linha de track para listas com cover (Família B/C).
// Família B: .row (Home, History, Queue). Família C: .qrow (QueueDrawer).
import { Show } from "solid-js";
import { coverUrl, type Track } from "../tauri";
import { player } from "../store/player";
import { CoverArt } from "./CoverArt";
import { NowPlayingIndicator } from "./NowPlayingIndicator";
import { fmtDur } from "../lib/format";

interface TrackRowListProps {
  track: Track;
  onClick: () => void;
  /** "default" → .row (Home, History, Queue). "compact" → .qrow (QueueDrawer). Default: "default". */
  size?: "default" | "compact";
  /**
   * Texto da coluna de contexto temporal ("2 min ago").
   * Só renderiza quando fornecido E size != "compact".
   * History e Home passam este campo; Queue não passa.
   */
  whenText?: string;
  /**
   * Quando true, aplica grid-template-columns: "40px 1fr auto" inline,
   * sobrescrevendo o padrão CSS de 5 colunas do .row.
   * Usar apenas em Queue.tsx (que historicamente tinha esse override).
   */
  noWhen?: boolean;
  /** Reduz opacidade para 0.55 — usado em Queue para tracks já reproduzidas. */
  muted?: boolean;
}

export function TrackRowList(props: TrackRowListProps) {
  const isCompact = () => props.size === "compact";
  const isCurrent = () => player.currentTrack?.id === props.track.id;
  const coverPx = () => isCompact() ? "36px" : "40px";

  return (
    <div
      class={isCompact()
        ? `qrow${isCurrent() ? " qrow--current" : ""}`
        : "row"}
      classList={{ "is-current": !isCompact() && isCurrent() }}
      onClick={props.onClick}
      style={{
        opacity: props.muted ? 0.55 : 1,
        ...(props.noWhen ? { "grid-template-columns": "40px 1fr auto" } : {}),
      }}
      role="row"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") props.onClick(); }}
    >
      {/* Cover com NPI overlay quando current */}
      <div style={{ position: "relative", width: coverPx(), height: coverPx(), flex: "none" }}>
        <CoverArt
          seed={props.track.album_title || props.track.id}
          src={coverUrl(props.track.album_cover_path)}
          size="sm"
          class={isCompact() ? "qrow__cover" : "row__cover"}
          style={{ width: coverPx(), height: coverPx() }}
        />
        <Show when={isCurrent()}>
          <NowPlayingIndicator trackId={props.track.id} variant="overlay" />
        </Show>
      </div>

      {/* Meta: título + artista/álbum */}
      <div class={isCompact() ? "qrow__meta" : "row__meta"}>
        <div
          class={isCompact() ? "qrow__title" : "row__title"}
          style={{ color: !isCompact() && isCurrent() ? "var(--blue-fg)" : undefined }}
        >
          {props.track.title || "—"}
        </div>
        <div class={isCompact() ? "qrow__sub" : "row__sub"}>
          {props.track.artist_name || "—"}
          {props.track.album_title && <> · {props.track.album_title}</>}
        </div>
      </div>

      {/* Coluna temporal — apenas Família B e quando whenText fornecido */}
      <Show when={props.whenText !== undefined && !isCompact()}>
        <div class="row__when">{props.whenText}</div>
      </Show>

      {/* Duração */}
      <div class={isCompact() ? "qrow__time" : "row__time"}>
        {fmtDur(props.track.duration_ms)}
      </div>
    </div>
  );
}
```

**CSS a adicionar em `src/styles/extractor-lab.css`:**

Localizar `.row:hover { background: var(--bg-soft); }` (L509).
Inserir as duas regras abaixo IMEDIATAMENTE APÓS essa linha:

```css
.row.is-current { border-left: 2px solid var(--blue-ring); padding-left: 10px; }
.row.is-current .row__title { color: var(--blue-fg); }
```

> **Nota (c) — transições compositor-friendly:** As regras acima usam apenas
> `border-left`, `padding-left` e `color` — sem `transition: all`. O `.row`
> existente já tem `transition: background var(--dur-base)` específica (L507–508);
> as novas regras `.is-current` não adicionam `transition` própria (o estado
> current muda atomicamente). Manter esse padrão de transições específicas em
> qualquer extensão futura destas classes.

**O que NÃO fazer:**
- Não alterar `.qrow`, `.qrow--current`, `.qrow--current::before` existentes.
- Não alterar `.row` base existente.
- Não alterar nenhuma view.
- Não usar `transition: all` — apenas propriedades específicas se necessário.

**Critérios de aceitação:**
- [ ] `src/components/TrackRowList.tsx` existe e exporta `TrackRowList`.
- [ ] `grep -n "is-current" src/styles/extractor-lab.css` retorna 2 linhas novas.
- [ ] `.row:hover` ainda existe intacto logo antes das novas regras.
- [ ] `git diff --name-only` mostra exatamente 2 arquivos:
  `src/components/TrackRowList.tsx` e `src/styles/extractor-lab.css`.

---

## FASE 3 — Piloto (sequencial, gate humano)

> **Sessão principal:** Aguardar merge das tarefas C e D antes de despachar E.
> Tarefa E roda na branch principal (sem worktree) para facilitar teste rápido.
> Após E, PARAR e pedir validação visual ao humano antes de continuar.

### Tarefa E — Migrar `Tracks.tsx` (piloto)

**Worktree:** não (sequencial, validação imediata)
**Dependências:** Tarefas A, B, C mergeadas
**Arquivo-alvo:** modificar `src/views/Tracks.tsx`
**Repo:** `/home/opc/rustify-player` | Branch: `fix-playback-race-condition`

**Contexto para o subagente:**

Este projeto é Tauri 2 + SolidJS (TSX). `Tracks.tsx` é a view de listagem
completa da biblioteca. Ela renderiza um grid `.tracks` de 5 colunas
(`36px 1fr 180px 120px 70px`). A migração substitui o corpo do `<For>` (as
linhas individuais) pelo componente `TrackRowTable`. O container `.tracks`,
os headers e a barra de chips de gênero NÃO mudam.

**Estado atual de `src/views/Tracks.tsx`:**
- L9: `import { createResource, createSignal, For, Show } from "solid-js";`
- L10: `import { libListGenres, libGetTracks, type Track } from "../tauri";`
- L11: `import { setQueue } from "../store/player";`
- L12: `import { playTrack } from "../components/PlayerBar";`
- L13: `import { route } from "../router";`
- L15–18: função local `fmtDur` (REMOVER)
- L70–83: bloco `<For>` com as linhas inline (SUBSTITUIR)

**Bloco a remover (L15–18):**
```tsx
function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
```

**Bloco a substituir (L70–83):**
```tsx
<For each={tracks() ?? []}>
  {(t, i) => (
    <div class="tracks__row" onClick={() => play(t)} style={{ display: "contents" }}>
      <div class="tracks__idx">{String(i() + 1).padStart(2, "0")}</div>
      <div class="tracks__title">
        <b>{t.title || "—"}</b>
        <small>{t.artist_name || "—"}</small>
      </div>
      <div class="tracks__cell">{t.album_title ?? "—"}</div>
      <div class="tracks__cell">{t.genre_name ?? "—"}</div>
      <div class="tracks__mono">{fmtDur(t.duration_ms)}</div>
    </div>
  )}
</For>
```

**Resultado esperado após substituição:**
```tsx
<For each={tracks() ?? []}>
  {(t, i) => (
    <TrackRowTable
      track={t}
      index={i() + 1}
      onClick={() => play(t)}
    />
  )}
</For>
```

**Imports a adicionar:**
```tsx
import { TrackRowTable } from "../components/TrackRowTable";
```

**O que NÃO mudar:**
- O `<div class="tracks">` container e seus `<div class="tracks__head">` headers.
- A barra de chips de gênero e toda a lógica de filtragem.
- A lógica da função `play(t)` que chama `setQueue` + `playTrack`.
- O bloco `<Show when={(tracks() ?? []).length === 0 ...}>` do estado vazio.

**Critérios de aceitação:**
- [ ] `grep -n "function fmtDur" src/views/Tracks.tsx` retorna zero resultados.
- [ ] `grep -n "TrackRowTable" src/views/Tracks.tsx` retorna 2 resultados
  (import + uso).
- [ ] `grep -n "tracks__row" src/views/Tracks.tsx` retorna zero resultados inline
  (só existirá no CSS externo).
- [ ] `git diff --name-only` mostra apenas `src/views/Tracks.tsx`.

**GATE HUMANO após esta tarefa:**
A sessão principal deve fazer release (ou dev build) e pedir ao usuário para
abrir `/tracks` na cmr-auto e validar:
- [ ] 5 colunas alinhadas: # / Title / Album / Genre / Length
- [ ] Chips de gênero filtram normalmente
- [ ] Hover sobre linha muda background
- [ ] Click em linha inicia reprodução
- [ ] NPI (barras de equalizer) aparece na coluna # da track em reprodução
- [ ] NPI anima quando tocando, fica estático quando pausado
- [ ] Ao trocar de track, o NPI move para a nova linha
**NÃO despachar Fases 4 e 5 antes de aprovação explícita do humano.**

---

## FASE 4 — Família A restante (paralelo, pós-gate)

> **Sessão principal:** Despachar F e G em paralelo após gate do humano aprovado.
> Ambas exigem worktree (escrevem arquivos diferentes mas na mesma branch).

### Tarefa F — Migrar `Album.tsx`

**Worktree:** sim (paralelo com G, H, I, J, K)
**Dependências:** Tarefas A, B, C mergeadas + gate [E] aprovado pelo humano
**Arquivo-alvo:** modificar `src/views/Album.tsx`
**Repo:** `/home/opc/rustify-player` | Branch base: `fix-playback-race-condition`

**Contexto para o subagente:**

Este projeto é Tauri 2 + SolidJS (TSX). `Album.tsx` é a page de detalhe de um
álbum. Estrutura: hero (capa grande + título) + tracklist `.tracks` de 5 colunas.
A migração substitui apenas as linhas do `<For>`. O hero, o container `.tracks`
e os headers NÃO mudam.

**Diferença em relação a Tracks.tsx:** o índice usa `t.track_number ?? i() + 1`
(número da faixa do álbum), não `i() + 1` fixo.

**Estado atual de `src/views/Album.tsx`:**
- L14–17: função local `fmtDur` (REMOVER)
- L82–90: bloco `<For>` com linhas inline (SUBSTITUIR)

**Bloco a remover (L14–17):**
```tsx
function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
```

**Bloco a substituir (L82–90):**
```tsx
<For each={tracks() ?? []}>
  {(t, i) => (
    <div class="tracks__row" onClick={() => play(t)} style={{ display: "contents" }}>
      <div class="tracks__idx">{String(t.track_number ?? i() + 1).padStart(2, "0")}</div>
      <div class="tracks__title"><b>{t.title || "—"}</b><small>{t.artist_name || "—"}</small></div>
      <div class="tracks__cell">{t.album_title ?? "—"}</div>
      <div class="tracks__cell">{t.genre_name ?? "—"}</div>
      <div class="tracks__mono">{fmtDur(t.duration_ms)}</div>
    </div>
  )}
</For>
```

**Resultado esperado:**
```tsx
<For each={tracks() ?? []}>
  {(t, i) => (
    <TrackRowTable
      track={t}
      index={t.track_number ?? i() + 1}
      onClick={() => play(t)}
    />
  )}
</For>
```

**Imports a adicionar:**
```tsx
import { TrackRowTable } from "../components/TrackRowTable";
```

**O que NÃO mudar:** hero section, container `.tracks` + headers, lógica
`play()` e `playAll()`, imports `CoverArt`, `Icon`, `ICONS`.

**Critérios de aceitação:**
- [ ] `grep -n "function fmtDur" src/views/Album.tsx` → zero resultados.
- [ ] `grep -n "TrackRowTable" src/views/Album.tsx` → 2 resultados (import + uso).
- [ ] `grep -n "tracks__row" src/views/Album.tsx` → zero resultados inline.
- [ ] `git diff --name-only` mostra apenas `src/views/Album.tsx`.

**Checklist de validação visual (para sessão principal após merge):**
- [ ] 5 colunas alinhadas no tracklist do álbum
- [ ] Hero (capa, título, artista, botão play) intacto
- [ ] Número da faixa exibido (track_number, não index sequencial)
- [ ] NPI aparece na célula # da track em reprodução
- [ ] Hover e click funcionam

---

### Tarefa G — Migrar `Playlist.tsx`

**Worktree:** sim (paralelo com F, H, I, J, K)
**Dependências:** Tarefas A, B, C mergeadas + gate [E] aprovado
**Arquivo-alvo:** modificar `src/views/Playlist.tsx`
**Repo:** `/home/opc/rustify-player` | Branch base: `fix-playback-race-condition`

**Contexto para o subagente:**

Este projeto é Tauri 2 + SolidJS (TSX). `Playlist.tsx` usa `.tracks--with-cover`
(6 colunas: `36px 44px 1fr 180px 110px 70px`). A migração usa o `coverSlot` do
`TrackRowTable` para injetar a coluna de capa. O container `.tracks.tracks--with-cover`
e seus headers (incluindo o header de capa vazio) NÃO mudam.

**Estado atual de `src/views/Playlist.tsx`:**
- L25–28: função local `fmtDur` (REMOVER — `fmtTotalDur` em L30–36 NÃO remover)
- L157–183: bloco `<For>` com linhas inline (SUBSTITUIR)

**Bloco a remover (L25–28):**
```tsx
function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
```
**ATENÇÃO:** `fmtTotalDur` (L30–36) é diferente e fica — é usada no hero para
mostrar duração total da playlist.

**Bloco a substituir (L157–183):**
```tsx
<For each={tracks() ?? []}>
  {(t, i) => (
    <div class="tracks__row" onClick={() => play(t)} style={{ display: "contents" }}>
      <div class="tracks__idx">{String(i() + 1).padStart(2, "0")}</div>
      <div class="tracks__cover">
        <Show
          when={t.album_cover_path}
          fallback={
            <div class="tracks__cover-fallback">
              {/* @ts-ignore */}
              <iconify-icon icon="lucide:disc-3" noobserver style={{ "font-size": "14px" }} />
            </div>
          }
        >
          <img src={coverUrl(t.album_cover_path!)} alt="" loading="lazy" />
        </Show>
      </div>
      <div class="tracks__title">
        <b>{t.title || "—"}</b>
        <small>{t.artist_name || "—"}</small>
      </div>
      <div class="tracks__cell">{t.album_title ?? "—"}</div>
      <div class="tracks__cell">{t.genre_name ?? "—"}</div>
      <div class="tracks__mono">{fmtDur(t.duration_ms)}</div>
    </div>
  )}
</For>
```

**Resultado esperado:**
```tsx
<For each={tracks() ?? []}>
  {(t, i) => (
    <TrackRowTable
      track={t}
      index={i() + 1}
      onClick={() => play(t)}
      coverSlot={
        <div class="tracks__cover">
          <Show
            when={t.album_cover_path}
            fallback={
              <div class="tracks__cover-fallback">
                {/* @ts-ignore */}
                <iconify-icon icon="lucide:disc-3" noobserver style={{ "font-size": "14px" }} />
              </div>
            }
          >
            <img src={coverUrl(t.album_cover_path!)} alt="" loading="lazy" />
          </Show>
        </div>
      }
    />
  )}
</For>
```

**Imports a adicionar:**
```tsx
import { TrackRowTable } from "../components/TrackRowTable";
```

**O que NÃO mudar:** hero mosaico 2x2, `fmtTotalDur`, container `.tracks.tracks--with-cover`,
headers (incluindo header de capa vazio), lógica `play()`, `playAll()`, `togglePin()`.
Manter `import { coverUrl }` (ainda usado no `coverSlot`).
Verificar se `Show` já está importado de `"solid-js"` (está — L11).

**Critérios de aceitação:**
- [ ] `grep -n "function fmtDur" src/views/Playlist.tsx` → zero resultados.
- [ ] `grep -n "function fmtTotalDur" src/views/Playlist.tsx` → 1 resultado (preservado).
- [ ] `grep -n "TrackRowTable" src/views/Playlist.tsx` → 2 resultados.
- [ ] `git diff --name-only` mostra apenas `src/views/Playlist.tsx`.

**Checklist de validação visual:**
- [ ] 6 colunas alinhadas: # / Cover / Title / Album / Genre / Length
- [ ] Capa por linha renderiza (imagem ou fallback disco)
- [ ] Hero mosaico 2x2 e stats intactos
- [ ] NPI aparece na célula # (não na coluna de capa)
- [ ] Hover e click funcionam

---

## FASE 5 — Família B/C (paralelo, pós-gate)

> **Sessão principal:** Despachar H, I, J, K em paralelo junto com F e G
> (ou logo após, dependendo de merge conflicts em extractor-lab.css — verificar).
> Todas exigem worktree.

### Tarefa H — Migrar `History.tsx`

**Worktree:** sim (paralelo com F, G, I, J, K)
**Dependências:** Tarefas A, B, D mergeadas + gate [E] aprovado
**Arquivo-alvo:** modificar `src/views/History.tsx`
**Repo:** `/home/opc/rustify-player` | Branch base: `fix-playback-race-condition`

**Contexto para o subagente:**

Este projeto é Tauri 2 + SolidJS (TSX). `History.tsx` renderiza histórico de
reprodução em `<div class="row-list">` com linhas `.row`. A linha atual
(L59–73 da versão atual) tem: `CoverArt` | `row__meta` | `row__when` | `row__time`.
A migração usa `TrackRowList` que encapsula cover + NPI + meta + when + time.

**Estado atual de `src/views/History.tsx`:**
- L11–14: função local `fmtDur` (REMOVER)
- L16–24: função local `relTime` (REMOVER — passa a vir de `../lib/format`)
- L57–73 (corpo do `<For>`): bloco inline a substituir

**Bloco a remover (L11–24):**
```tsx
function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function relTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}
```

**Bloco a substituir (L57–73, dentro do `<For>`):**
```tsx
<div class="row" onClick={() => play(t)}>
  <CoverArt
    seed={t.album_title || t.id}
    src={coverUrl(t.album_cover_path)}
    size="sm"
    class="row__cover"
    style={{ width: "40px", height: "40px" }}
  />
  <div class="row__meta">
    <div class="row__title">{t.title || "—"}</div>
    <div class="row__sub">{t.artist_name || "—"}{t.album_title && <> · {t.album_title}</>}</div>
  </div>
  <div class="row__when">{relTime(t.last_played)}</div>
  <div class="row__time">{fmtDur(t.duration_ms)}</div>
</div>
```

**Resultado esperado:**
```tsx
<TrackRowList
  track={t}
  onClick={() => play(t)}
  whenText={relTime(t.last_played)}
/>
```

**Imports a modificar:**
- Adicionar: `import { TrackRowList } from "../components/TrackRowList";`
- Adicionar: `import { relTime } from "../lib/format";`
- Remover: `import { CoverArt } from "../components/CoverArt";` (não mais usado)
- Remover: `import { coverUrl, type Track } from "../tauri";` — manter `type Track`
  se ainda referenciado na tipagem do resource; verificar. Se `coverUrl` não
  for mais usado diretamente, remover apenas `coverUrl` mas manter o import
  do tipo: `import type { Track } from "../tauri";`.

**Critérios de aceitação:**
- [ ] `grep -n "function fmtDur\|function relTime" src/views/History.tsx` → zero.
- [ ] `grep -n "TrackRowList" src/views/History.tsx` → 2 resultados.
- [ ] `grep -n "CoverArt" src/views/History.tsx` → zero resultados.
- [ ] `git diff --name-only` mostra apenas `src/views/History.tsx`.

**Checklist de validação visual:**
- [ ] Cover + meta + "X min ago" + duração alinhados
- [ ] NPI overlay sobre a capa da track em reprodução
- [ ] Estado vazio ("Sem histórico ainda") intacto

---

### Tarefa I — Migrar `Home.tsx` (seção "Recently played")

**Worktree:** sim (paralelo com F, G, H, J, K)
**Dependências:** Tarefas A, B, D mergeadas + gate [E] aprovado
**Arquivo-alvo:** modificar `src/views/Home.tsx`
**Repo:** `/home/opc/rustify-player` | Branch base: `fix-playback-race-condition`

**Contexto para o subagente:**

Este projeto é Tauri 2 + SolidJS (TSX). `Home.tsx` tem três seções: Hero,
"Recently played" e album grid. **Apenas a seção "Recently played" (L159–182)
é migrada.** O hero e o album grid NÃO mudam — não tocá-los.

`CoverArt` ainda é usado no album grid (L196–203) — manter o import.
`coverUrl` ainda é usado no hero tile (L91) — manter o import.

**Estado atual relevante de `src/views/Home.tsx`:**
- L18–21: função local `fmtDur` (REMOVER)
- L23–30: função `relativeTime` (REMOVER — passa a usar `relTime` de format.ts)
- L159–182: seção "Recently played" com `<div class="row">` inline (SUBSTITUIR só o corpo do For)

**Bloco a remover (L18–21):**
```tsx
function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
```

**Bloco a remover (L23–30):**
```tsx
function relativeTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  const diff = Date.now() / 1000 - ts;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)} min ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} h ago`;
  return `${Math.floor(diff / 86400)} d ago`;
}
```

**Bloco a substituir (dentro do `<For each={d().recent}>` em L160–181):**
```tsx
<div class="row" onClick={() => playRow(t, d().recent)}>
  <CoverArt
    seed={t.album_title || t.id}
    src={coverUrl(t.album_cover_path)}
    size="sm"
    class="row__cover"
    style={{ width: "40px", height: "40px" }}
  />
  <div class="row__meta">
    <div class="row__title">{t.title || "—"}</div>
    <div class="row__sub">
      {t.artist_name || "—"}{t.album_title && <> · {t.album_title}</>}
    </div>
  </div>
  <div class="row__when">{relativeTime(t.last_played)}</div>
  <div class="row__time">{fmtDur(t.duration_ms)}</div>
</div>
```

**Resultado esperado:**
```tsx
<TrackRowList
  track={t}
  onClick={() => playRow(t, d().recent)}
  whenText={relTime(t.last_played)}
/>
```

**Imports a modificar:**
- Adicionar: `import { TrackRowList } from "../components/TrackRowList";`
- Adicionar: `import { relTime } from "../lib/format";`
- Manter: `import { CoverArt } from "../components/CoverArt";` (usado no album grid)
- Manter: `import { coverUrl } from "../tauri";` (usado no hero tile e album grid)

**O que NÃO mudar:**
- Seção Hero (L83–149)
- Seção "Based on your favorites" / album grid (L185–213)
- Função `playRow`, `shuffleAll`, `playAlbum`

**Critérios de aceitação:**
- [ ] `grep -n "function fmtDur\|function relativeTime" src/views/Home.tsx` → zero.
- [ ] `grep -n "TrackRowList" src/views/Home.tsx` → 2 resultados.
- [ ] `grep -n "CoverArt" src/views/Home.tsx` → pelo menos 1 (no album grid).
- [ ] `git diff --name-only` mostra apenas `src/views/Home.tsx`.

**Checklist de validação visual:**
- [ ] Seção "Recently played" tem cover + meta + "X min ago" + duração
- [ ] NPI overlay sobre a capa da current track
- [ ] Hero tiles e album grid intactos (não foram tocados)

---

### Tarefa J — Migrar `Queue.tsx`

**Worktree:** sim (paralelo com F, G, H, I, K)
**Dependências:** Tarefas A, B, D mergeadas + gate [E] aprovado
**Arquivo-alvo:** modificar `src/views/Queue.tsx`
**Repo:** `/home/opc/rustify-player` | Branch base: `fix-playback-race-condition`

**Contexto para o subagente:**

Este projeto é Tauri 2 + SolidJS (TSX). `Queue.tsx` renderiza a fila completa
em página. Tem um componente local `QueueRow` (L75–105) que será removido e
substituído por `TrackRowList`.

**Detalhe crítico:** `QueueRow` usa `.row` com `grid-template-columns: "40px 1fr auto 60px"`
sobrescrito inline (4 colunas, sem coluna de tempo relativo). `TrackRowList`
suporta isso via prop `noWhen={true}`.

O estado current era via prop `current` (com `background: var(--blue-bg)` inline).
Com `TrackRowList`, o highlight de current é automático via store — não passar prop.

**Estado atual de `src/views/Queue.tsx`:**
- L12–15: função local `fmtDur` (REMOVER)
- L75–105: função `QueueRow` inteira (REMOVER)
- L37: `<QueueRow track={t()} current />` → substituir
- L47: `<QueueRow track={t} />` → substituir
- L58: `<QueueRow track={t} muted />` → substituir

**Bloco a remover (L12–15):**
```tsx
function fmtDur(ms: number): string {
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
```

**Função a remover inteira (L75–105):**
```tsx
function QueueRow(props: { track: Track; current?: boolean; muted?: boolean }) {
  return (
    <div
      class="row"
      style={{
        "grid-template-columns": "40px 1fr auto 60px",
        opacity: props.muted ? 0.55 : 1,
        background: props.current ? "var(--blue-bg)" : undefined,
      }}
      onClick={() => playTrack(props.track)}
    >
      ...
    </div>
  );
}
```

**Substituições nas 3 chamadas:**
```tsx
// Era (L37): <QueueRow track={t()} current />
<TrackRowList track={t()} onClick={() => playTrack(t())} noWhen />

// Era (L47): <QueueRow track={t} />
<TrackRowList track={t} onClick={() => playTrack(t)} noWhen />

// Era (L58): <QueueRow track={t} muted />
<TrackRowList track={t} onClick={() => playTrack(t)} noWhen muted />
```

**Imports a modificar:**
- Adicionar: `import { TrackRowList } from "../components/TrackRowList";`
- Remover: `import { CoverArt } from "../components/CoverArt";` (encapsulado no componente)
- Remover: `import { coverUrl, type Track } from "../tauri";` — verificar se
  `Track` ainda é referenciado (provavelmente não após remover `QueueRow`); se não,
  remover import completo.

**O que NÃO mudar:**
- Cabeçalho da page (header com contagens upcoming/past)
- Seções "Now playing", "Up next", "History" e seus títulos
- Estado vazio ("Fila vazia")

**Critérios de aceitação:**
- [ ] `grep -n "function fmtDur\|function QueueRow" src/views/Queue.tsx` → zero.
- [ ] `grep -n "TrackRowList" src/views/Queue.tsx` → 4 resultados (import + 3 usos).
- [ ] `grep -n "CoverArt" src/views/Queue.tsx` → zero.
- [ ] `git diff --name-only` mostra apenas `src/views/Queue.tsx`.

**Checklist de validação visual:**
- [ ] 3 seções (Now playing / Up next / History) com títulos corretos
- [ ] Current track tem highlight azul (via store, sem prop `current`)
- [ ] Tracks muted (history) com opacidade reduzida
- [ ] NPI overlay sobre capa da current track
- [ ] Grid de 4 colunas (sem coluna de tempo relativo)

---

### Tarefa K — Migrar `QueueDrawer.tsx`

**Worktree:** sim (paralelo com F, G, H, I, J)
**Dependências:** Tarefas A, B, D mergeadas + gate [E] aprovado
**Arquivo-alvo:** modificar `src/components/QueueDrawer.tsx`
**Repo:** `/home/opc/rustify-player` | Branch base: `fix-playback-race-condition`

**Contexto para o subagente:**

Este projeto é Tauri 2 + SolidJS (TSX). `QueueDrawer.tsx` é o painel lateral
de fila (slide-over). Tem uma função local `QRow` (L111–133) usando `.qrow`
com cover 36px. Migrar para `TrackRowList` com `size="compact"`.

O estado current (`qrow--current`) era passado via prop `current`. Com
`TrackRowList`, é automático via store — o componente aplica `.qrow--current`
e `.qrow--current::before` (barra azul lateral) automaticamente quando
`player.currentTrack?.id === track.id`.

**Estado atual de `src/components/QueueDrawer.tsx`:**
- L18–22: função local `fmtDur` (REMOVER — `totalRemaining` em L24–32 NÃO remover)
- L111–133: função `QRow` inteira (REMOVER)
- L76: `<QRow track={t()} current />` → substituir
- L95: `<QRow track={track} />` → substituir

**Bloco a remover (L18–22):**
```tsx
function fmtDur(ms: number): string {
  if (!ms) return "—";
  const s = Math.round(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}
```
**ATENÇÃO:** `fmtDur` no QueueDrawer tem `if (!ms) return "—";` extra.
A versão em `format.ts` retorna `"00:00"` para ms=0, não `"—"`. Isso é
diferença comportamental mínima (duração 0 não ocorre em tracks reais).
Aceitar a versão do `format.ts` (comportamento ligeiramente diferente para ms=0).

**Função a remover inteira (L111–133):**
```tsx
function QRow(props: { track: Track; current?: boolean }) {
  return (
    <div
      class={`qrow${props.current ? " qrow--current" : ""}`}
      onClick={() => playTrack(props.track)}
    >
      <CoverArt ... />
      <div class="qrow__meta">...</div>
      <div class="qrow__time">{fmtDur(props.track.duration_ms)}</div>
    </div>
  );
}
```

**Substituições:**
```tsx
// Era (L76): <QRow track={t()} current />
<TrackRowList track={t()} onClick={() => playTrack(t())} size="compact" />

// Era (L95): <QRow track={track} />
<TrackRowList track={track} onClick={() => playTrack(track)} size="compact" />
```

**Imports a modificar:**
- Adicionar: `import { TrackRowList } from "./TrackRowList";`
  (note: componente está em `src/components/`, import relativo sem `../components/`)
- Adicionar: `import { fmtDur } from "../lib/format";`
  (ainda necessário para `totalRemaining` em L24–32)
- Remover: `import { CoverArt } from "./CoverArt";` se não mais usado.
- Verificar: `import { coverUrl, type Track } from "../tauri";` — `coverUrl`
  vai para dentro de TrackRowList. `Track` pode ainda ser necessário para
  tipos internos; se não, remover.

**O que NÃO mudar:**
- `totalRemaining()` — usa `fmtDur` local que agora vem de `format.ts`
- Lógica de abrir/fechar o drawer (eventos, Escape, Q key)
- Botão "Clear" da seção "Up next"
- Estado vazio do drawer

**Critérios de aceitação:**
- [ ] `grep -n "function fmtDur\|function QRow" src/components/QueueDrawer.tsx` → zero.
- [ ] `grep -n "TrackRowList" src/components/QueueDrawer.tsx` → 3 resultados (import + 2 usos).
- [ ] `grep -n "totalRemaining" src/components/QueueDrawer.tsx` → ainda presente.
- [ ] `git diff --name-only` mostra apenas `src/components/QueueDrawer.tsx`.

**Checklist de validação visual:**
- [ ] Drawer abre com tecla Q
- [ ] Tamanho compacto preservado (36px cover, padding menor que as listas normais)
- [ ] Track atual tem background azul e barra lateral azul (`.qrow--current::before`)
- [ ] NPI overlay sobre capa da track atual (36px)
- [ ] Botão "Clear" remove fila
- [ ] Drawer fecha com Esc

---

## FASE 6 — Limpeza e verificação final (sequencial)

### Tarefa L — Limpeza final

**Worktree:** não (sequencial, após todas as migrações mergeadas)
**Dependências:** Todas as tarefas F, G, H, I, J, K mergeadas
**Arquivo-alvo:** nenhum arquivo novo — verificação e remoção de resíduos
**Repo:** `/home/opc/rustify-player` | Branch: `fix-playback-race-condition`

**Contexto para o subagente:**

Este projeto é Tauri 2 + SolidJS (TSX). Todas as migrações de views foram
feitas em tarefas paralelas. Esta tarefa final verifica que não restaram
resíduos e faz limpeza pontual se necessário.

**Verificações obrigatórias:**

```bash
# 1. fmtDur inline não deve existir em nenhuma view
grep -rn "function fmtDur" /home/opc/rustify-player/src/views/
# Esperado: zero resultados

# 2. relTime/relativeTime locais removidos
grep -rn "function relTime\|function relativeTime" /home/opc/rustify-player/src/views/
# Esperado: zero resultados

# 3. QueueRow e QRow removidos
grep -rn "function QueueRow\|function QRow" /home/opc/rustify-player/src/
# Esperado: zero resultados

# 4. Nenhum tracks__row inline remanescente nas views
grep -rn "class=\"tracks__row\"" /home/opc/rustify-player/src/views/
# Esperado: zero resultados (a classe existe só no CSS e no TrackRowTable)

# 5. Nenhum .row inline remanescente nas views (exceto .row-list que é container)
grep -rn "class=\"row\"" /home/opc/rustify-player/src/views/
# Esperado: zero resultados (a classe existe só no CSS e no TrackRowList)

# 6. Backend não tocado
cargo check --manifest-path /home/opc/rustify-player/src-tauri/Cargo.toml
# Esperado: sem erros novos
```

**Se alguma verificação falhar:** corrigir o resíduo no arquivo indicado
(remover a função duplicada ou substituir o markup inline) antes de prosseguir.

**Verificação de imports órfãos:** para cada view migrada, verificar se
`CoverArt` e `coverUrl` ainda são usados diretamente. Se não, remover o import.
Usar `grep -n "CoverArt\|coverUrl" src/views/<arquivo>.tsx` para confirmar.

**Critérios de aceitação da tarefa L:**
- [ ] Todas as 6 verificações bash acima retornam zero resultados.
- [ ] `cargo check` passa sem erros novos.
- [ ] `git diff --name-only` mostra apenas os arquivos de views remanescentes
  com limpeza pontual (se houver).

---

## Motion free-wins (validado contra WebKitGTK 2.52.3 na cmr-auto)

> **Validação de ambiente (2026-06-04):** a cmr-auto (Ubuntu 24.04) roda
> `libwebkit2gtk-4.1` **2.52.3**. Isso está três ciclos além do corte do Skia
> (2.46, set/2024): rendering por GPU por padrão, CSS filters/blur acelerados,
> async scrolling endurecido (2.51.91/2.52), tiles em worker threads.
> Consequência direta: `content-visibility: auto` é **plenamente suportado**
> (chegou no ciclo Safari 18 / WebKitGTK 2.46) e `contain` idem. Os itens (d) e
> (e) abaixo estão **liberados**.

Esta subseção documenta otimizações de performance de renderização que cabem
dentro deste refactor — por estarmos criando os componentes e tocando o CSS
dessas listas de qualquer jeito. Não expande o escopo de fases nem muda o grafo.

### (a) e (b) — Já incorporados na Tarefa B

Documentados diretamente no CSS da Tarefa B (NowPlayingIndicator):

- **(a) `prefers-reduced-motion`:** bloco `@media (prefers-reduced-motion: reduce)`
  desliga `npi-bounce` e `will-change`. Barras ficam estáticas no estado de altura
  final — indicador de current permanece visível. A11y + fallback para máquina fraca.

- **(b) `will-change: transform` cirúrgico:** aplicado apenas em
  `.npi--playing .npi__bar` (o único seletor onde a animação `transform: scaleY`
  de fato ocorre). O NPI existe para no máximo 1 track (a current) — custo de
  VRAM é trivial. Removido por `will-change: auto` dentro do bloco
  `prefers-reduced-motion`. NÃO colocar `will-change` permanente nem fora do
  estado playing.

### (c) — Já incorporado nas Tarefas C e D

Documentado como nota nas seções de CSS de ambas as tarefas:

- **Transições compositor-friendly:** nenhuma regra nova de estado-current usa
  `transition: all`. Apenas `background-color` e `color` são propriedades que
  o browser anima sem reflow. O padrão das classes existentes (`.tracks__row`,
  `.row`) já segue essa disciplina — as novas regras mantêm o padrão.

### (d) — SEGURO, implementar junto com Fase 2

`contain: layout style` nas linhas `.row` e `.qrow` (Família B/C) para isolar
reflow. Elementos com grid próprio (não `display: contents`) se beneficiam
deste hint ao browser: mudanças internas não propagam reflow para fora da linha.

**Implementação:** adicionar a propriedade nas regras base `.row` e `.qrow`
em `extractor-lab.css`. A Tarefa D (criação do `TrackRowList`) modifica a
seção `.row` — é o momento certo.

```css
/* Acrescentar em .row (L500) e .qrow (L1152): */
contain: layout style;
```

**Nota:** `display: contents` (Família A, `.tracks__row`) não gera box — `contain`
não tem efeito em `display: contents`. Para a Família A, a contenção de reflow
acontece naturalmente pelo grid do container `.tracks`.

**Status:** SEGURO — `contain: layout style` é amplamente suportado. Integrar
na Tarefa D (adicionar em `.row` e `.qrow` junto com as demais edições CSS da
tarefa). Requer atualização do critério de aceitação da Tarefa D para verificar
a presença de `contain` nas duas regras base.

### (e) — LIBERADO (WebKitGTK 2.52.3 confirmado), implementar junto com Fase 2

`content-visibility: auto` + `contain-intrinsic-size` para pular paint de linhas
fora da viewport. Ganho real de scroll em listas grandes (biblioteca com 983 tracks).

**Limitação crítica — Família A:** Linhas da Família A usam `display: contents`
e não geram box próprio. `content-visibility` não tem efeito em elementos com
`display: contents`. Para a Família A (Tracks, Album, Playlist), a otimização
seria aplicada no container `.tracks`, não nas linhas — requer avaliação separada
de `content-visibility: auto` no container com `contain-intrinsic-size` baseado
na altura total estimada do grid. Não trivial: o grid tem altura variável.

**Para a Família B/C:** aplicação direta nas linhas `.row` e `.qrow` (que têm
box próprio) seria a abordagem correta:
```css
.row { content-visibility: auto; contain-intrinsic-size: auto 61px; }
.qrow { content-visibility: auto; contain-intrinsic-size: auto 52px; }
```
(alturas estimadas: padding 10px × 2 + cover 40px + border 1px ≈ 61px para `.row`;
padding 8px × 2 + cover 36px ≈ 52px para `.qrow`)

**LIBERADO: WebKitGTK 2.52.3 na cmr-auto suporta `content-visibility: auto`.**
Implementar na Tarefa D, junto com `contain` (item d), nas regras base `.row` e
`.qrow` de `extractor-lab.css`. Família A (`.tracks__row` com `display: contents`)
fica de fora — não recebe `content-visibility` (sem box); a contenção de reflow
ali vem naturalmente do grid do container. Fallback gracioso garantido: engines
sem suporte ignoram a propriedade sem quebrar. Atualizar o critério de aceitação
da Tarefa D para verificar `content-visibility` em `.row` e `.qrow`.

---

## Riscos e mitigações

| Risco | Probabilidade | Mitigação |
|-------|--------------|-----------|
| Merge conflict em `extractor-lab.css` (B, C, D escrevem em regiões próximas) | Alta | Sequenciar merges: B primeiro (seção `.qrow`), depois C (seção `.tracks__row`), depois D (seção `.row`). São blocos em linhas distintas (1173, 892, 509) — conflito real improvável se mergeados em ordem. |
| Grid desalinha em Família A com `coverSlot` undefined | Média | `Show when={props.coverSlot !== undefined}` não renderiza a célula. Validado no piloto (Tracks sem cover) e em Playlist (com cover). |
| `.row` CSS 5-col com 4 filhos em Queue | Alta | Resolvido via prop `noWhen` que aplica override inline. |
| `fmtDur` no QueueDrawer retorna "—" para ms=0; format.ts retorna "00:00" | Baixa | Diferença comportamental irrelevante em produção (duração 0 não ocorre em tracks reais). |
| Regressão visual no QueueDrawer (barra `::before`) | Média | O `classList={{ "qrow--current": isCurrent() }}` é aplicado dinamicamente — o seletor CSS `.qrow--current::before` continua funcional. Verificado no checklist da Tarefa K. |

## Reversão por tarefa

Cada tarefa de migração toca apenas 1 arquivo de view:
```bash
git checkout src/views/<arquivo>.tsx   # reverte migração de uma view
git checkout src/components/QueueDrawer.tsx  # reverte QueueDrawer
```
Os componentes novos (`TrackRowTable`, `TrackRowList`, `NowPlayingIndicator`,
`format.ts`) continuam existindo sem prejudicar nada — views não migradas
simplesmente não os importam.
