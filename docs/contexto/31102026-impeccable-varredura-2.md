# Segunda varredura do Impeccable: Rustify Player

- **Data:** 31/10/2026
- **Versão avaliada:** 0.2.102 (commit `ca04e07`, `main`), desktop e S24
- **Modo:** proposta, só pelo código. Ponte MCP e app não usados: outra sessão estava com a janela, e toda rodada pela ponte exige autorização escrita do CEO. Nada foi editado, compilado ou medido no app.
- **Avaliações:** 18, cobrindo 17 comandos: critique (CR), audit desktop (AU), audit + adapt do S24 (MB), adapt desktop (AD), harden (HD), clarify (CL), layout (LY), typeset (TY), distill (DS), onboard (OB), optimize (OP), polish (PL), bolder (BD), quieter (QT), animate (AN), colorize (CO), delight (DL), overdrive (OD). De fora: init, shape, craft, document, extract (iniciar projeto) e live, generate (exigem a tela).
- **Modelos:** Opus (esforço alto) no critique e nos dois audits; Sonnet (esforço médio) nos demais.
- **Capturas:** só as de 25-26/10 em `.impeccable/captures/` (versão 0.2.96, antes da leva 1), usadas como contexto de composição e citadas com data. Não há captura de biblioteca, fila, Tweaks, Settings, Signal, Mover nem S24.
- **Detector estático** em `src/` (31/10): 2 `pulsing-dot` no desktop (`.np__tag-playing .dot`, `extractor-lab.css:906`; `.st-feature__eyebrow .dot`, `:3164`) e 13 advisories de escala de fonte e raio no S24. Nos recortes de cada avaliador, zero achados: os problemas desta rodada são de comportamento, contraste sobre o fundo e texto, que o detector não vê.
- **Contraste:** quando não diz o contrário, no Really Dark (tema em uso; valores do `DESIGN.md` e do sidecar; acento de repouso #d6d6d6). O `:root` do `extractor-lab.css` é a paleta clara de repouso e aparece entre parênteses.

## Resumo para o CEO

1. **Barra do player apertada desde os medidores de 30/10.** Numa faixa nova trazida pelo rádio, o nome do artista some atrás de dois selos que dizem a mesma coisa ("RÁDIO · DESCOBERTA" e "1ª ESCUTA"). A pílula "FLAC 24/96 · EQ · LIM" pode quebrar em duas linhas, acende como botão e não faz nada. O trilho do seek e o do volume quase não se veem: a correção de 26/10 (A15) nunca entrou.
2. **Sinais que mentem.** A barra lateral tem um medidor que dança sorteado ao lado do medidor real. O ponto do "Now Playing" pulsa com a música pausada. No Crate, "na fila" usa o mesmo âmbar de "travou", e a linha que pede ação não se destaca.
3. **Biblioteca.** Clicar num álbum da grade toca em vez de abrir. Dois álbuns com o mesmo nome se misturam. Se o banco de vetores falha, as telas dizem "Nenhuma track encontrada" ou ficam em branco, como se o acervo tivesse sumido. Artistas é uma parede do mesmo cassete e não abre pelo teclado. "Genre" na tela é a playlist.
4. **Fila.** Segurar Delete tira mais de uma faixa e o foco some depois da primeira. "Clear" apaga tudo sem volta. Com só a faixa atual, a gaveta diz "0 tracks · 0:00 remaining" e não diz que o rádio vai continuar.
5. **Crate e Tidal.** O que a Tidal baixa não aparece na barra lateral nem no "baixando". "Baixar" numa linha da Tidal não muda a linha e aceita clique duplo. Falhas aparecem como "Completed, Errored", com IP ou como "já tinhas".
6. **Texto.** Além do que o A24 de 26/10 listava, cerca de 400 textos em inglês (Settings, Signal, Tweaks, barra, menu, fila, biblioteca, S24), "1 tracks" em 12 lugares e três formatos para o mesmo número.
7. **S24.** A Home não rola quando o dedo começa nos cards do topo. "Remover animações" não acalma o fundo. O fundo fica sob desfoque de tela cheia fora do Now Playing (o defeito que derrubou a Home do desktop a 46,9 fps). Chips, segmentados e o mini player têm alvos de 28 a 36 px.

**Números.** 278 achados brutos nos 18 relatórios (pela classificação dos avaliadores: 217 A, 52 B, 4 C e 5 marcados só como duplicata de 26/10). Depois de juntar e reclassificar: **64 entram direto (A), 35 esperam decisão (B), 24 descartados (C)**. Os A são de custo P ou M, salvo duas partes G (miniaturas de capa em A49; o PT-BR inteiro em A50).

**Dados como feitos em 26/10 e que não estão no código:** A15 (nunca entrou); A16, A22 e A23 só no desktop (o S24 ficou sem fundo calmo, com a curva Material, o trilho da letra de 600 ms e sem resposta ao toque); B6 só no WebGL do desktop (o 2D, padrão de fábrica, e o S24 seguem com filtro de tela cheia); B10 só no desktop. E uma regressão da leva de 30/10: o "loop que não media nada" saiu das listas e ficou na barra lateral.

## Pontuações

| Comando | 31/10 | 26/10 | Observação |
|---|---|---|---|
| critique | **25/40 (Aceitável)** | 27/40 | Recorte diferente (hoje Crate, fila, barra, biblioteca, Mover, menu; em 26/10 Home, Now Playing, Stations, Crate vazio): não é a mesma linha. |
| audit desktop | **14/20 (Bom)** | 12/20 | Crate, fila, barra, biblioteca, Tweaks, Settings, Signal, Mover, menu. |
| audit S24 | **11/20 (Aceitável)** | primeira vez | `src/mobile/` inteiro, sem aparelho. |

| # | Heurística (critique) | 31/10 | 26/10 | Ponto principal de hoje |
|---|---|---|---|---|
| 1 | Visibilidade do estado | 2 | 3 | Downloads da Tidal invisíveis fora da aba |
| 2 | Linguagem do usuário | 2 | 2 | "Genre" quer dizer playlist; inglês e português no mesmo menu |
| 3 | Controle e liberdade | 3 | 3 | "Clear" e "Mover" sem desfazer |
| 4 | Consistência | 2 | 2 | Três seletores de pasta; card de álbum que toca numa tela e abre na outra |
| 5 | Prevenção de erro | 3 | 3 | Nome novo com Enter move na hora; clique duplo na Tidal |
| 6 | Reconhecimento | 3 | 3 | Artistas é grade de cassetes iguais |
| 7 | Flexibilidade | 3 | 4 | Álbuns e Artistas sem filtro nem teclado |
| 8 | Estética e minimalismo | 2 | 2 | Primário preto por linha no Crate; selos repetidos na barra |
| 9 | Recuperação de erro | 2 | 2 | Biblioteca mostra "vazio" quando falha |
| 10 | Ajuda | 3 | 3 | Dicas de tecla boas; atalho da fila só no tooltip |

| Dimensão (audit) | Desktop 31/10 | Desktop 26/10 | S24 31/10 |
|---|---|---|---|
| Acessibilidade | 2 | 2 | 2 |
| Desempenho | 3 | 3 | 2 |
| Tema | 3 | 2 | 3 |
| Responsividade (e toque, no S24) | 3 | 3 | 2 |
| Integridade | 3 | 2 | 2 |

## O que de 26/10 não está feito

Conferido no código em 31/10:

| Item | Estado | Evidência |
|---|---|---|
| **A15** trilho do progresso | **Nunca entrou.** E a conta estava errada: `--fg-1` a 22 % sobre o paper dá 1,8 a 1,9:1 (AU: 1,83:1; minha conta: 1,93:1), não "cerca de 3:1". A1 usa `--fg-7` (3,84:1), a proposta do AU. | `extractor-lab.css:1486-1491` (`var(--line-2)` em `:1488`); zero ocorrências de `fg-1) 22%` |
| **A16** reduzir animação | Só no desktop. O bloco CSS do S24 diz que "o fundo acalma pelo sinal": não acalma. | `src/mobile/styles/app.css:1110-1121`; `src/mobile/bg/GlBg.tsx` sem `calm`, `reduced` ou `mode`; zero `matchMedia` em `src/mobile/` |
| **A22** curva e trilho da letra | Só no desktop. | `src/mobile/styles/tokens.css:50` (`cubic-bezier(0.4, 0, 0.2, 1)`); `app.css:919` (`transform 0.6s`) |
| **A23** resposta ao toque | Só no desktop. | `tokens.css:88` (tap highlight desligado); `:active` só em 4 classes do S24 |
| **B6** ambient na GPU | Só no WebGL do desktop. 2D (padrão de fábrica) com `blur(8px)` de tela cheia; S24 com `blur(6px)` e folha com `backdrop-filter`. | `extractor-lab.css:308-311`; `store/tweaks.ts:169` (`bgEngine: "2d"`); `app.css:802-805, 968` |
| **B10** troca de faixa | Crossfade de capa feito no desktop (0.2.98); o S24 troca seco. | `createSwapKey` só em `NowPlaying.tsx`, `PlayerBar.tsx`, `CoverArt.tsx` |
| Leva de 30/10 | **Regressão:** medidor sorteado na barra lateral (o CLAUDE.md diz que o loop falso saiu). | `src/components/Sidebar.tsx:79-90` |

Pendentes que seguem abertos:

| Item | Estado hoje | Evidência |
|---|---|---|
| A24 PT-BR em lote | Aberto e maior (A50). | `Home.tsx:134, 139, 170, 213-214` ("Quick start", "Shuffle all", "From your library", "Recently played", "View history →") |
| A26 S24 toque e tons | Aberto; a troca de valor proposta não basta (A54, A59). | `app.css:888-891` (30 px); `--t4` #6e6e6e, `--accent` #997081 |
| A27 tokens de espaçamento | Aberto e ampliado (A48). | Nenhum `--space-*` (só o comentário de `:3686`) |
| B2 capa do Now Playing maior | Sem decisão. | `extractor-lab.css:869-870` (200 px); `NowPlaying.tsx:518, 527` |
| B11 a capa voa | Sem decisão (B30 depende dele). | Sem voo de capa no código |
| B12 letra com mola, seek com verso | Sem decisão; nenhum avaliador retomou. | Sem `is-next` nem `linear()` |
| B17 reflow | Sem decisão, com fato novo (B23). | 2 media queries de largura no CSS |
| B20 reforma tipográfica | Sem decisão, números novos (B32). | 231 `font-size`; 47 abaixo de 11 px |

Feitos e conferidos: A1, A2, A12, A14 (no escopo dele), A16 e A21 no desktop (acento #d6d6d6, `DESIGN.md:739`), A17, A18, A19, A20, B1, B5, B7, B8, B9, B13, B23.

## A. Entra direto

Sem decisão de produto. Ordem: impacto no uso diário vezes custo; desktop (A1-A51), depois S24 (A52-A64, num APK). "Conferido" marca linha reaberta em 31/10.

### A1. O trilho do seek e o do volume quase não se veem
- **Tela:** barra do player (seek de faixa sem perfil; volume sempre).
- **Problema no uso:** a linha de 3 px some; não se vê onde a faixa termina nem até onde vai o volume.
- **Causa:** `.progress` em `--line-2` = 1,19:1 (1,26:1 no `:root`); piso de controle 3:1. É o A15 de 26/10.
- **Proposta:** `.progress { background: var(--fg-7) }`, o "resto" do contorno do seek: 3,84:1. Preenchimento segue carbono 3. No `:root` claro o `--fg-7` dá 2,17:1: se importar, `--fg-6` só lá.
- **Esforço:** P
- **Evidência:** `extractor-lab.css:1486-1491, 1522-1531` (conferido); `git show 9c48a93` sem A15. Verificar na tela: faixa sem perfil e volume a 50 %.
- **Comandos:** AU, CR, PL, CO

### A2. Os selos da barra comem o nome do artista e repetem a mesma informação
- **Tela:** barra do player, linha do artista; pior numa descoberta do rádio nunca ouvida até o fim.
- **Problema no uso:** `[RÁDIO · DESCOBERTA] [1ª ESCUTA] Artis…`: dois selos dizem "você não conhece esta faixa" e o cortado é o artista. Avulsa, "SOLTA" ocupa o lugar para dizer que não há origem. Sobra para o artista no monitor do dono: de 36 a 115 px conforme a conta de cada avaliador (não medido).
- **Causa:** selos inline-block antes do texto numa linha `nowrap`; "1ª escuta" ignora o `srcPick()`; `.pb-src` em 10 px e peso 650 (única ocorrência).
- **Proposta:** no rádio, um selo só com o grau: 0 fins "rádio · 1ª escuta", 1-2 "rádio · descoberta", conhecida "rádio"; fora do rádio, "1ª escuta" como hoje; sem selo em `solta`. `.pb-artist` em `inline-flex`, selos `flex: none`, texto com `min-width: 0` e reticências; `.pb-src` em `--fs-label`, peso 600. Pular o `libTrackFamiliarity` quando o pick traz `ended`.
- **Esforço:** P
- **Evidência:** `PlayerBar.tsx:592-610`, `extractor-lab.css:1358-1364` (conferido). Verificar na tela: descoberta com álbum de título longo.
- **Comandos:** DS, TY, LY, AD, QT, DL, CR

### A3. A coluna direita da barra não cabe, e o "+N" tapa o mudo
- **Tela:** barra do player, direita (medidor, pílula, letra, fila, mudo, volume).
- **Problema no uso:** o medidor custou ~48 px numa coluna justa; a pílula pode quebrar e os botões de letra e fila encolhem. Ao enfileirar, o "+3" cobre o mudo por 1,6 s.
- **Causa:** colunas `minmax(240px,1fr) 1.4fr minmax(240px,1fr)`; a direita pede ~403-426 px para ~387-403 (estimado); `.pb-tech` sem `nowrap`/`flex: none`; `.pb-queue__ack` com `left: 100%`.
- **Proposta:** `.pb-tech { white-space: nowrap; flex: none }`, `.pb-btn, .pb-queue { flex: none }`, `.pb-right { min-width: 0 }`; colunas `minmax(0,1fr) 1.2fr minmax(430px,1fr)`; com 3 etapas de DSP, "DSP 3" e a lista no `title`. "+N" acima do botão (`left: 50%; bottom: calc(100% + 2px)`).
- **Esforço:** P
- **Evidência:** `extractor-lab.css:1344, 1431-1433, 1537, 1556` (conferido). Verificar na tela: `scrollWidth` de `.pb-right` com faixa lossy e EQ, LIM, BASS.
- **Comandos:** LY, DS, AD, PL, CR

### A4. A pílula técnica acende como botão e não faz nada; o verde "tudo certo" brilha sempre
- **Tela:** barra do player (pílula) e Tweaks > Fundo (ponto do WebGL).
- **Problema no uso:** cursor de mão e hover, mas o clique não leva a nada; o texto de qualidade só no `title`. O halo verde no estado normal compete com o âmbar.
- **Causa:** `.pb-tech` com `cursor: pointer` e `:hover` num `<div>` sem ação; halo no estado ok em `.pb-tech__dot` e `.tweaks__gl-dot`.
- **Proposta:** tirar cursor e hover; `role="img"` + `aria-label` com o `techTitle()`; halo só em `--lossy`/`--low`. Abrir o Signal pela pílula seria recurso novo.
- **Esforço:** P
- **Evidência:** `extractor-lab.css:1538-1550` (conferido), `:2018-2029`; `PlayerBar.tsx:766-779`.
- **Comandos:** AU, PL, QT

### A5. A barra lateral anima um medidor sorteado
- **Tela:** cartão "tocando agora" da barra lateral.
- **Problema no uso:** três barras dançam a cada 220 ms sem relação com o som, ao lado do medidor real; ignoram "reduzir animação" e rodam pausado.
- **Causa:** `setInterval` com `Math.random()`, `height` inline.
- **Proposta:** trocar pelo `NowPlayingIndicator` (nível real, laço único, respeita movimento reduzido); apagar timer e signal; atualizar `Sidebar.test.tsx`.
- **Esforço:** P
- **Evidência:** `Sidebar.tsx:79-90` (conferido), `:220-224`.
- **Comandos:** QT, OP

### A6. O acento da capa fica abaixo de 4,5:1 como texto; capa quase cinza vira acento colorido
- **Tela:** faixa atual nas listas, botões ligados, chip RÁDIO, "baixando"; aba ativa e título tocando no S24.
- **Problema no uso:** com capa azul, roxa ou vermelha, o texto no acento fica entre 3,67 e 3,91:1 sobre hover e linha atual. Capa P&B com leve matiz (comum em JPEG) pinta a interface de azul ou violeta.
- **Causa:** `ACCENT_CONTRAST_TARGET = 4.0` medido só contra o canvas; o comentário "≥ 4,5:1 garantido" é falso; portão acromático em HSL (`s < 0.05`) dispara com croma imperceptível (#10131a, croma OKLCH 0,015, vira #456dc9).
- **Proposta:** alvo 5,2 (simulado pelo CO no código real: pior acento sobre `--bg-soft` 4,64:1; `on-primary` 4,75:1); `INK_CONTRAST_TARGET` fica 4,0. Portão por croma OKLCH < 0,03 em `deriveAccent` e `deriveInk` (`hexToOklch` de `gl/paintPalette.ts` para `lib/color.ts`). S24: `--on-accent-c` contra o container. Corrigir o comentário.
- **Esforço:** P
- **Evidência:** `src/lib/inkDerive.ts:14, 44` (conferido), `:34, 48`; `mobile/adaptiveColor.ts:41-66`. Verificar na tela: capa azul e vermelha com hover na vizinha.
- **Comandos:** CO, MB

### A7. Falha ao ler o acervo parece acervo vazio, e uma exceção derruba a tela
- **Tela:** Faixas, Álbuns, Artistas, Álbum, Artista, Playlist, Playlists, Histórico.
- **Problema no uso:** com o Qdrant engasgado, "Nenhuma track encontrada.", "Sem histórico ainda" ou grade em branco; carregando, grades em branco e o Histórico diz "Sem histórico". "Sem playlists." nunca aparece; filtro sem resultado fica mudo. Recarga (trocar gênero, terminar Mover) pode piscar a tela inteira com "Loading…".
- **Causa:** todo `catch` devolve `[]`; nenhum `ErrorBoundary` em `src/`; `Suspense` reacende em recarga; `Playlists.tsx:218` testa `folders()` e `[]` é verdadeiro. O S24 já faz certo (`mobile/components/ui.tsx:68-70`).
- **Proposta:** `EmptyState` (`tone: vazio | erro`, ações) com a cara do `.crate-empty`; os `catch` guardam o erro; erro = banner rosa "Não consegui ler o acervo agora." + [Tentar de novo]; carregando = "Carregando o acervo…"; vazio com frase por tela. `ErrorBoundary` no `Dynamic` do `RouterView` e no Mover, barra do player fora dele. Recarga por `.latest` a 0,6 com `aria-busy`.
- **Esforço:** M
- **Evidência:** `Tracks.tsx:20, 24`, `Albums.tsx:17`, `Artists.tsx:14`, `History.tsx:14`, `Playlists.tsx:125, 216-220`; `grep ErrorBoundary` vazio (conferido).
- **Comandos:** HD, OB, CR, CL

### A8. Fila pelo teclado: Delete repetido tira a mais, o foco cai no vazio, a gaveta fechada rouba o Tab
- **Tela:** gaveta da fila (Q).
- **Problema no uso:** depois de Delete, a próxima tecla não faz nada; segurar Delete tira mais de uma. Fechada, o Tab some da tela por vários toques; aberta pelo Q, o foco fica atrás do véu.
- **Causa:** `focusGrip` roda no mesmo instante em que `removeAt` anima 180 ms; segunda tecla acha a mesma linha e tira a seguinte; gaveta fechada só por `translateX(100%)`; `<aside>` sem `role`, rótulo nem foco.
- **Proposta:** foco no `done()` de `removeAt` (índice `min(i, len - 1)`; vazia, foco no fechar); `WeakSet` de linhas saindo e `if (e.repeat) return`. Fechada: `visibility: hidden` com atraso (padrão da paleta). Aberta: `role="dialog"`, `aria-modal`, `aria-label="Fila"`, foco no fechar, Tab preso, Esc devolve ao `#pb-queue` (`aria-expanded`). `sr-only role="status"` anuncia "tirada" e "posição 3 de 12".
- **Esforço:** P
- **Evidência:** `QueueDrawer.tsx:106-125` (conferido); `extractor-lab.css:1680-1692`. Verificar na tela: segurar Delete numa fila de 8.
- **Comandos:** AU, HD, AN

### A9. A fila com só a faixa atual diz "0 tracks", e clicar nela recomeça a música
- **Tela:** gaveta e `/queue`, fim de álbum, depois de "Clear", rádio recém-aberto.
- **Problema no uso:** "0 tracks · 0:00 remaining" e nada embaixo; o dono não sabe que o rádio continua. "1 tracks". Clicar em "Now playing" toca do zero e registra mais um play para o motor.
- **Causa:** "Up next" só com itens; vazio exige `!currentTrack`; linha atual chama `playTrack`, que chama `libRecordPlay`.
- **Proposta:** "Depois desta, o rádio escolhe." / "Depois desta, a fila recomeça." / "Fim da lista. O rádio continua depois dela.", 12 px `--fg-5`; cabeçalho "só esta faixa". A linha atual abre o Now Playing e fecha a gaveta. Total em `fmtDur`.
- **Esforço:** P
- **Evidência:** `QueueDrawer.tsx:178, 191` (conferido), `:197, 238-241`; `PlayerBar.tsx:1071-1096`.
- **Comandos:** OB, HD, CR

### A10. No Crate, espera normal é âmbar igual a "travou"
- **Tela:** Crate, linha de estado, banners e pílulas.
- **Problema no uso:** numa leva de dez, dez pílulas âmbar de espera; "travou" não se distingue. O âmbar tem sete significados no código, contra três documentados.
- **Causa:** `crate-pill--warn` em "aguardando vaga", "na fila", "travou", "quase", "aguardando"; banners com pastéis de capa (`--tone-*`) e `color-mix` em 10/25/28/30/40/55 %; dois "no acervo" de cores diferentes.
- **Proposta:** espera em `crate-pill--sub`; âmbar só em "travou", "quase" e compra/e-mail pendente; Signal desligado/bypass neutro. Tokens `--sig-*-wash` (10 % sobre o paper) e `--sig-*-line` (30 %); um "no acervo" só, "já estava" no texto. `DESIGN.md` registra os papéis do âmbar.
- **Esforço:** P (pílulas) / M (tokens)
- **Evidência:** `Crate.tsx:455, 459, 498, 533, 542` (conferido); `extractor-lab.css:4298, 4353-4364, 4683-4704, 4749`.
- **Comandos:** QT, CO

### A11. Cada linha de resultado do Crate tem peso de botão
- **Tela:** Crate > Buscar, Fila, fila da Tidal.
- **Problema no uso:** 30 "Baixar" pretos com o peso do Buscar; o olho não acha a linha do teclado. Cada linha repete "Soulseek" sob "Soulseek · 24 faixas", põe o formato numa caixa igual às clicáveis e tem chips que acendem sem fazer nada. A dica de teclas aparece duas vezes.
- **Causa:** `crate-btn--primary` em toda linha; `OriginBadge` por linha; `.crate-badge` com caixa; spans com hover e cursor; `crate-search__kbd` sempre visível.
- **Proposta:** "Baixar" de linha em `crate-btn`, primário só na linha com foco; sem selo de origem nos resultados (fica nos downloads); formato em texto mono `--fg-5`; spans falsos em `.crate-tag`; teclas do campo só no vazio; na Tidal, "Rádio" e "Escolher faixas" só no hover e foco.
- **Esforço:** P
- **Evidência:** `Crate.tsx:716-747, 763, 894-899, 1011, 1030, 1909-1915, 2101-2105`; `TidalTab.tsx:151-160, 242`; `extractor-lab.css:4437-4439, 4593-4620`.
- **Comandos:** CR, QT

### A12. O ponto do Now Playing pulsa pausado; a Stations vazia é a tela mais fraca do app
- **Tela:** Now Playing; Stations vazia; station cujas sementes sumiram.
- **Problema no uso:** o ponto respira mesmo pausado. A Stations vazia tem ponto pulsante, chips que parecem sementes, seis cartões-fantasma "0 played · last: —", "botao" e "musicas" sem acento. "Play station" sem sementes no acervo não faz nada e não avisa.
- **Causa:** o ponto não lê `isPlaying`; `stPulse` só no estado vazio; `Stations.tsx:483` sem `else`. São os dois `pulsing-dot` do detector.
- **Proposta:** ponto pulsa só tocando; pausado, `--fg-7` sem halo (o pulso que resta é estado ao vivo: `ignore-value` com o motivo). Stations vazia vira `EmptyState` "Nenhuma station ainda" com [Criar a partir de “<faixa atual>”] e [Nova station por clima]; saem cartões-fantasma, chips falsos e `stPulse`. Station sem faixas: banner "Esta station não achou faixas no acervo. As sementes podem ter sido movidas." com [Apagar] e legenda "0 de N sementes no acervo".
- **Esforço:** P
- **Evidência:** `NowPlaying.tsx:538-540`, `Stations.tsx:561` (conferido); `extractor-lab.css:902-908, 3159-3172`.
- **Comandos:** QT, OB, AN (pediu manter o pulso: mantido enquanto toca)

### A13. Seek com perfil: pisca na troca, muda de altura, sai borrado e trava com o botão direito
- **Tela:** barra do player, seek.
- **Problema no uso:** a cada troca o contorno some e volta, com salto de 3 para 14 px; com zoom 1,15 as barras de 2 px saem macias (provável); botão direito no trilho congela barra e relógio; depois de 59:59 a barra encolhe.
- **Causa:** `setWaveMask(null)` antes do IPC; alturas 3 e 14 px; `devicePixelRatio` sem o zoom do Tweaks; sem checar `e.button` nem `pointercancel`; colunas de tempo `minmax(42px, auto)`.
- **Proposta:** caixa de 14 px sempre (sem perfil, trilho de 3 px centrado); perfil lido no efeito da troca; `dpr × tweaks().scale`; `if (e.button !== 0) return` e fim do gesto em `pointercancel`, `blur`, `visibilitychange`; tempos com `min-width: 7ch`; traço por `transform`. Cobertura do perfil na régua. O seek não anima.
- **Esforço:** P a M
- **Evidência:** `PlayerBar.tsx:417-422` (conferido), `:348-372, 432-440`; `extractor-lab.css:1483, 1520`; `store/tweaks.ts:350`.
- **Comandos:** OB, OP, HD

### A14. O botão de letra fica aceso em faixa sem letra
- **Tela:** barra do player e Now Playing.
- **Problema no uso:** em faixa sem letra (620 de 729 sem nada no lrclib em 13/10) o botão fica pressionado e nada aparece; "sem letra", "escondida" e "falhou" são iguais.
- **Causa:** `aria-pressed` só pelo tweak; a letra mora no Now Playing; falha vira vazio (`catch(() => [])`).
- **Proposta:** `store/lyrics.ts` com `lyricsState` (`carregando`, `ok`, `sem`, `erro`); sem letra, botão a 0,4 com `aria-disabled` e "Sem letra nesta faixa"; erro, clique refaz. Base também do B12 de 26/10.
- **Esforço:** M
- **Evidência:** `PlayerBar.tsx:783-791`; `NowPlaying.tsx:122-128, 275`.
- **Comandos:** OB

### A15. Três estados da barra que mentem
- **Tela:** barra recém-aberta; primeiros minutos; menu e SelectionBar.
- **Problema no uso:** sem faixa, Play vira Pausa e nada toca; "Próxima" no fim é anunciada indisponível e funciona. No boot, o "1ª escuta" não aparece (cache frio), o que se lê como "já ouvi". "Tocar a seguir" na faixa atual não faz nada e a SelectionBar limpa a seleção como se tivesse dado certo.
- **Causa:** `aria-disabled` sem efeito e `setPlayingState(true)` sem guarda; familiaridade `None` consultada uma vez; `enqueueNext` retorna mudo.
- **Proposta:** `if (!currentTrack) return` no Play; `aria-disabled` honesto com `opacity: .45`. Familiaridade nula: repetir em 3, 10 e 30 s. Enfileirar devolve o número; com 0, o "+N" diz "já está tocando" e a seleção fica. (Play retomar a última é B35.)
- **Esforço:** P
- **Evidência:** `PlayerBar.tsx:664-678` (conferido), `:446-455`; `store/player.ts:261, 277-279`; `desktop.rs:1925-1938`.
- **Comandos:** AU, OB

### A16. Tidal: "Baixar" não muda a linha, aceita clique duplo e aparece no que já tem
- **Tela:** Crate > Tidal, resultados e artista.
- **Problema no uso:** o aviso aparece no topo, fora da vista; dois cliques criam dois jobs; faixa "no acervo" oferece Baixar, sem Tocar. O "no acervo" é calculado uma vez: se falha, tudo parece novo; depois de baixar, segue "novo" até reiniciar.
- **Causa:** `trackDownload` sem trava; ações fixas; `libGetTracks({limit: 100_000}).catch(() => {})` só no `onMount`.
- **Proposta:** a linha mostra a pílula do job (`tidalStatusLabel`) no lugar dos botões; em voo, "Enviando…" desligado; linha `owned` só com "Tocar". Índice recarregado quando um job vira `ok` e com `libraryRevision`; falha avisa em `--fg-5`.
- **Esforço:** P
- **Evidência:** `TidalTab.tsx:808` (conferido), `:137-187, 673, 763, 851-858`.
- **Comandos:** CR, HD

### A17. O que a Tidal baixa não aparece fora da aba Tidal
- **Tela:** barra lateral (selo e ponto de chegada) e "N baixando" do Crate.
- **Problema no uso:** um mix de 50 faixas baixando não aparece; quando chega, não acende o ponto do B8. A Tidal é hoje a fonte principal de lossless.
- **Causa:** `activeCount()` e chegadas só olham o board do slskd; o poll da Tidal vive no Crate.
- **Proposta:** poll da Tidal em `store/crate.ts` (10 s com o Crate aberto, 60 s fechado, parado com a VM fora e a janela oculta); `activeCount()` soma `fila`/`baixando`; job `ok` entra nas chegadas. É o B8 estendido.
- **Esforço:** M
- **Evidência:** `store/crate.ts:40, 74-78` (conferido); `Sidebar.tsx:155-160`; `Crate.tsx:69, 1799`.
- **Comandos:** CR

### A18. Artistas e os álbuns da página do artista só abrem com o mouse
- **Tela:** Library > Artistas; grade de álbuns do Artista.
- **Problema no uso:** o Tab passa direto pelos artistas e só para no play das capas.
- **Causa:** `<div class="card" onClick>` sem botão.
- **Proposta:** o padrão da Playlists: `<button class="card__open">` com o nome e `::after` em `inset: 0`, foco pelo `--focus-outline`.
- **Esforço:** P
- **Evidência:** `Artists.tsx:26` (conferido); `Artist.tsx:73-90`; `Playlists.tsx:98-100`.
- **Comandos:** AU, CR

### A19. Álbuns com o mesmo nome se misturam; artista só com faixas soltas abre vazio
- **Tela:** play do card em Álbuns e Artista; "Ir para o álbum".
- **Problema no uso:** dois "Greatest Hits" viram uma fila; abrir pelo artista B pode mostrar o do A; corte em 200 sem aviso. Artista com faixas sem álbum mostra só "Albums" e "Mover" apagado.
- **Causa:** `libGetTracksByAlbum(título)` sem artista; rota sem artista; `query.rs:203-206` descarta faixa sem álbum.
- **Proposta:** `libGetTracks({ album, artist, limit })` com aviso de corte; rota com `?artista=`; seção "Faixas sem álbum" no Artista; "Mover" habilitado pelas faixas.
- **Esforço:** P
- **Evidência:** `Albums.tsx:21` (conferido); `Artist.tsx:36, 56-75`; `TrackContextMenu.tsx:128-131`; `Album.tsx:22-39`.
- **Comandos:** CR, HD

### A20. Cabeçalho de Álbum e Artista: tocar é um círculo sem rótulo num e não existe no outro
- **Tela:** cabeçalhos de Álbum, Artista, Playlist.
- **Problema no uso:** círculo de 32 px sem texto e sem hover no Álbum; pílula "Play" na Playlist; nada no Artista. Na página do Álbum, a coluna "Album" repete o nome em todas as linhas.
- **Causa:** `.hero-tile__cta` da Home desfeito por inline; Artista só com Mover; tabela padrão sem `extraCols`.
- **Proposta:** `.pl-action-btn--primary` "Tocar" no Álbum e no Artista (álbuns em ordem); Álbum sem a coluna Álbum (`48px minmax(0,1fr) 70px`). O cabeçalho único é B2.
- **Esforço:** P
- **Evidência:** `Album.tsx:94-112`; `Artist.tsx:55-65`; `Playlist.tsx:140-143`.
- **Comandos:** AU, PL, CR, LY, BD

### A21. "Genre" na tela é a playlist
- **Tela:** coluna "Genre", chips de Faixas, aba Genres, "N genres".
- **Problema no uso:** "Genre" mostra "Rap & Hip-Hop", a pasta de primeiro nível; a aba Genres lista as pastas da Playlists, separadas por 36 px, sem ação.
- **Causa:** `genre = dir_comps.first()`; linhas soltas no `.view__body`.
- **Proposta:** coluna "Playlist", chips "Todas" + playlists, "N playlists"; na página de uma Playlist a coluna some; linhas da aba dentro de `.row-list`. O destino da aba é B33.
- **Esforço:** P
- **Evidência:** `library-indexer/src/scan.rs:164` (conferido); `Library.tsx:55, 83-107`; `Tracks.tsx:42-59`.
- **Comandos:** CR, LY

### A22. Erro e sinais do Really Dark abaixo do piso; o validador não os vê
- **Tela:** Crate (falhou, recusada), Tweaks (bench), Mover e paleta.
- **Problema no uso:** a pílula de falha fica a 4,09:1 sobre o próprio fundo, 4,22:1 sobre soft, 3,62:1 sobre faint; ok e aviso quase iguais (ΔE OKLab 2,9).
- **Causa:** sinais #809078 / #908870 / #8b7575; `validate.py` mede só contra o canvas e avisa colapso só com saturação HSL ≥ 0,2.
- **Proposta:** pelo `theme-maker`, L OKLCH ~0,64 com matiz e croma iguais: ok #819279, warn #958d74, err #9d8787 (4,6:1 sobre faint). Não reabre o B16. `validate.py` mede soft e faint e usa ΔE.
- **Esforço:** P
- **Evidência:** sidecar really-dark; `extractor-lab.css:4667-4692`; `validate.py:116-118, 329-338`.
- **Comandos:** AU, CO

### A23. Cor fora do papel: véu que clareia, linha selecionada apagada, Recursos no acento
- **Tela:** paleta e gaveta (véu); seleção múltipla; painel Recursos.
- **Problema no uso:** no Really Dark o véu clareia o fundo; subtítulo das linhas marcadas a 3,72:1; o painel Recursos troca de cor a cada faixa.
- **Causa:** véus em `rgba(23,23,23,…)` (o `--fg-1` claro); sombras literais; `--row-selected` com `--fg-5`; gradiente do acento no painel, que usa `--surface*` inexistentes.
- **Proposta:** `--scrim-rgb: 0, 0, 0` e `rgba(var(--scrim-rgb), .32)`; `--shadow-hover` em menu, gaveta e paleta; subtítulo selecionado em `--fg-3` (7,43:1); Recursos em `--fg-3`/`--fg-5` com âmbar acima de 80 % e rosa acima de 95 %, e três vars de `ACCENT_VARS` sem consumidor saem.
- **Esforço:** P a M
- **Evidência:** `extractor-lab.css:1564, 1674` (conferido), `:3807, 4870`; `store/tweaks.ts:91-95`.
- **Comandos:** CO, AU, PL

### A24. Medidor: traços vazios sem faixa, clip que escurece no Really Dark
- **Tela:** barra do player, medidor L/R.
- **Problema no uso:** sem faixa, duas cápsulas vazias; pausado, o trilho some (1,15:1). No clip, a marca de 1 px vira #8b7575, mais apagada que o pico normal (#f0f0f0).
- **Causa:** `LevelMeter` sempre montado; trilho em `--bg-tint`; `[data-clip]` só troca a cor.
- **Proposta:** sem faixa, oculto com os 40 px reservados; trilho `--line-2`; clip com marca de 3 px em `--rose-ring` e trilho tingido a 28 % enquanto o pico retido dura. Escrever estilo só quando a fração quantizada (1/80) ou o clip mudar.
- **Esforço:** P
- **Evidência:** `extractor-lab.css:1410-1425`; `LevelMeter.tsx:12, 23-37`.
- **Comandos:** CO, PL, QT, OP, CR

### A25. Crate: estados sem saída
- **Tela:** Crate > Fila e busca; vazios das três abas.
- **Problema no uso:** "travou" sem Cancelar e, sem outra fonte, sem Trocar; Soulseek falhado sem "Tentar de novo"; "Terminadas" só cresce; Fila vazia sem botão e esquecendo a Tidal; "Busca falhou" sem ação; com a VM fora, a Tidal convida a buscar com o campo travado; artista e prévia vazios da Tidal sem frase.
- **Causa:** `CANCELLABLE` sem `stalled`; `canRetryExternal` falso para Soulseek (o backend aceita `failed → queued`); `slsk_clear_finished` sem tela; vazio da Tidal sem checar `locked()`.
- **Proposta:** Cancelar no `stalled`; [Tentar de novo] pela transição existente; "Limpar terminadas"; Fila vazia com [Ir para Buscar] [Ir para Tidal]; Busca falhou com [Tentar de novo]; convite oculto com `locked()`; `.crate-empty` no artista e na prévia vazios.
- **Esforço:** M
- **Evidência:** `Crate.tsx:98, 267, 896-912, 2146-2229`; `tauri.ts:899`; `TidalTab.tsx:386-410, 587-594, 828, 1010-1020`.
- **Comandos:** HD, OB, CR

### A26. Erros do Crate e da Tidal em texto de máquina
- **Tela:** Crate (falhou, recusada), Tidal (enfileirar, fila da VM).
- **Problema no uso:** "Completed, Errored"; "já tinhas" (o único "tu" do app); "fila (http://100.64.242.118:8470) respondeu 503" com a sessão vencida, enquanto a busca diz "sessão expirada"; token errado vira "VM não respondeu"; "inalcancavel"; motivo da recusa cortado sem tooltip; o caractere de alerta fora do Lucide.
- **Causa:** `coordinator.rs:1883` grava `raw_state`; `BACKEND_ERRORS` não cobre jobs; `post_fila` perde o corpo; host no texto.
- **Proposta:** mapa de estados do slskd ("o peer interrompeu a transferência", "o peer não respondeu", "o peer recusou o pedido"), cru no `title`; "você já tinha esta faixa"; `status_msg` para todo status, 401/403 "A VM recusou o token da fila."; host só no log; resumo em 2 linhas com `title`; `ICONS.alert`.
- **Esforço:** M
- **Evidência:** `Crate.tsx:110-121, 182, 555-560, 629`; `coordinator.rs:1250, 1674, 1883, 2194`; `tidal_fila.rs:248-296, 354-361`.
- **Comandos:** HD, CL, CR

### A27. Listas do Crate e da Tidal direto sobre o fundo animado
- **Tela:** Crate, todas as abas.
- **Problema no uso:** o risco que a Home tinha em 26/10 (1,41:1 com a Tinta rosa): artista, duração e estado sobre o fundo; na Tidal, texto em `--fg-6`, que só garante 4,5:1 sobre o paper.
- **Causa:** `.crate-list-inner` e `.tdl-list` sem vidro.
- **Proposta:** o vidro barato do A5 de 26/10 nas duas listas (sem `overflow: hidden` nem `backdrop-filter`); textos da Tidal em `--fg-5`. Escurecer o fundo não (B14 recusado).
- **Esforço:** P
- **Evidência:** `extractor-lab.css:760-766, 4406-4422, 4999, 5008-5065`; captura `capture-1792970910645.png` (26/10). Verificar na tela: pior ponto com a Tinta rosa.
- **Comandos:** CR, PL

### A28. Arrastar na fila enquanto a música troca move a faixa errada
- **Tela:** gaveta da fila, perto do fim da faixa.
- **Problema no uso:** ao soltar, a vizinha é movida; se a arrastada vira a atual, linhas ficam com `translateY` preso.
- **Causa:** índice relativo capturado no início; `advanceQueue()` muda o índice; sem `lostpointercapture`.
- **Proposta:** guardar o id; ao soltar, achar o índice atual ou abortar com limpeza; `moveUpcoming`/`removeUpcoming` por id; fim em `lostpointercapture` e `blur`; teste.
- **Esforço:** M
- **Evidência:** `QueueDrawer.tsx:129-171`; `store/player.ts:303-322`; `PlayerBar.tsx:168`.
- **Comandos:** HD

### A29. Gaveta da fila: a tocando e as próximas em colunas diferentes
- **Tela:** gaveta da fila.
- **Problema no uso:** capa em x = 18 na tocando e x = 40 nas próximas; hover só no miolo; a atual marcada três vezes; "Clear" sem área de clique; sem hover, nada indica que arrasta.
- **Causa:** `.qedit` reserva 22 e 24 px invisíveis; `.qrow--current` com fundo, cor e barra; sem `hover: none`; todas as linhas montadas fechada.
- **Proposta:** alça e remover em `absolute` (alvo 24 x 28); realce no `.qedit:hover`; atual sem fundo tingido; "Limpar" com padding e margem negativa; `@media (hover: none)` acende alça e caixa de seleção; `flip` em duas passadas; linhas montadas na primeira abertura.
- **Esforço:** M
- **Evidência:** `extractor-lab.css:1688-1785, 3478`; `QueueDrawer.tsx:46-58, 188-232`.
- **Comandos:** LY, PL, QT, AD, OP

### A30. Tweaks: controles acesos sem efeito, "↺ tema" desmontado, slider nativo, nomes ausentes
- **Tela:** Tweaks.
- **Problema no uso:** Ink cycle, Beat depth, UI Font e Target acesos com o pai desligado; "↺ tema" vira barra de largura total; os 13 sliders são o range do GTK numa caixa; arrastar o Scale reescala o painel sob o cursor; leitor diz "controle deslizante 0,55"; segmentados não dizem o ativo (inclusive a Ponte MCP).
- **Causa:** filhos ignorados em silêncio; `.tweaks__reset { width: 100% }`; `settings-range` sem `appearance: none`; zoom em `onInput`; rótulos sem associação.
- **Proposta:** filho com `aria-disabled` e "Depende de <pai>" (`enabledWhen`); `.tweaks__label .tweaks__reset` compacto com `lucide:rotate-ccw`; o range herda o `.slider`; Scale em `onChange`; `aria-labelledby`, `radiogroup`/`aria-checked`; fechar Lucide de 24 px; Controle remoto com uma dica só.
- **Esforço:** P
- **Evidência:** `Tweaks.tsx:46-143, 441-447, 501-536, 641-660`; `extractor-lab.css:1974-1984, 2002-2009` (conferido).
- **Comandos:** DS, PL, AU, AD

### A31. Settings: interruptores sem nome e, desligados, quase invisíveis
- **Tela:** Settings (Compact sidebar, Resume on launch, Normalizar).
- **Problema no uso:** desligado, pílula cinza sobre painel escuro (1,89:1); leitor diz "botão"; alvo de 30 x 16.
- **Causa:** `.tog` em `--fg-8`; sem rótulo associado.
- **Proposta:** `role="switch"` + `aria-checked` + `aria-labelledby`; desligado com fundo `--bg-tint`, borda `--fg-6` (4,95:1) e bolinha `--fg-5`; área de 24 px por `::before`.
- **Esforço:** P
- **Evidência:** `extractor-lab.css:2974-2984` (conferido); `Settings.tsx:366-371, 427, 459`.
- **Comandos:** AU

### A32. Signal: ajuste recusado parece aplicado, e o estado é dito várias vezes
- **Tela:** Signal.
- **Problema no uso:** motor recusa e o slider mostra o valor novo; na restauração, a primeira falha aborta o resto. Cartões fora da ordem do sinal (EQ, Limiter, Bass, Normalize contra EQ, normalização, Limiter, Bass); ponto no cartão e no nó; "bit-perfect except DSP" fixo; Rename e Delete mortos nos presets de fábrica; import sem acento.
- **Causa:** `.catch(console.error)`; `try` único com ~40 `await`; textos fixos.
- **Proposta:** `dspError` com banner "O motor de áudio recusou um ajuste." + [Reaplicar]; restauração segue depois de erro; cartões na ordem real; ponto só no cartão; sai o texto fixo; Rename e Delete só em preset próprio; textos com acento; transição de cor ao ligar.
- **Esforço:** M
- **Evidência:** `store/dsp.ts:165-224`; `Signal.tsx:184, 221-308, 348-357`.
- **Comandos:** HD, QT, DS, AN

### A33. Fundo: rótulo técnico e contagem errada de cenas (desktop e S24)
- **Tela:** Tweaks > Fundo; Ajustes > Aparência no S24.
- **Problema no uso:** "Fundo WebGL fora do ar (<mensagem interna>)" sem ação; "0 fps" âmbar no primeiro segundo; "quatro cenas" (são oito). O S24 mostra o nome cru da GPU, rótulo que você reprovou, e "PLL", "SpectrumTap".
- **Causa:** `Tweaks.tsx:222-226, 400`; `gl/meta.ts:85`; `mobile/screens/Settings.tsx:113, 158-165, 196-198`.
- **Proposta:** "O fundo WebGL não iniciou; o 2D está no ar." + [Tentar de novo]; "medindo…" com fps 0; "as cenas"; no S24, "as mesmas oito cenas do desktop", só "N fps medidos" e "Quanto o fundo reage ao bumbo."
- **Esforço:** P
- **Evidência:** `mobile/screens/Settings.tsx:113` (conferido); `gl/meta.ts`.
- **Comandos:** OB, MB

### A34. Mover para playlist: o foco some e um nome errado vira pasta na hora
- **Tela:** diálogo Mover.
- **Problema no uso:** confirmação sem foco, Tab atrás do diálogo; com uma faixa, "Rpa & Hip-Hop" + Enter cria a pasta e move; "Rock:Pop" com "Rock_Pop" existente diz "inválido"; em "Movendo", Esc não faz nada sem explicar; falha em inglês do sistema.
- **Causa:** `Switch` desmonta o botão; `total() === 1` chama `run`; `null` para inválido e colisão.
- **Proposta:** foco no primário de cada fase, Tab preso, foco devolvido; pasta nova sempre confirma ("Criar a pasta ~/Music/X e mover 1 faixa?"); colisão com [Usar essa]; "Esc não interrompe: N de M"; [Fechar] após 30 s sem avanço; "Carregando as pastas…". Desfazer é B4.
- **Esforço:** P
- **Evidência:** `MoveToPlaylistDialog.tsx:48-59` (conferido), `:92-103, 117, 174-175`; `lib/moveToPlaylist.ts:49-62`.
- **Comandos:** AU, CR, HD

### A35. O menu de contexto não se usa pelo teclado
- **Tela:** menu de faixa (Menu, Shift+F10, "More" com Enter).
- **Problema no uso:** foco fica no gatilho, sem setas; pelo "More" com Enter abre no canto; ícones de 15 px; coração curtido em carbono.
- **Causa:** só `clientX/Y`; nenhum `focus()`; `role="menu"` sem o padrão; `size={15}`.
- **Proposta:** com `e.detail === 0`, ancorar no gatilho; foco no primeiro item, ↑↓, Home/End, Tab fecha, Esc devolve; 14 px, `--radius-lg`, `--shadow-hover`, coração em `--rose-fg`; `lib/focusReturn.ts` para menu, Mover, gaveta e SelectionBar.
- **Esforço:** M
- **Evidência:** `store/contextMenu.ts:21-37`; `TrackContextMenu.tsx:31-70, 134-208`.
- **Comandos:** AU, PL

### A36. Abas: sem setas, texto fora do gutter, topos diferentes no Crate
- **Tela:** Library e Crate, nas duas densidades.
- **Problema no uso:** setas não trocam de aba; "Tracks" 14 px à direita do título (no compacto do Crate, 4 px à esquerda); a ativa engorda e as vizinhas andam; Buscar, Fila e Tidal começam a 18, 22 e 16 px; a Tidal põe a pasta antes do botão; seções da Tidal em sentença, as outras em caixa-alta.
- **Causa:** `role="tab"` sem teclado; `.tabs` 40 + `.tab` 14; ativa em 600; topos e ordem por aba.
- **Proposta:** helper `tabKeys` e `tabpanel` no Crate; `.tabs { padding-inline: calc(var(--space-gutter) - var(--tab-px)) }`; abas sempre 600, ativa por cor; topo de 18 px; Tidal na ordem do Buscar; seções na receita de rótulo.
- **Esforço:** P
- **Evidência:** `Crate.tsx:1845-1870`; `Library.tsx:73-88`; `extractor-lab.css:1193-1218, 2091-2098, 4161-4167, 4797, 4821, 5016`.
- **Comandos:** AU, LY, AD, TY

### A37. Título cortado com reticências e nenhuma forma de ler inteiro
- **Tela:** barra, gaveta, listas, tabela, cards, Crate, Tidal.
- **Problema no uso:** "(Remastered 2011) [Deluxe Edition]" vira "…" e o hover não mostra nada.
- **Causa:** dez regras com `ellipsis` e nenhum `title`.
- **Proposta:** diretiva `truncTip`: se `scrollWidth > clientWidth`, `title = textContent`, no `pointerenter`/`focus`.
- **Esforço:** M
- **Evidência:** `TrackRowList.tsx:128-141`; `TrackRowTable.tsx:121-124`; `PlayerBar.tsx:587-590`; `TidalTab.tsx:147-148`.
- **Comandos:** TY

### A38. Faixas: filtro longe da tabela; abas e cabeçalho rolam para fora
- **Tela:** Library > Faixas, Playlist e Álbum longos.
- **Problema no uso:** chips a 54 px da tabela que filtram; no meio da lista, somem colunas e abas (~270 px de cromo antes da 1ª linha); título com ~900 px e álbum com 180 px truncando.
- **Causa:** `margin-bottom: 18px` + `gap: 36px`; nenhum `sticky`; `.tracks { overflow: hidden }`; `48px 1fr 180px 120px 70px`; cabeçalho herda 11 e 11,5 px das classes irmãs.
- **Proposta:** filtro e tabela num grupo com `gap: 14px`; abas e `.tracks__head` `sticky` com `overflow: clip`; colunas `48px minmax(240px,1.6fr) minmax(160px,1.2fr) minmax(100px,.7fr) 70px`; cabeçalho em `--fs-label`.
- **Esforço:** M
- **Evidência:** `Tracks.tsx:40-64`; `extractor-lab.css:587, 1220, 1237-1306, 1335`.
- **Comandos:** LY, TY

### A39. A aba Faixas monta o acervo inteiro de uma vez e corta em 5.000 sem avisar
- **Tela:** Library > Faixas, Playlist longa.
- **Problema no uso:** não medido; risco de engasgo ao abrir e rolar ~2.200 linhas (~15 mil nós) junto com a entrada de 360 ms. Acima de 5.000, a lista para sem frase.
- **Causa:** `<For>` sem janela; `.tracks__row` sem `content-visibility` (o `subgrid` atrapalha); `limit: 5000`; `role="row"` sem `grid`.
- **Proposta:** medir antes; se pesar, colunas no próprio `.tracks__row`, `content-visibility: auto; contain-intrinsic-size: auto 52px` ou blocos de 100 (padrão `LazyList`); `role="grid"`; aviso "Mostrando as primeiras 5.000 de N".
- **Esforço:** M
- **Evidência:** `Tracks.tsx:24, 55-71`; `extractor-lab.css:1288-1294` (conferido), `:785, 1768`; `tauri.ts:185`.
- **Comandos:** AU, OP, OD, HD

### A40. A janela pode congelar esperando o acervo; eventos do player podem cair na faixa errada
- **Tela:** barra (troca de faixa), Library, Tidal.
- **Problema no uso:** com o Qdrant lento, fundo e barra param; a barra pede dois comandos por troca, a Library duas varreduras completas. Fim de faixa tardio pode pular uma faixa. Não medido.
- **Causa:** `lib_track_profile`, `lib_track_familiarity`, `lib_list_*` síncronos (no Tauri 2, thread principal), leitura de 30 s; `TrackEnded`/`Position` sem id.
- **Proposta:** `#[tauri::command(async)]` ou `spawn_blocking`, como `lib_move_tracks`; timeout de 5 s; id da faixa nos eventos e descarte do que não for da atual.
- **Esforço:** M
- **Evidência:** `desktop.rs:214-215, 238-239, 1903-1904` (conferido), `:998-1011`; `tauri.ts:93-97`.
- **Comandos:** HD

### A41. Densidade compacta: centro da barra sem folga; a SelectionBar cobre a última linha
- **Tela:** barra e listas com seleção, no compacto.
- **Problema no uso:** seek e play encostam nas bordas; a última faixa fica atrás da SelectionBar.
- **Causa:** barra de 60 px para ~58,5 px de centro; respiro de 32 px contra ~58 px de barra flutuante.
- **Proposta:** no compacto, `.pb-center { padding: 2px 0; gap: 4px }` e play de 32 px; `padding-bottom: 72px` e `.view { scroll-padding-bottom: 72px }`.
- **Esforço:** P
- **Evidência:** `extractor-lab.css:587, 1464, 1483, 2088, 2097, 4923-4937`.
- **Comandos:** AD

### A42. Playlist com poucas capas mostra quadrantes vazios
- **Tela:** Playlists e cabeçalho da Playlist.
- **Problema no uso:** pasta com 1 a 3 álbuns mostra retângulos pastel com disco.
- **Causa:** sempre 4 células.
- **Proposta:** 1 capa ocupa tudo; 2 ou 3 repetem em ciclo; tom só sem capa.
- **Esforço:** P
- **Evidência:** `Playlists.tsx:54-85`; `Playlist.tsx:87-113`. Verificar: quantas pastas têm menos de 4 álbuns.
- **Comandos:** BD

### A43. Ajustes tipográficos pontuais
- **Tela:** cabeçalho das vistas, Playlist, contadores.
- **Problema no uso:** título que quebra fica solto (entrelinha 1,5); a Playlist pesa mais que o destaque da Stations; contadores dançam com mono proporcional.
- **Causa:** `.view__head h1` herda 1,5 (o `DESIGN.md` diz 1,2); Playlist em 700/1,05; 54 regras mono sem `tabular-nums`.
- **Proposta:** `line-height: 1.2; text-wrap: balance`; Playlist em 600/1,1/-0,02em (1,1 também na Stations); `tabular-nums` nas 54 com teste de CSS.
- **Esforço:** P
- **Evidência:** `extractor-lab.css:200, 569-574, 3173-3180, 3892-3900`.
- **Comandos:** TY, PL

### A44. Números: "1 tracks", milhar em inglês, tamanhos e tempos em vários formatos
- **Tela:** Home, Library, Settings, fila, Crate, Tidal, paleta, S24.
- **Problema no uso:** "1 tracks" em 12 lugares, "1 faixas" em 11 do S24; "2,203" e "2203"; "7.1 MB", "7,1 MB", "~7 MB"; "125:30 remaining" e "2h 05min". A legenda do Histórico diz "Últimas 200 faixas tocadas" e é uma linha por faixa distinta.
- **Causa:** três funções de plural; `toLocaleString()` sem localidade; formatadores duplicados no Crate e na Tidal.
- **Proposta:** em `lib/format.ts`: `plural`, `fmtInt` (pt-BR), `fmtSize`, `fmtEta`, `fmtListDur`; `formatTrackTime` vira `fmtDur`; o mesmo em `mobile/derive.ts`. Legenda: "200 faixas, da mais recente à mais antiga; uma linha por faixa".
- **Esforço:** P
- **Evidência:** `Home.tsx:26, 254`; `QueueDrawer.tsx:23-31, 178`; `Crate.tsx:199-216`; `tidalSearch.ts:52-88`; `History.tsx:29`.
- **Comandos:** CL, CR, DL

### A45. Piso de 11 px nas telas que o A14 de 26/10 não cobriu
- **Tela:** fila, Tweaks, Signal, Settings, Crate, tabelas, Playlist, barra.
- **Problema no uso:** o rótulo de seção aparece em quatro tamanhos; os nomes de campo da confirmação do Crate têm 9,5 px; 33 regras de caixa-alta com 16 receitas.
- **Causa:** 45 literais abaixo de 11 px e 39 `11px` escritos à mão com o token pronto; pílulas inline de 9-10 px no Settings.
- **Proposta:** receita única de rótulo (`--fs-label`, 700, +0,06em, `--fg-5`) nas 33 regras; os 39 literais viram o token; `--fs-headline: 22px`, `--fs-title-lg: 14px`; dicas do Tweaks a 12 px. Só o piso: a reforma é B32.
- **Esforço:** M
- **Evidência:** `extractor-lab.css:1278, 1712, 1998, 2338, 2813, 3648, 4291, 4549, 4734`; `Settings.tsx:319-348`; 47 linhas abaixo de 11 px (conferido).
- **Comandos:** TY, PL, AU, CR

### A46. Entradas e saídas que cortam no desktop
- **Tela:** Mover, abas, Crate, Tidal, Signal, SelectionBar, Tweaks, busca do Crate, botões.
- **Problema no uso:** o Mover fecha num corte (o `DESIGN.md` diz `--dur-med`); a aba anima o sublinhado e troca a lista num quadro; cartão e fontes do Crate surgem num salto; prévia, artista e capas da Tidal estalam; a SelectionBar some de uma vez; o Tweaks pula dez controles; a barra da busca anda aos trancos; botões rotulados não afundam ao clique.
- **Causa:** `<Show>`/`<Match>` sem entrada; Mover e SelectionBar desmontam; `--dur-med` para passos de 800 ms; `:active` só no grupo da A23.
- **Proposta:** `state-in` (só opacidade) em painéis de aba, `.crate-card`, `.crate-sources`, `.tdl-page`, `.tdl-results`, capas da Tidal, `.sig-panel__state` e `.tweaks__reveal`; Mover e SelectionBar montados até a saída (`--dur-med`, `--ease-in`); busca com `800ms linear`; `:active` nos botões e `.pb-btn` menos transporte.
- **Esforço:** M
- **Evidência:** `MoveToPlaylistDialog.tsx:21-24`; `extractor-lab.css:1581, 2266-2283, 4713-4718, 4923-4961`; `DESIGN.md:579-581`.
- **Comandos:** AN, PL

### A47. Mesmo controle, peles diferentes
- **Tela:** Crate, Tidal, Settings, Signal, páginas de coleção, Now Playing, SelectionBar, Tweaks.
- **Problema no uso:** botões de 24 a 36 px, raio 5/8/pílula, hover em `--fg-7` ou `--fg-8`; o "Buscar" do Crate só esmaece e o da Tidal troca o fundo; cinco opacidades de desabilitado; campos de 24 a 40 px com dois focos; segmentado ativo claro no Tweaks e invertido no Settings e no Signal; "Hi-Res" diferente do selo do Crate; ícones de 14 px na Tidal.
- **Causa:** famílias nascidas em levas diferentes; `--radius-full` inexistente; chevron do Signal com `#737373` fixo.
- **Proposta:** hover em `--fg-8`; `--radius-pill`; texto do primário em `--bg-paper`; `--disabled-opacity: .45`; foco `--fg-8` + `--ring-focus`; Signal com `.select-shell`; Settings e Signal no `.segmented`; `.tdl-hires` vira `.crate-badge`; raios de 4 px em `--radius-xs`; 14 px só nas setas. Os degraus de botão ficam para B32.
- **Esforço:** M
- **Evidência:** `extractor-lab.css:1898-1915, 2712-2729, 2807-2838, 3551-3573, 3919-3952, 4213-4224, 4624-4651, 5056-5073`.
- **Comandos:** PL, DS

### A48. Espaçamento sem papel (A27 de 26/10, ampliado)
- **Tela:** global, nas duas densidades.
- **Problema no uso:** nada no padrão; o compacto reescreve cada seletor e o Crate não reduz o gutter. Novo: sete topos e cinco intervalos para a mesma função (`.view__body` 28/56/36, `.coll` 28/56/30, `.set` 28/56/22, `.sig` 22/64/18, `.crate-tidal` 16/56/14) e 85 valores fora da escala.
- **Causa:** gutter de 40 px em 18 regras; nenhum `--space-*`.
- **Proposta:** a de 26/10 (`--space-gutter`, `--space-gutter-compact`, `--space-block`) mais `--space-top: 28px` (16) e `--space-end: 56px` (32); `.coll` no `--space-block`; `--space-block-tight` no Signal e Settings; o Crate no compacto. Fora da escala só onde a regra for tocada.
- **Esforço:** M
- **Evidência:** `grep` de 40 px (18 regras) e de `--space` (só `:3686`, conferido). Verificar na tela: Playlists (30 → 36) e topo do Crate e do Signal.
- **Comandos:** LY

### A49. Custos que não se veem: polls, prévia de 200, entrada de tela, capas grandes
- **Tela:** Crate, prévia da Tidal, troca de rota, grades.
- **Problema no uso:** nenhum visível; trabalho de rede e GPU numa máquina a 97-98 °C. Polls do Crate seguem com a janela oculta; a prévia monta 200 linhas e pede 200 capas; a entrada de tela anima o contêiner inteiro sobre o fundo; capas de 600 px servem miniaturas de 40 px.
- **Causa:** polls sem `document.hidden`; `.tdl-row` sem `content-visibility`; `.view` com `fade-in`; cache único em `cover.rs`.
- **Proposta:** `pollWhileVisible`; Tidal só com a aba ativa ou job em andamento; `content-visibility` e capa por `IntersectionObserver` na prévia; medir a entrada (se passar de 2 % de quadros lentos, só cabeçalho ou só opacidade); miniatura de 200 px no `cover.rs` (G).
- **Esforço:** P / M / G
- **Evidência:** `Crate.tsx:1793-1805`; `TidalTab.tsx:103-112, 567-584`; `extractor-lab.css:489, 496-499`; `cover.rs:4-24`.
- **Comandos:** OP, AD

### A50. Interface em inglês: o que o A24 de 26/10 não cobria
- **Tela:** Settings, Signal, Tweaks, barra, menu, fila, paleta, barra lateral, biblioteca, Playlists, S24.
- **Problema no uso:** o CL contou **396 textos** em inglês fora do A24 (Settings 63, Signal 75 + 57 itens de lista, Stations 49, Tweaks 37, biblioteca 33, Playlists 22, paleta 20, barra 19, fila 10, barra lateral 9, Home 8, Now Playing 8, menu 8, S24 34). O menu diz "Play Next" para uma faixa e "Tocar 3 a seguir" para várias. O Settings diz "2203 of 2203 tracks tem AI embeddings" e afirma que "light is the default Extractor Lab palette" (falso, e é outro produto). O S24 declara `lang="en"`: o TalkBack lê português com voz inglesa. Texto sem acento ("Voce esta na ultima").
- **Causa:** textos literais; `updateStatus` compara a string de tela; clima e atividade vêm do Rust como chave.
- **Proposta:** a troca do A24 ampliada, com o texto do CL; menu e SelectionBar com os mesmos verbos; `lib/moodLabels.ts` para os 38 termos com a chave intacta; `updateStatus` por código; Settings sem a frase falsa ("Tema do app"); S24 com `lang = "pt-BR"` em `mountMobile` e `BEAT_LABELS`. Termos de ofício do EQ ficam. Antes, o glossário (B31).
- **Esforço:** M (por telas) a G (tudo)
- **Evidência:** `Settings.tsx:255-631`; `Signal.tsx:219-706`; `Tweaks.tsx:450-640`; `TrackContextMenu.tsx:153-196`; `index.html:2` (conferido).
- **Comandos:** CL, AU, CR, DS, PL, MB, HD, OB, TY, BD

### A51. Código morto e `DESIGN.md` atrás do código
- **Tela:** nenhuma (manutenção).
- **Problema no uso:** nenhum direto; quem edita encontra duas versões de cada tela. 235 KB de JS legado em `src/js/` (só `resources.js` é importado); `src/index.html` com CDN do iconify e um `main.js` inexistente; `src/styles/tokens.css` órfão (Inter, Fraunces); `--purple-*` sem uso; sete classes mortas no desktop e quatro no S24. O `DESIGN.md` descreve o seek de 3 px, uma quebra de 1200 px que não faz nada, o Mover saindo em `--dur-med` e zoom 1,1, e não tem medidor, "+N", "1ª escuta", fila editável, SelectionBar, menu nem Tidal.
- **Proposta:** apagar o legado (o painel Recursos fica), `src/index.html`, `tokens.css`, `--purple-*`, as classes e a regra de 1200 px; atualizar `DESIGN.md` e o sidecar com o pós-leva.
- **Esforço:** P
- **Evidência:** `src/index.html:9, 16`, `Titlebar.tsx:20` (conferido); `extractor-lab.css:91, 844-867, 3576-3610, 3685`; `DESIGN.md:458, 466-472, 579-581`.
- **Comandos:** DS, TY, CO, PL, AD, AN, MB

### A52. S24: a Home não rola quando o dedo começa nos cards do topo
- **Tela:** S24, Home, "Quick start".
- **Problema no uso:** arrastar para cima a partir dos cards não sobe a página.
- **Causa:** `.qs-row { touch-action: pan-x }` só deixa rolar na horizontal.
- **Proposta:** tirar a linha (ou `pan-x pan-y`).
- **Esforço:** P
- **Evidência:** `src/mobile/styles/tokens.css:189` (conferido). Verificar no aparelho.
- **Comandos:** MB

### A53. S24: "Remover animações" não acalma o fundo (A16 de 26/10 pela metade)
- **Tela:** S24, todas, com a preferência ligada.
- **Problema no uso:** o fundo segue em velocidade cheia com o kick e o VU pula.
- **Causa:** `GlBg` sem `calm`/`reduced`; 2D sem a preferência; zero `matchMedia`; `.vu i` e o `scrollTo` suave fora do bloco.
- **Proposta:** `reducedMotion()` com ouvinte; `calmGlCfg`, `calm` e `reduced` no `GlBg` como o desktop; fator de calma no 2D; `.vu i { transition: none }`; `behavior: "auto"`; corrigir o comentário.
- **Esforço:** P
- **Evidência:** `app.css:1110-1121`, `GlBg.tsx` (conferido); `GlBackground.tsx:35-39, 102-104`.
- **Comandos:** MB

### A54. S24: o cinza `--t4` em texto e a letra inativa abaixo do piso
- **Tela:** S24: durações, tabbar inativa, rótulos, tags, placeholder, segmentado; letra.
- **Problema no uso:** o que se lê de relance some ao sol; letra antes e depois da atual a 2,09:1.
- **Causa:** `--t4` #6e6e6e (3,55 a 3,84:1); o #7c7c7c do A26 dá só 4,34:1 sobre `--s-c`; segmentado inativo 4,32:1; letra em `--t4` a 0,6.
- **Proposta:** em vez da troca de valor do A26: `--t4` só em glifo; texto em `--t3` (#808080, 4,58-4,95:1); segmentado inativo `--t2`; letra inativa `--t3` a 1 (5,16:1), ativa `--t1` 500.
- **Esforço:** P
- **Evidência:** `tokens.css:31-32` e `app.css:922-932` (conferido).
- **Comandos:** MB, CO

### A55. S24: desfoque de tela cheia fora do Now Playing; folha com vidro (B6 só no desktop)
- **Tela:** S24, telas de trabalho e folhas.
- **Problema no uso:** custo de GPU e bateria em toda tela de uso (no desktop o mesmo filtro deu 46,9 fps); a folha, 92 % opaca, desfoca o que quase não deixa ver.
- **Causa:** `blur(6px)` animado em 420 ms; `backdrop-filter: blur(8px)`; `GlBg` sem `mode`.
- **Proposta:** `mode` e `reduced` no `GlBg`, `data-engine="webgl"`, regras restritas ao 2D como no desktop; folha sem `backdrop-filter`, `rgba(12,12,12,.96)` em `--s-sheet`. O 2D segue B24.
- **Esforço:** M
- **Evidência:** `app.css:766, 802-805, 965-968` (conferido); `gl/host.ts:64-70`. Verificar: `dumpsys gfxinfo` antes e depois.
- **Comandos:** MB, OP

### A56. S24: o VU do mini player é sorteio
- **Tela:** S24, mini player.
- **Problema no uso:** barras pulam a cada 400 ms sem relação com o som, e o timer roda pausado.
- **Causa:** `setInterval` com `Math.random()`; `<For>` recria os `<i>`.
- **Proposta:** ler o `readFft()` no ouvinte `onFft` (sem timer novo), `transform: scaleY()` com `<Index>`, nada pausado. A decisão de 30/10 aplicada ao S24.
- **Esforço:** P
- **Evidência:** `mobile/components/Dock.tsx:43-54` (conferido); `MobileApp.tsx:105-119`.
- **Comandos:** MB, OP, AN (marcou B; reclassificado)

### A57. S24: a Fila depois de "Shuffle all" monta o acervo inteiro
- **Tela:** S24, Fila.
- **Problema no uso:** abre devagar e engasga na fila mais comum do celular.
- **Causa:** `<For>` direto; o próprio `ui.tsx:5-8` registra que 1,7 mil linhas travam o WebView.
- **Proposta:** `LazyList` com `chunk={60}` em "A seguir" e "Já tocadas".
- **Esforço:** P
- **Evidência:** `store.ts:354-359`; `Queue.tsx:120-129`.
- **Comandos:** MB

### A58. S24: gestos do mini e do Now Playing podem falhar, e o fechar briga com a letra
- **Tela:** S24, mini (subir) e Now Playing (descer), letra sem sincronia.
- **Problema no uso:** os gestos podem falhar em silêncio; o fechar pode disparar ao rolar a letra. Mecanismo provável, não confirmado.
- **Causa:** só `pointerup`, sem `pointercancel`; mini com `pan-y`; o `.np` inteiro escuta.
- **Proposta:** mini com `touch-action: none` e `onPointerCancel`; fechar só pela faixa de cima, letra fora. Pré-requisito do B22 de 26/10.
- **Esforço:** P
- **Evidência:** `Dock.tsx:67-82`; `NowPlaying.tsx:161-181`; `app.css:318`.
- **Comandos:** MB

### A59. S24: alvos de toque de 14 a 36 px (o que o A26 não cobria)
- **Tela:** S24: mini (tocar, próxima), engrenagem, "Ver todas", voltar, chips, segmentados, artista/álbum, excluir station.
- **Problema no uso:** o polegar erra; pausar no mini (36 px a 8 px da borda) é o gesto mais frequente.
- **Causa:** `.iconbtn` 36; `.iconbtn.sm` 30 (A26 aberto); `.chip` ~28; `.seg button` ~28; links sem padding.
- **Proposta:** `--tap-min: 44px`; botões de ícone 44 com margem negativa; chip com `::after`; segmentado 40; links com padding e margem negativa. Densidade igual.
- **Esforço:** M
- **Evidência:** `tokens.css:350-359`; `app.css:62-71, 666-691, 888-891` (conferido). Verificar: `smoke_mobile.py` com `getBoundingClientRect`.
- **Comandos:** MB

### A60. S24: curva Material, sem tokens de duração, letra em 600 ms, toque mudo (A22 e A23 pela metade)
- **Tela:** S24: Now Playing, letra, telas, tabbar, chips, cards.
- **Problema no uso:** a folha sobe e desce igual e parece arrastada; a letra desliza em 600 ms; tocar não responde até a tela mudar.
- **Causa:** `--ease` Material; nenhum `--dur-*`; tap highlight desligado e `:active` em 4 classes.
- **Proposta:** os tokens do desktop em `tokens.css` (`--ease-out`, `--ease-in`, `--dur-base/med/enter/screen/press`); `.np` sobe em `--dur-screen` e desce em `--dur-med`; letra em `--dur-screen`; `:active` com `scale(.96)` em tab e chip e `.985` em cards, transporte fora.
- **Esforço:** P
- **Evidência:** `tokens.css:50, 88`, `app.css:919` (conferido).
- **Comandos:** AN, MB

### A61. S24: folha, aviso e letra aparecem num corte; a troca de faixa corta título e capa
- **Tela:** S24: folhas, toast, Now Playing, mini.
- **Problema no uso:** folha e escurecimento sem transição (o defeito corrigido no desktop em 27/10); o aviso pisca; a letra surge enquanto a capa encolhe; na troca, título e capa estalam.
- **Causa:** `display: none → block`; toast nasce com `data-on` (o CSS de transição é morto); `<Show>` sem entrada; mesmo `<img>` com `src` trocado.
- **Proposta:** folha pelo padrão da paleta; toast por keyframe de entrada; letra com `state-in` após `--dur-base`; `createSwapKey` com `swap-rise` de 3 px fora de rajada e capa a 0 até `onLoad`. Calma: só opacidade.
- **Esforço:** M
- **Evidência:** `app.css:560-580, 900-903, 949-977`; `ui.tsx:113-117`; `Cover.tsx:44`.
- **Comandos:** AN

### A62. S24: busca com o teclado aberto
- **Tela:** S24, Buscar.
- **Problema no uso:** "Enter" em vez de lupa, sem "x" para limpar, rodapé de ~115 px entre lista e teclado.
- **Causa:** `<input>` sem `type="search"` nem `enterkeyhint`.
- **Proposta:** `type="search"`, `enterkeyhint="search"`, `aria-label`; limpar de 44 px; `.device:has(.searchfield input:focus) .dock { display: none }`.
- **Esforço:** P
- **Evidência:** `Search.tsx:89-102`; `tokens.css:108`.
- **Comandos:** MB

### A63. S24: textos de 8,5 a 10,5 px sem tokens; os 13 advisories
- **Tela:** S24: tabbar, selo de origem, eyebrows, tags, rótulos, tempos do seek.
- **Problema no uso:** o que se lê andando está abaixo do piso de 11, com a pinça desligada.
- **Causa:** literais, nenhum `--fs-*`. Dos 13 advisories: 1 CSS morto, 1 texto abaixo do piso, 6 raios de pílula à mão, 1 raio de 16 px, 2 papéis reais não documentados (17 e 19 px).
- **Proposta:** `--fs-label` 11, `--fs-meta` 11,5, `--fs-body` 13,5, `--fs-lead` 17, `--fs-stat` 19, `--fs-title` 23, `--fs-display` 28; raios em `--r-pill`/`--r-2xl`; `DESIGN.md` ganha `s24-lead` e `s24-stat`.
- **Esforço:** M
- **Evidência:** `tokens.css:144-216, 385`; `app.css:110, 144, 458, 735, 971, 1010`; `detect-src.json`.
- **Comandos:** MB, detector

### A64. S24: vazios sem a ação, Stations sem carregando nem erro, linha faltante sem estilo
- **Tela:** S24: Now Playing e mini vazios, acervo vazio, Fila vazia, Stations, faixa fora do aparelho, selo de origem.
- **Problema no uso:** o desktop ganhou "Continuar" e "Aleatório" (A20 de 26/10); o celular diz "Nada tocando" e para. A Home vazia manda "use Re-scan em Settings" sem o botão. A Stations manda rodar o export "no desktop" (roda na VM) e diz "re-rank local". "Faixa fora do acervo" sai como texto solto. "playlist" aparece em verde, a cor de ok.
- **Causa:** `Empty` sem ações; `loadIntel` engole o erro; `MissingRow` com classes do desktop; `--ok` como cor de origem.
- **Proposta:** `Empty` com ações de 44 px ([Continuar <última>], [Tudo em aleatório], [Reescanear]); `stationsReady/Error` com `Empty`/`LoadError`; "Nenhuma station neste aparelho. Elas vêm do desktop na próxima sincronização."; `MissingRow` como `.trk`; "playlist" em `--t3`.
- **Esforço:** P a M
- **Evidência:** `mobile/components/NowPlaying.tsx:237-243`; `screens/Home.tsx:46-54`; `Stations.tsx:27-70`; `Queue.tsx:32-41`; `app.css:466-474`.
- **Comandos:** OB, MB, CO

## B. Decisão do CEO

Mudam comportamento, criam recurso ou superfície, removem algo que você usa, mudam a aparência de forma marcante ou mexem em contrato IPC com efeito no produto. Ordem: impacto vezes custo.

### B1. Clicar num álbum da grade abre o álbum
- **Tela / problema:** Library > Álbuns; clicar toca e troca a fila, e não há caminho para a página do álbum (no Artista, o mesmo card abre).
- **Proposta:** o card abre (com o artista, A19); só o play do hover toca.
- **Trade-off:** coerência e acesso à página, contra um toque a mais para quem usa a grade como jukebox.
- **Esforço:** P · **Evidência:** `Albums.tsx:36` (conferido) · **Comandos:** CR, PL, OD
- **Recomendação:** sim.

### B2. Um cabeçalho só para Álbum, Artista e Playlist
- **Tela / problema:** capa de 120 px no Álbum (menor que o mosaico de 180 da Playlist), cassete redondo no Artista, títulos de 22 e 28 px, ações em ordens diferentes.
- **Proposta:** o hero da Playlist nas três: capa 160-180 px (redonda no Artista, com a capa do álbum com mais faixas ou mosaico), kicker, título Feature, estatística, "Tocar" à direita; `DESIGN.md` estende o Feature.
- **Trade-off:** mesma gramática e capa com o peso da página, contra ~60 px a mais de cabeçalho.
- **Esforço:** M · **Evidência:** `Album.tsx:58-102`, `Artist.tsx:43-66`, `Playlist.tsx:84-146` · **Comandos:** BD, CR, LY, PL, DL, OD
- **Recomendação:** sim, com protótipo, junto do B2 de 26/10 (capa do Now Playing).

### B3. Artistas: rosto e filtro
- **Tela / problema:** centenas de cartões com o mesmo cassete; Álbuns e Artistas sem filtro.
- **Proposta:** `lib_list_artists` devolve `cover_path` (álbum com mais faixas); filtro do `.coll-toolbar` nas duas grades. Alternativa do CR: Artistas como lista densa focável.
- **Trade-off:** grade reconhecível, contra mudar o contrato (o S24 ignora o campo) e uma regra de capa que pode errar (inofensivo).
- **Esforço:** M · **Evidência:** `Artists.tsx:21-38`; `query.rs:248-293` · **Comandos:** BD, CR, DL, LY
- **Recomendação:** capa por artista e filtro.

### B4. Desfazer no lugar de apagar sem volta
- **Tela / problema:** "Clear" descarta a fila inteira (e passa por fora do `mutateQueueRealign`); tirar não volta; desfazer um Mover é refazer à mão; "Redefinir tudo" zera ajustes calibrados sem confirmar; apagar preset usa `confirm` nativo.
- **Proposta:** "Fila limpa · Desfazer" e "Tirou X · Desfazer" por 6 s no lugar do "+N"; "Desfazer" no resultado do Mover; "arma e confirma" do `DeleteStationButton` em "Redefinir tudo" e "Apagar preset".
- **Trade-off:** ações reversíveis, contra uma superfície transitória nova.
- **Esforço:** M · **Evidência:** `QueueDrawer.tsx:198-212`; `Tweaks.tsx:652`; `Signal.tsx:119-153` · **Comandos:** CR, HD, CL, DS
- **Recomendação:** sim.

### B5. Aviso de falha no desktop
- **Tela / problema:** tocar que falha troca título e capa e fica mudo; curtir, embaralhar e stations falham só no console.
- **Proposta:** `showNotice` curto na barra (o S24 já tem `showToast`): "Não consegui tocar esta faixa. O arquivo pode ter sido movido; reescaneie a biblioteca."
- **Trade-off:** o clique que falha explica, contra um componente novo que não pode tapar a barra.
- **Esforço:** M · **Evidência:** `PlayerBar.tsx:495, 1090-1092`; `Stations.tsx:495-527` · **Comandos:** CL, CR
- **Recomendação:** sim, começando por "não consegui tocar".

### B6. Uma fila de downloads só no Crate
- **Tela / problema:** a fila da Tidal mora embaixo do campo, some durante a busca, e "Ver a fila" apaga a busca; contagens das abas não significam o mesmo.
- **Proposta:** jobs da Tidal na aba Fila com "Reenviar"; contagem = em andamento.
- **Trade-off:** um lugar para vigiar, contra mudar a aba Tidal que você usa desde 13/10.
- **Esforço:** M · **Evidência:** `TidalTab.tsx:740-746, 945-1033`; `Crate.tsx:1852-1868` · **Comandos:** CR
- **Recomendação:** unificar.

### B7. Um seletor de pasta em todo o Crate
- **Tela / problema:** chip com popover no Buscar, `<select>` com "outra pasta..." na Tidal, lista no Mover, cada um com sua memória e sua lista.
- **Proposta:** `FolderPicker` com o comportamento do Mover, aberto por chip; pastas locais e da VM; uma memória.
- **Trade-off:** um gesto só, contra trocar o controle da Tidal.
- **Esforço:** M · **Evidência:** `Crate.tsx:385-438`; `TidalTab.tsx:278-327` · **Comandos:** CR, LY
- **Recomendação:** sim.

### B8. Curtidas com tela
- **Tela / problema:** o gesto de maior peso no motor não tem onde ser visto; `libListLiked` existe e ninguém chama.
- **Proposta:** aba "Curtidas" na Library, por `liked_at`, com "Tocar curtidas" (rádio semeado).
- **Trade-off:** uma aba nova, contra o gesto mais importante sem retorno.
- **Esforço:** P · **Evidência:** `tauri.ts:265`; `Library.tsx:14` · **Comandos:** DL
- **Recomendação:** sim.

### B9. "Fora do rádio" e recusa com escopo
- **Tela / problema:** após 3 pulos cedo, a faixa sai do rádio para sempre e a tela nunca diz; não existe "fora desta station" nem "nunca no rádio".
- **Proposta:** lista "Fora do rádio" só de leitura (`lib_motor_excluded`); depois "Devolver", "Nunca no rádio" e "Fora desta station" com desfazer.
- **Trade-off:** transparência e controle, contra estado novo que autoplay, stations e S24 precisam respeitar.
- **Esforço:** M (lista) / G (escopos) · **Evidência:** `desktop.rs:506-525, 1904-1918`; `familiarity.rs:20-24` · **Comandos:** DL
- **Recomendação:** sim, começando pela lista.

### B10. O motor explica a escolha na tela
- **Tela / problema:** o motivo do rádio mora num `title` de 11 px; a próxima do rádio na gaveta parece qualquer outra; a ficha do Now Playing não diz quantas vezes a faixa terminou.
- **Proposta:** linha de 11 px sob a próxima do rádio ("descoberta · nunca ouvida até o fim"); a frase visível no Now Playing; "Ouvida até o fim 9 vezes · curtida" na ficha, só com dado.
- **Trade-off:** o Princípio 3 visível, contra uma linha a mais na gaveta e na ficha.
- **Esforço:** P · **Evidência:** `QueueDrawer.tsx:222-224`; `NowPlaying.tsx:576-603` · **Comandos:** DL
- **Recomendação:** sim.

### B11. Qualidade conferida e escuta onde se navega
- **Tela / problema:** a auditoria espectral só aparece na faixa que toca; a Home mostra "embedded".
- **Proposta:** resumo no Álbum calculado no cliente ("12 faixas · 10 conferidas, 2 com corte em 16,1 kHz"); depois `lib_listen_stats` (nunca o `play_count` fóssil); Home com "conferidas · com corte · sem medir".
- **Trade-off:** a razão de ser do acervo visível, contra texto e contagens novas. Não toca o selo da capa (CMR-297).
- **Esforço:** P / M · **Evidência:** `Album.tsx:72-79`; `Home.tsx:100-102`; `query.rs:585-588` · **Comandos:** DL
- **Recomendação:** sim, começando pela qualidade no Álbum.

### B12. A Home reflete a escuta e as chegadas
- **Tela / problema:** a Home busca recomendações e usa uma; a prateleira "Albums" é alfabética e fixa; o ponto de chegada some ao fechar e não vale para Tidal, Bandcamp nem cópia manual.
- **Proposta:** prateleira "Mais ouvidos"; `order: "recent"` em `lib_list_tracks` e "Chegou esta semana" por `indexed_at`, com marca persistida.
- **Trade-off:** Home pessoal, contra trocar a grade e um parâmetro novo de IPC.
- **Esforço:** M · **Evidência:** `Home.tsx:29-53`; `store/crate.ts:40-57`; `pipeline.rs:867` · **Comandos:** DL
- **Recomendação:** sim (A17 cobre a Tidal na barra lateral sem esperar).

### B13. Histórico por dia
- **Tela / problema:** lê-se dia a dia linha a linha; não se vê quantas vezes tocou.
- **Proposta:** separadores "Hoje · 14 faixas", hora na coluna, "tocada 7 vezes".
- **Trade-off:** leitura por dia, contra mudar a cara da lista.
- **Esforço:** P · **Evidência:** `History.tsx:29-52`; `query.rs:524-530` · **Comandos:** DL
- **Recomendação:** sim.

### B14. O desktop mostra quando o S24 sincronizou
- **Tela / problema:** nada confirma o sync; falhas passam despercebidas.
- **Proposta:** evento `sync-received`; "S24 sincronizou há 3 min: 14 plays, 2 curtidas", âmbar após 24 h.
- **Trade-off:** canal visível, contra um evento novo.
- **Esforço:** M · **Evidência:** `sync_receiver.rs` (sem `emit`) · **Comandos:** DL
- **Recomendação:** sim, só a primeira camada.

### B15. O S24 diz se o original é limpo
- **Tela / problema:** o celular toca Opus sem saber da auditoria.
- **Proposta:** manifest com `quality_class`; "Opus 192 · original FLAC conferido".
- **Trade-off:** a promessa chega ao aparelho, contra campo novo no manifest.
- **Esforço:** M · **Evidência:** `export_manifest.py`; `mobile/types.ts:12-34` · **Comandos:** DL
- **Recomendação:** sim, numa leva do APK.

### B16. Barra: sem selo "álbum" e botão de letra só no Now Playing
- **Tela / problema:** "ÁLBUM" em cada faixa de um disco (~60 px da linha do artista); o botão de letra fica em toda tela e só age no Now Playing.
- **Proposta:** sem selo em `album`; letra só em `/now-playing` (libera 36 px).
- **Trade-off:** respiro, contra perder a confirmação "estou num álbum" e o ajuste prévio da letra.
- **Esforço:** P · **Evidência:** `PlayerBar.tsx:590-600, 783-791` · **Comandos:** DS, QT
- **Recomendação:** sim.

### B17. Tweaks: o Fundo primeiro e atalhos para as seções
- **Tela / problema:** 26 controles em 7 seções num rolo de ~2.000 px (estimado); o Fundo é a quarta seção e o app tem dois atalhos de rolagem duplicados para chegar nele.
- **Proposta:** reordenar (Fundo, Áudio, Aparência, Remoto) e âncoras no cabeçalho. Alternativa do DS: grupos recolhíveis.
- **Trade-off:** âncoras não escondem nada (Princípio 5), contra acordeões que encurtam mais.
- **Esforço:** M · **Evidência:** `Tweaks.tsx:304-315, 449-660`; `NowPlaying.tsx:90-98` · **Comandos:** DS, LY
- **Recomendação:** reordenar e âncoras.

### B18. Tweaks: a cor do fundo num seletor
- **Tela / problema:** Bg ink, Adaptive ink, Ink cycle e a dica decidem uma coisa com precedência escondida.
- **Proposta:** "Cor do fundo": Da capa, alterna / Da capa, fixa / Do tema / Manual, sem mudar schema.
- **Trade-off:** precedência visível, contra regravar um gesto memorizado.
- **Esforço:** M · **Evidência:** `Tweaks.tsx:501-536` · **Comandos:** DS
- **Recomendação:** sim.

### B19. Tweaks: variantes do Relevo e a Nébula
- **Tela / problema:** três eixos "em avaliação" só para o Relevo; a Nébula custa 46-48 ms por quadro a 1857 x 1048 e reprova o próprio "Medir cenas".
- **Proposta:** fixar o Relevo que você usa; Nébula marcada "fora do critério".
- **Trade-off:** seletor enxuto, contra perder a comparação do seu fundo favorito.
- **Esforço:** M / P · **Evidência:** `Tweaks.tsx:231-300`; `gl/meta.ts:140-200` · **Comandos:** DS
- **Recomendação:** perguntar qual Relevo fica.

### B20. Settings só com o que é dela
- **Tela / problema:** quatro controles repetem o Tweaks e a barra (o hint diz "−14 LUFS" fixo); ~12 linhas de texto de desenvolvedor (qdrant, Identifier, License).
- **Proposta:** Tema, Retomar, Biblioteca (uma linha + Reescanear) e Atualização; ponte para o Tweaks; resto num "Diagnóstico" fechado.
- **Trade-off:** uma fonte por controle, contra o hábito de achar na Settings.
- **Esforço:** P · **Evidência:** `Settings.tsx:362-461, 478-543, 612-640` · **Comandos:** DS, CL
- **Recomendação:** sim.

### B21. Signal: menos repetição e a curva do EQ como destaque
- **Tela / problema:** estado dito em cinco lugares; a curva viva tem 180 px e vira faixa de 8:1 na tela larga; o Limiter mostra 16 controles.
- **Proposta:** sai o fluxo de nós fixos e os badges; os cartões viram a linha de estado; curva a 260 px; `.sig { max-width: 1180px }`; "Avançado" recolhido por painel.
- **Trade-off:** a tela diz onde olhar, contra tirar o diagrama-conceito e um clique a mais no ajuste fino.
- **Esforço:** M · **Evidência:** `Signal.tsx:221-308, 425-580`; `extractor-lab.css:2519-2564` · **Comandos:** DS, BD, AD
- **Recomendação:** cartões e curva sim; "Avançado" depois de ver o que você não toca.

### B22. Signal: antes e depois no mesmo quadro
- **Tela / problema:** espectro e curva em eixos diferentes; o efeito do EQ fica na cabeça.
- **Proposta:** traço "origem (estimada)" por barra; medidor L/R no nó final com entalhe do limiter; rótulo honesto.
- **Trade-off:** instrumento, contra estimativa que erra com limiter e Bass.
- **Esforço:** M · **Evidência:** `EqCanvas.tsx:231-258, 375-418` · **Comandos:** OD
- **Recomendação:** sim, começando pelo traço.

### B23. Reflow da barra e do Crate para janela menor (B17 de 26/10, com fato novo)
- **Tela / problema:** com o medidor, a direita da barra precisa de ~1.450 px; na janela padrão (1280 x 800) ou no notebook, a pílula quebra e o artista some; a linha do Crate exige 992 px e a vista ganha rolagem horizontal.
- **Proposta:** container queries pela largura da barra (medidor sai abaixo de 1.500, pílula curta abaixo de 1.300, volume 72 px abaixo de 1.100); `.pb-left` corta o selo antes do artista; colunas do Crate com `minmax`.
- **Trade-off:** aguenta outra janela, contra regras que só valem se você redimensiona.
- **Esforço:** M · **Evidência:** `extractor-lab.css:1344, 4425-4437`; `tauri.conf.json` · **Comandos:** AD, LY
- **Recomendação:** depende da pergunta 11.

### B24. Fundo 2D no ambient sem filtro de tela cheia
- **Tela / problema:** o 2D (padrão de fábrica) segue com `blur(8px)` sobre o canvas e blur animado por 420 ms. Não medido.
- **Proposta:** medir; se estourar, o 2D desenha a 1/4 com ganho e saturação no desenho.
- **Trade-off:** sem custo por quadro, contra desfoque não gaussiano.
- **Esforço:** M · **Evidência:** `store/tweaks.ts:169`; `extractor-lab.css:289-311` (conferido) · **Comandos:** OP
- **Recomendação:** medir; se você não usa o 2D, só documentar.

### B25. Acento da capa derivado em OKLCH
- **Tela / problema:** L de 0,56 a 0,85 e croma de 0,12 a 0,26 conforme a capa; a interface acende ou apaga com o disco.
- **Proposta:** croma `clamp(C × 1,25, 0,07, 0,17)` e L em OKLCH até o alvo de A6; os cinco usos de HSL migram.
- **Trade-off:** acento quieto, contra perder a pancada das capas saturadas.
- **Esforço:** M · **Evidência:** `inkDerive.ts:46-70`; `color.ts:85-104` · **Comandos:** CO
- **Recomendação:** sim, depois de A6, com antes e depois em 6 capas.

### B26. Semáforo da barra de título neutro em repouso
- **Tela / problema:** três pontos de croma pleno fixos, sempre à vista.
- **Proposta:** `--fg-7` em repouso, cor só com o ponteiro no grupo.
- **Trade-off:** moldura quieta, contra o reflexo do semáforo.
- **Esforço:** P · **Evidência:** `Titlebar.tsx:23-27` · **Comandos:** CO
- **Recomendação:** sim.

### B27. Tidal: seleção em massa, lotes acima de 200, cartaz; artista com foto
- **Tela / problema:** tirar 30 do meio são 30 cliques; mix de 500 manda 200 e volta à busca; prévia de álbum repete a capa em 12 linhas; artista com foto de 40 px (o `Cover` aceita `size="lg"`, sem CSS).
- **Proposta:** arrastar pela coluna da caixa e Shift+clique; prévia aberta com "Marcar as próximas 200"; capa de 120 px no cabeçalho do álbum; foto de 120 px e nome de 22 px no artista.
- **Trade-off:** fluxo real da aba, contra gestos novos e cabeçalhos mais altos.
- **Esforço:** M · **Evidência:** `TidalTab.tsx:103-115, 349-372, 429-600, 772` · **Comandos:** OD, HD, BD
- **Recomendação:** sim; leque e mapa depois.

### B28. Crate: busca preservada e atalho para a Tidal
- **Tela / problema:** sair do Crate perde uma busca de 25 s (gasta outra das 40 por hora); "Nada encontrado" no Soulseek obriga a refazer na Tidal.
- **Proposta:** busca em `store/crate.ts` por 10 min com "resultado de há N min"; [Buscar “X” na Tidal].
- **Trade-off:** menos buscas gastas, contra resultados velhos.
- **Esforço:** M · **Evidência:** `Crate.tsx:1256-1330, 1822, 2146-2155` · **Comandos:** HD, OB
- **Recomendação:** sim.

### B29. A chegada de um download com etapas
- **Tela / problema:** só o download tem barra; organizar e indexar não andam; o veredito pula para a linha.
- **Proposta:** trilho de 4 trechos, destaque corredio só nas etapas sem porcentagem, capa e veredito por opacidade no pronto.
- **Trade-off:** você vê a etapa que demora, contra mais movimento numa lista aberta.
- **Esforço:** M · **Evidência:** `Crate.tsx:339-358, 479-520` · **Comandos:** OD, AN
- **Recomendação:** sim.

### B30. A capa voa até o álbum; a fila anda (B11 de 26/10)
- **Tela / problema:** a capa some com a vista, "Loading…" na primeira abertura, e a página busca o acervo inteiro de álbuns para achar um; na gaveta, as linhas saltam na troca.
- **Proposta:** clone da capa por WAAPI até o cabeçalho (~320 ms); clique passa o `Album` e pré-carrega o chunk; a fila sobe em 240 ms, corte em rajada.
- **Trade-off:** momento autoral, contra mais um ajudante de animação.
- **Esforço:** M · **Evidência:** `Album.tsx:22-63`; `router.tsx:81`; `QueueDrawer.tsx:45-66` · **Comandos:** OD
- **Recomendação:** junto do B11 de 26/10; se recusado, só a parte de dados.

### B31. Vocabulário: glossário antes da troca em lote
- **Tela / problema:** "Library"/"biblioteca"/"acervo"; "Queue"/"fila"; "Play Next"/"Tocar a seguir"; "Não deu pra"/"Não foi possível"; "renderer", "shape", "peer", "token".
- **Proposta:** Biblioteca = área, acervo = arquivos; Fila; faixa; "Continuar"; "Não consegui…"; "Início"; "estilo" e "forma"; "origem" para peer; "chave de acesso".
- **Trade-off:** uma troca em lote só, contra decidir nomes de hábito agora.
- **Esforço:** P · **Evidência:** `Sidebar.tsx:31`; `TrackContextMenu.tsx:161-164`; `SelectionBar.tsx:66-69` · **Comandos:** CL
- **Recomendação:** aprovar antes de A50.

### B32. Reforma tipográfica e de botões (B20 de 26/10, com números de hoje)
- **Tela / problema:** de 227 para 231 `font-size`, de 61 para 45 abaixo de 11 px; nove degraus entre 9,5 e 13,5 vivos; título de item em quatro tamanhos; nenhuma tela com três tamanhos e dois pesos; botões em oito famílias.
- **Proposta:** recorte primeiro (títulos 13,5 e 12,5; pílula 11/600; mono 11/500; botões `--sm`/padrão/`--lg`); compensação de escuro só com A/B em captura.
- **Trade-off:** escala de verdade, contra rótulos visivelmente maiores e risco em pílulas de altura fixa.
- **Esforço:** M / G · **Evidência:** contagens do TY · **Comandos:** TY, PL, AU, CR
- **Recomendação:** leva própria depois de A45 e A50.

### B33. Aba Gêneros e o teto de chips
- **Tela / problema:** a aba repete a Playlists sem ação; chips sem teto (tags sujas).
- **Proposta:** a aba sai ou cada linha abre a playlist; N chips + "mais".
- **Trade-off:** menos duplicação, contra um caminho que talvez você use.
- **Esforço:** P a M · **Evidência:** `Library.tsx:83-107` · **Comandos:** CR, LY
- **Recomendação:** linhas que abrem a playlist; medir os chips antes.

### B34. S24: Curtir ao alcance do polegar
- **Tela / problema:** Curtir, a ação mais frequente do Now Playing, está no canto mais difícil.
- **Proposta:** Curtir à direita do título, alvo de 44 px.
- **Trade-off:** alcance, contra mudar o handoff.
- **Esforço:** M · **Evidência:** `mobile/components/NowPlaying.tsx:192-232` · **Comandos:** MB
- **Recomendação:** sim, com protótipo no aparelho.

### B35. Play sem faixa retoma a última
- **Tela / problema:** depois de A15, Play sem faixa não faz nada, enquanto o Now Playing oferece "Continuar".
- **Proposta:** o "Continuar" do A20 de 26/10; sem histórico, aleatório; vazio avisa.
- **Trade-off:** gesto natural, contra o Play escolher o que tocar.
- **Esforço:** P · **Evidência:** `PlayerBar.tsx:664-680`; `lib/quickPlay.ts:12-15` · **Comandos:** OB
- **Recomendação:** sim.

## C. Descartado

| Proposta | Comando | Motivo |
|---|---|---|
| Remover o medidor VU/pico da barra | DS | Pedido seu em 30/10 (Princípio 5). |
| Espalhar ou cortar os knobs do Tweaks | DS | Decisão registrada: Tweaks é o hub. |
| Esconder a pílula de qualidade | DS | Contraria CMR-297 e o A19 de 26/10. |
| Cortar o botão "Mais" da barra | DS | Único caminho por clique esquerdo. |
| Tirar o "Redefinir tudo" | DS | Fora do distill; a confirmação está em B4. |
| Mais croma nos sinais | CO | B16 recusado; A22 mexe só em brilho. |
| Preencher o progresso no acento | CO, QT | B15 recusado (carbono 3). |
| Fundo das telas de trabalho mais escuro | QT | B14 recusado; A27 resolve com vidro. |
| Card de letra com `--glass-tint` | CO | Vidro fumê independente do tema por desenho. |
| Zonas coloridas no VU | CO | "Controles que medem em vez de enfeitar". |
| Cadeia DSP como destaque do Signal | BD | Sem dado por estágio; feita assim, enganaria. Volta se o motor expuser nível por estágio. |
| Cena WebGL nova, partículas, textura | OD | Reprovado por você (moiré, retícula, fitas, Nébula borrada) e orçamento de 58 fps. |
| Ponte conectada, ponto de chegada, faixa de busca da Tidal, anel do cooldown, "+N", pulso do like | QT, AN | Sinais funcionais ou de segurança, curtos, com versão calma; ADR 002, B8 e B9 já feitos. |
| Tour, boas-vindas, dica de recurso novo, explicação do "1ª escuta" | OB | Dono único e experiente; proibido no brief. |
| Confete, horas ouvidas, streak | DL | Genérico; soma de duração conta pulo como faixa inteira. |
| Caixa-alta nos rótulos do Tweaks | TY | `DESIGN.md` (Label: rótulo de knob 11/600). |
| "Tweaks com `vh` dividido pelo zoom" (parte do B17 de 26/10) | AD | Premissa contrariada por `capture-1792970910645.png` (26/10): com zoom ≠ 1 a barra aparece inteira. Fecha com `innerHeight` na tela. |
| Reativar a pinça no S24 | MB | Desmonta o layout de tela única; A63 resolve o motivo. |
| Paisagem e áreas seguras laterais no S24 | MB | B22 de 26/10: paisagem não. |
| "on/off" do Continuar tocando como switch | MB | Decisão do plano de paridade de 15/08. |
| `--err` do S24 para #9c8484 (parte do A26) | MB | Token sem uso no S24. |
| Folha do Now Playing segue o dedo | MB (cita) | Duplica 26/10 B22, ainda aberto; A58 é o pré-requisito. |
| A2, A12 e A20 de 26/10 | HD, OB | Já feitos e conferidos. |
| A1, A16 (desktop) e A19 de 26/10 | AU | Já feitos; o resíduo da pílula está em A4. |

## O que não foi avaliado e como fechar

| Lacuna | Como fechar |
|---|---|
| Nenhuma tela renderizada; capturas só de 0.2.96, sem biblioteca, fila, Tweaks, Settings, Signal, Mover, menu nem S24 | `app_eval.sh capture` e `detect` por rota, com o app ocioso e o seu "pode" escrito. |
| Larguras da barra (A2, A3, B23): estimativas divergem (artista com 36 a 115 px; direita com 387 a 467 px) | `getBoundingClientRect` de `.pb-artist`, `.pb-src`, `.pb-right` com faixa lossy e EQ, LIM, BASS; ou uma captura sua. |
| Contraste sobre fundo e capa: Crate (A27), letra do S24 (A54), acento (A6), seleção (A23) | Recortes de capturas novas, pior ponto com a Tinta rosa e três capas. |
| Desempenho: aba Faixas (A39), entrada de tela (A49), 2D no ambient (B24), medidor somado ao fundo (critério de 58 fps não remedido), curva a 260 px (B21), voo da capa (B30) | fps do Tweaks a 1857 x 1048 com a máquina ociosa; inspetor numa rodada autorizada; `gl-bench` só cobre a GPU. |
| Runtime: comandos síncronos e eventos fora de ordem (A40), segurar Delete (A8), arrastar com troca de faixa (A28) | Testes de unidade simulando eventos e avanço; fps do Tweaks com o Qdrant ocupado. |
| S24 no aparelho: gestos (A58), alvos (A59), teclado (A62), áreas seguras com edge-to-edge, fundo e folha (A55), TalkBack | `adb forward` + `impeccable detect --cdp` (não testado); `smoke_mobile.py`; `dumpsys gfxinfo`; aparelho desbloqueado e app em primeiro plano. |
| Reduzir animação no WebKitGTK (herdado de 26/10) | Ligar no GNOME e ler `matchMedia` pela ponte. |
| Contagens por script que não refiz: 396 textos (A50), 54 regras sem `tabular-nums` (A43), 85 espaçamentos (A48), probes de cor (A6, A22, B25) | Rodar os scripts do scratchpad de novo antes da leva que os usa. |

## Perguntas para o CEO

1. Clicar no card da grade de Álbuns passa a abrir o álbum, e só o play do hover toca? *Recomendo sim (B1).*
2. Um cabeçalho só para Álbum, Artista e Playlist, num protótipo junto da capa maior do Now Playing? *Recomendo sim (B2).*
3. Cada artista ganha a capa do álbum dele com mais faixas, e Álbuns e Artistas ganham filtro? *Recomendo sim (B3).*
4. "Limpar a fila", tirar e Mover ganham "Desfazer" por 6 s, e "Redefinir tudo" pede segundo clique? *Recomendo sim (B4).*
5. A fila da Tidal vai para a aba Fila do Crate? *Recomendo sim (B6).*
6. Uma aba de Curtidas e uma lista das faixas que o motor tirou do rádio? *Recomendo sim, a segunda primeiro só de leitura (B8, B9).*
7. Sem selo "ÁLBUM" na barra, e botão de letra só no Now Playing? *Recomendo sim (B16).*
8. Tweaks com o Fundo primeiro e atalhos para as seções, sem esconder nada? E qual Relevo fica? *Recomendo as âncoras (B17, B19).*
9. Settings sem os quatro controles repetidos, com o texto técnico num "Diagnóstico" fechado? *Recomendo sim (B20).*
10. Glossário: "Biblioteca", "acervo", "Início", "Não consegui…"? *Recomendo aprovar antes da troca em lote (B31).*
11. Você redimensiona o Rustify, ou ele fica sempre no monitor externo? *Se fica, B23 sai da lista.*

## Plano sugerido

Por arquivo, para tocar cada um uma vez por leva. Cada leva fecha com `npm run typecheck`, os testes das telas tocadas, `cargo check` quando houver Rust, bump antes do `release.sh`, `dpkg -i` na cmr-auto e captura antes e depois pela ponte (com o seu "pode").

### Leva 1 (desktop): o que se sente todo dia, só A de esforço P/M

`extractor-lab.css` (A1-A4, A8-A12), `PlayerBar.tsx` (A2-A4), `Sidebar.tsx` (A5), `lib/inkDerive.ts` + `lib/color.ts` (A6), `EmptyState.tsx` novo + `router.tsx` + views da biblioteca (A7), `QueueDrawer.tsx` (A8, A9), `Crate.tsx` (A10, A11), `NowPlaying.tsx` + `Stations.tsx` (A12); fecha com `DESIGN.md` e sidecar (papéis do âmbar, selo único, trilho em `--fg-7`).

### Leva 2 (desktop): barra, biblioteca e Crate

- `PlayerBar.tsx`, `store/player.ts`, `store/lyrics.ts` (novo): A13, A14, A15, A24.
- `crate/TidalTab.tsx`, `store/crate.ts`, `Sidebar.tsx`: A16, A17.
- `Artists.tsx`, `Artist.tsx`, `Albums.tsx`, `Album.tsx`, `Library.tsx`, `Tracks.tsx`, `TrackRowTable.tsx`: A18-A21.
- Tema really-dark (`theme-maker`, fora do repo) e `validate.py`: A22. `extractor-lab.css` e `store/tweaks.ts`: A23.
- `Crate.tsx`, `coordinator.rs`, `tidal_fila.rs`: A25, A26, A27.

### Leva 3 (desktop): fila, painéis, teclado

- `QueueDrawer.tsx`: A28, A29. `Tweaks.tsx`: A30, A33. `Settings.tsx`: A31. `Signal.tsx` + `store/dsp.ts`: A32.
- `MoveToPlaylistDialog.tsx`, `TrackContextMenu.tsx`, `store/contextMenu.ts`, `lib/focusReturn.ts` (novo): A34, A35; abas: A36.
- `desktop.rs` + `tauri.ts`: A40.

### Leva 4 (desktop): tipografia, movimento, tokens, texto

- A37, A38, A39 (depois de medir), A41-A49 (miniaturas de A49 à parte).
- A50 depois do glossário (B31), com os testes que casam texto. A51 fecha a leva.

### Leva S24 (APK)

A52, A53, A54, A56, A57, A58, A55 (com `dumpsys gfxinfo` antes e depois), A59, A60, A61, A62, A63, A64, mais o S24 de A6, A33 e A50 (`lang`). Arquivos: `src/mobile/styles/tokens.css` e `app.css`, `bg/GlBg.tsx`, `components/Dock.tsx`, `components/NowPlaying.tsx`, `screens/Queue.tsx`, `screens/Search.tsx`, `screens/Stations.tsx`, `store.ts`, `MobileApp.tsx`. `.deb` antes do APK quando o contrato mudar; `smoke_mobile.py` com o aparelho desbloqueado.

### Espera resposta

Recomendação de sim: B1-B16, B18, B20, B22, B26-B29, B31, B34, B35. Medir antes: B21, B24, B30. Decisão de forma: B17, B19, B23, B25, B33. Leva própria: B32. De 26/10 seguem esperando B2, B11, B12, B17 (agora B23), B20 (agora B32) e B22.
