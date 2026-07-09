# Triagem de Controles Zumbi — Plano Mestre

> **Origem:** UI recriada fielmente dos mockups do Claude Design (`Settings.tsx:4`,
> `Stations.tsx:4` dizem "Recriacao da view seguindo o mockup"). A camada visual
> chegou; o backend não, em parte dela. Resultado: ~13 botões mortos, 2 stubs,
> 5 toggles que persistem em `localStorage` sem consumidor, 3 seções mock.

**Princípio (definido pelo CEO):** sem hot-fix, sem half-assing. Cada controle tem
exatamente dois destinos honestos — **implementar de verdade** (backend Rust incluso
quando preciso) ou **remover limpo**. Um toggle que salva `localStorage` e finge é
proibido: ou liga no consumidor real, ou sai da UI.

**Como ler:** organizado por tier de dificuldade. Cada item traz `file:line`, destino
recomendado, e o escopo real (o que exige código novo). Os planos executáveis TDD
passo-a-passo são gerados por subsistema **depois** que o escopo for aprovado — não
detalho código exato pra controle que pode ser cortado.

---

## Decisões já cravadas

| Item | Destino | Razão |
|------|---------|-------|
| Output device "Change…" (`Settings.tsx:494`) | **REMOVER** | CEO, 06/06. Switch de sink em runtime é pesado e baixo valor. |
| Scrobble Last.fm "Connect…" (`Settings.tsx:547`) | **REMOVER** | Aversão documentada a Last.fm (`CLAUDE.md` curator). Se houver scrobble um dia, é ListenBrainz — outra feature. |
| "Generate missing" embeddings (`Settings.tsx:610`) | **REMOVER** | Redundante: o "Re-scan" já gera embeddings faltantes (próprio hint da linha 585 confirma). |
| qdrant "Restart…" (`Settings.tsx:628`) | **REMOVER** | Manutenção interna de sidecar — não pertence à UI do usuário final. |
| Crossfade slider (`Settings.tsx:469`) | **REMOVER** | CEO, 06/06. Engine tem gapless slot, não crossfade; implementar é core do engine. Reintroduz quando a feature existir de verdade. |
| Beat sync (`Settings.tsx:442`) | **IMPLEMENTAR** | CEO 06/06 achava que funcionava; verificado órfão (`ENV_GAIN` const, modo nunca lido). Consumidor é barato — vai pro Tier 2. |
| New playlist (`Playlists.tsx:168,260`) | **IMPLEMENTAR via `.m3u`** | CEO 06/06: "criar arquivo local". Correto, desde que o arquivo seja `.m3u` (referências), não cópia de FLAC. Rebaixa de Tier 3 pra Tier 2. |
| Roadmap panel (`Signal.tsx:603`) | **MANTER** | CEO, 06/06. Showcase rotulado ("not wired"), não zumbi disfarçado. |

---

## TIER 0 — Remover (custo ~zero, ganho de honestidade imediato)

Deleção limpa de markup + estado órfão. Sem backend. Cada um é uma edição localizada.

| # | Controle | Local | O que sai |
|---|----------|-------|-----------|
| 0.1 | Output device "Change…" | `Settings.tsx:488-498` | a `set-row` inteira |
| 0.2 | Scrobble "Connect…" | `Settings.tsx:541-549` | a `set-row` inteira |
| 0.3 | "Generate missing" | `Settings.tsx:601-620` | a `set-row` (mantém a row "Embeddings" como stat read-only, sem botão) |
| 0.4 | qdrant "Restart…" | `Settings.tsx:622-636` | a `set-row` (mantém o hint de status como read-only) |
| 0.5 | "Resume station" CTA disabled | `Stations.tsx:273` | troca o botão `disabled` morto por um CTA real "Create first station" no empty-state, ou remove |
| 0.6 | Gapless toggle | `Settings.tsx:478-486` + `toggleGapless` + `GAPLESS_KEY` | **engine já é sempre-gapless** (`engine.rs:559`); o toggle é mentira. Remove toggle + key + handler |
| 0.7 | Crossfade slider | `Settings.tsx:460-476` + `onCrossfadeTrackClick` + `CROSSFADE_KEY` | engine não tem crossfade; remove slider + handler + key. Reintroduz quando o core ganhar a feature |
| 0.8 | Set library path "Trocar…" | `Settings.tsx:563-580` + `console.log` stub | CEO 06/06: re-apontar a raiz da biblioteca pela UI é convite a corromper o índice. Remove o botão; a row "Music folder" fica read-only mostrando o path atual |

**Critério de aceite do tier:** após remover, `rg 'rustify-mock-gapless|rustify-mock-crossfade' src` = 0 ocorrências;
nenhuma `set-row` sem ação clicável em Settings/Playback; nenhum `console.log("[settings] TODO` restante; build + tsc limpos.

---

## TIER 1 — Trivial (frontend, padrão já existe, < 30 min cada)

Backend 100% pronto. É só ligar o handler ao que já existe.

| # | Controle | Local | Implementação |
|---|----------|-------|---------------|
| 1.1 | Botão play do card de álbum | `Albums.tsx:45` | reusa o padrão de `Album.tsx:33-37`: `libGetTracksByAlbum(a.title)` → `setQueue(all,0,"curated")` → `playTrack(all[0])`. `e.stopPropagation()` pra não disparar a navegação do card. |
| 1.2 | Botão play do card (Home) | `Home.tsx:179` | idêntico ao 1.1 |
| 1.3 | NowPlaying "More" | `NowPlaying.tsx:240` | `openTrackMenu(e, player.currentTrack)` — o `TrackContextMenu` já existe e está montado |
| 1.4 | "Recently played" (sort) | `Playlists.tsx:178` | sort local no `createMemo` de folders por `last_played` (já vem no folder? validar; senão é Tier 2) |
| 1.5 | "Sort by name" link | `Playlists.tsx:253` | toggle de ordenação local A→Z / Z→A no `rest()` memo |

**Critério de aceite:** cada controle produz efeito visível (toca/abre/reordena); teste
de unidade Solid cobrindo o handler onde houver lógica (sort, seed da fila).

---

## TIER 2 — Médio (estado novo no frontend, ou backend pequeno)

Exige criar signal global, consumidor, ou um comando Rust enxuto. Sem tocar no core do engine.

| # | Controle | Local | Escopo |
|---|----------|-------|--------|
| 2.1 | Stations "New from current track" | `Stations.tsx:196` | completar o stub: `seedTrackIds:[player.currentTrack.id]`, `kind:"seed"`. Backend `lib_create_station` **já aceita** seed; `lib_find_similar` existe pra popular. Desabilita o CTA quando não há track tocando. |
| 2.2 | Compact sidebar | `Settings.tsx:412` | signal global em `store/ui.ts` (novo) → `Sidebar.tsx` consome → CSS `.sidebar--compact` (ícones-only). Substitui a key órfã `rustify-mock-compact-sidebar` por estado real. Frontend puro. |
| 2.3 | Resume on launch | `Settings.tsx:506` | o resume de sessão **existe** (`persist_load_state`); o toggle precisa gatear a chamada no boot (`main.tsx`/`App.tsx`). Ler a key antes de re-tocar. Frontend + 1 ponto de wiring. |
| 2.4 | Beat sync (4 botões) | `Settings.tsx:442` | **verificado órfão** (06/06): `SpectrumCanvas` usa `ENV_GAIN = 0.5` const (`:42,206`), nunca lê o modo. Consumidor: o modo escala `ENV_GAIN` (off→0, subtle→0.25, default→0.5, pulse→1.0). Signal global lido pelo `SpectrumCanvas`. Frontend. |
| 2.5 | "Reorder" pinned | `Playlists.tsx:191` | drag-reorder dos pinned via `store/pins.ts` (já persiste ordem). HTML5 DnD ou pointer. Frontend. |
| 2.6 | New playlist (`.m3u`) | `Playlists.tsx:168,260` + `TrackContextMenu.tsx` | **modelo `.m3u`** (referências, não cópia de FLAC). Backend: comando Rust `lib_list_m3u_playlists` (lê `<music_root>/playlists/*.m3u` ou dir dedicado) + parser que resolve paths→`Track`; criar/append usam `fs_write_text` (já existe). UI: "New playlist" escreve `.m3u` vazio; "Add to playlist" no context menu faz append. Convive com folder-playlists (read-only) na mesma view. |

**Critério de aceite:** teste cobrindo cada consumidor novo (sidebar colapsa, beat sync escala
o ganho, resume respeita o flag, `.m3u` round-trips path↔track); nenhuma key `rustify-mock-*`
sem consumidor restante.

---

## TIER 3 — Pesado (backend Rust / decisão de modelo de dados)

Cada um é um mini-projeto. Aqui é onde "sem half-assing" custa caro — e por isso são
decisões de escopo do CEO antes de eu detalhar TDD.

**Tier 3 está vazio.** Todos os candidatos a backend pesado foram resolvidos por decisão do CEO (06/06):

- **Set library path** → Tier 0 (item 0.8), **removido**. Re-apontar a raiz pela UI corrompe o índice; risco > valor.
- **New playlist** → Tier 2 (item 2.6) via modelo `.m3u`. Não é tabela de dados nova; é arquivo de referências + `fs_write_text` (já existe). FLAC nunca é copiado.
- **Crossfade** → Tier 0 (item 0.7), **removido**. Reintroduz quando o engine ganhar overlap+fade de verdade.

Nenhuma leva desta triagem toca o core do engine nem cria tabela de banco. É tudo remoção, wiring de frontend, ou arquivo `.m3u`.

---

## TIER 4 — Roadmap declarado (não é zumbi)

| Item | Local | Status |
|------|-------|--------|
| Painel "Roadmap" do Signal — 8 cards DSP (Multiband comp, Compressor, Maximizer, Gate, Crossfeed, Convolver, Stereo tools, +1) com ~16 botões `visual only` | `Signal.tsx:603-628, 765-796` | **Se confessa**: badge "not wired", títulos "(visual only)". Cada card é um plugin DSP no engine (LSP/Calf/zita) — um projeto cada. |

Não é zumbi disfarçado: é showcase honesto de roadmap. **Decisão do CEO:** manter como
está (aspiracional e rotulado) **ou** remover o painel pra UI mais enxuta. Não se
implementa "no atacado" — cada plugin entra individualmente quando for a vez.

---

## Smart Playlists — plano próprio (decisão CEO 06/06)

`Playlists.tsx:99-103, 173, 212-247` — tabela de 3 linhas hardcoded + botão "New smart
playlist" + link "View all rules". Depende de um **engine de regras** (play_count, date_added,
never_played, etc) que não existe.

**Decisão:** não remover às cegas — tratar como **feature a construir**, com plano dedicado
gerado por planning-with-skills (`docs/plans/2026-06-06-smart-playlists-feature.md`). Esse plano
decide: modelo de regra (predicados sobre o schema da `Library`), persistência (`.rules`/JSON ou
tabela), avaliação (eager vs lazy), e se o mock visual atual fica como esqueleto durante o
desenvolvimento ou sai até a feature existir. Smart playlists **não entram** nas levas de
limpeza (Tiers 0-2).

---

## Sequência de execução proposta

1. **Tier 0 + Smart Playlists removal** — uma branch, um PR. Limpa a casa, zero risco.
2. **Tier 1** — uma branch. Ganhos visíveis imediatos (cards tocam, "More" abre menu).
3. **Tier 2** — uma branch por subsistema (sidebar / sync / resume / stations / reorder)
   ou agrupado, conforme apetite. Cada um com teste.
4. **Tier 3** — só os aprovados, plano TDD dedicado por item (3.1 primeiro).
5. **Tier 4** — decisão binária (manter/remover), sem implementação agora.

Cada tier vira seu próprio plano executável TDD (formato writing-plans) na hora de rodar.
Este documento é o mapa de escopo — congela O QUÊ e POR QUÊ antes do COMO.

---

## Decisões do CEO (06/06)

| # | Tema | Decisão |
|---|------|---------|
| D1 | New playlist | **Implementar via `.m3u`** (Tier 2.6). FLAC não é copiado; arquivo de referências. |
| D2 | Crossfade | **Remover** o slider (Tier 0.7). |
| D3 | Beat sync | **Implementar** consumidor (Tier 2.4). Verificado órfão hoje. |
| D4 | Roadmap panel | **Manter** rotulado. |
| D5 | Set library path | **Remover** (Tier 0.8). Re-apontar a raiz pela UI corrompe o índice — risco > valor. |
| D6 | Smart playlists | **Plano próprio** via planning-with-skills. Não entra nas levas de limpeza. |

Escopo congelado. Nenhuma decisão de produto pendente.
