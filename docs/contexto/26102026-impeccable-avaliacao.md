# Avaliação completa do Impeccable: Rustify Player

- **Data:** 26102026
- **Versão do app:** 0.2.96 (commit 9c4f240), desktop na cmr-auto
- **Tema:** really-dark, fonte da UI trocada pelo dono para Baumans/Righteous (Tweaks), zoom 1,1, canvas 1866x1048, cena WebGL Tinta
- **Comandos (17, todos retornaram):** critique, audit, polish, bolder, quieter, distill, harden, onboard, animate, colorize, typeset, layout, delight, overdrive, clarify, adapt, optimize
- **Modo:** proposta. Nenhum comando editou o repositório nem dirigiu o app (o CEO estava usando).
- **Baseline que não se relitiga:** `DESIGN.md` (regras nomeadas, Do's and Don'ts), `PRODUCT.md`, seção "Design gráfico e interface" de `.claude/output-styles/rustify-cto.md`.

Capturas usadas (todas em `.impeccable/captures/`):

| Arquivo | Tela |
|---|---|
| `capture-1792970293280.png` | Home (26/10) |
| `capture-1792962727862.png` | Home (25/10, fundo rosa forte atrás da lista) |
| `capture-1792970482214.png` | Now Playing (Machine Gun Funk, 0:00) |
| `capture-1792970593688.png` | Stations |
| `capture-1792970795660.png` | Crate, aba Buscar (vazia) |
| `capture-1792970910645.png` | Crate, aba Tidal (fila da VM fora do ar) |
| `detect-20261026-011212.json` | Detector na Home com a paleta ⌘K aberta |
| `detect-20261025-221248.json` | Detector na Home (25/10) |

## Resumo para o CEO

No uso, o que mais atrapalha hoje são defeitos que se veem a olho nu e têm causa simples:

1. **Aba Tidal do Crate:** a pasta de destino não se lê (texto branco sobre caixa branca, 1,04:1) e o erro da fila aparece duas vezes, com IP no texto. Quinze dos dezessete comandos apontaram isso.
2. **Now Playing:** a letra fica entre 1,9:1 e 2,6:1 sobre a Tinta (o app calcula o contraste supondo preto atrás do vidro), e o card de letra cobre metade do título "Machine Gun Funk".
3. **Home:** a lista "Recently played" some quando a Tinta passa rosa por trás (1,3:1 a 1,6:1 na captura de 25/10), e o card "Pick up where you left off" põe texto branco sobre capa clara (cerca de 2:1). O mesmo card diz "ready to resume" com a música tocando.
4. **Moldura:** a marca da barra lateral é um quadrado branco (o arquivo é uma prancha de especificação do logo, não o logo), e o painel da Stations mostra três pontos azuis num quadro vazio (cores de tema claro fixas e um azul que ignora o acento rosa da tela).
5. **Texto:** inglês misturado com português, "1 d ago" igual em todas as linhas, "SinkPipeWire" colado, "RES" e "Apple GPU" que não dizem nada.

Nada disso exige decisão de produto: são 27 correções (lista A), quase todas de custo pequeno, que cabem numa leva de release. As decisões de aparência e de comportamento novo (capa maior, mosaico na Stations, descoberta do dia na Home, movimento novo, desempenho do fundo) estão na lista B, cada uma com a minha recomendação. Cinco propostas foram descartadas por contrariar decisão sua já registrada (lista C).

Números: 189 achados brutos, 55 depois de juntar os equivalentes (27 entram direto, 23 esperam decisão, 5 descartados).

## Pontuações

| Comando | Nota | Detalhe |
|---|---|---|
| critique | **27/40 (Aceitável, no topo da faixa)** | 1 Visibilidade do estado 3; 2 Linguagem do usuário 2; 3 Controle e liberdade 3; 4 Consistência 2; 5 Prevenção de erro 3; 6 Reconhecimento 3; 7 Flexibilidade 4; 8 Estética e minimalismo 2; 9 Recuperação de erro 2; 10 Ajuda 3 |
| audit | **12/20 (Aceitável)** | Acessibilidade 2; Desempenho 3; Tema 2; Responsividade 3; Integridade 2 |

Leitura: as notas baixas (linguagem, consistência, estética, recuperação de erro, acessibilidade, tema, integridade) caem quase inteiras nos itens A1 a A13 e A17. Flexibilidade (⌘K, atalhos, seleção múltipla, Tweaks) é o ponto forte.

## A. Entra direto

Corrigem desvio do `DESIGN.md`, do `PRODUCT.md` ou de regra dura, sem decisão de produto. Ordem: impacto no uso diário vezes custo. Comandos entre colchetes: quanto mais comandos, mais convergência.

### A1. Aba Tidal: a pasta de destino não se lê; seletores nativos fora do tema
- **Tela:** Crate (aba Tidal); também Tweaks > Fonte, gênero da mood station, Settings > Tema.
- **O que o dono vê:** à direita do campo de busca, uma caixa branca com a seta preta do sistema e texto invisível (fundo 240, texto 244: 1,04:1). A barra de rolagem da Home sai clara num tema escuro.
- **Evidência:** `capture-1792970910645.png` (x 1510-1725, y 213-247); `extractor-lab.css:4134-4151` (`.crate-tidal-select` sem `appearance:none`; o WebKitGTK pinta o combobox claro do GTK); mesmo defeito em `.tweaks__select` (:1564), `.st-mood-create__genre` (:2765) e no select de tema em `Settings.tsx:284` (`.set-folder-btn`, :3022). `grep color-scheme` no CSS: nenhuma ocorrência. Só o `.select-control` do Signal (:2218) acerta.
- **Proposta:** regra única no bloco de base: `select.crate-tidal-select, select.tweaks__select, select.st-mood-create__genre, select.set-folder-btn { -webkit-appearance:none; appearance:none; background-color: var(--bg-paper); color: var(--fg-1); padding-right: 28px }` e `select option { background: var(--bg-paper); color: var(--fg-1) }`. Chevron como `<Icon name={ICONS.chevronDown} size={14}>` absoluto em `var(--fg-5)` (o data-URI de :2229 tem `#737373` fixo). `applyTheme` (`src/tauri.ts`) passa a escrever `document.documentElement.style.colorScheme = isDark ? 'dark' : 'light'` pela luminância do `--bg-paper`, para a lista aberta e as barras de rolagem saírem escuras.
- **Conferir:** captura da aba Tidal, do Tweaks > Fonte e de Settings: nome da pasta ou opção a 4,5:1 ou mais; abrir a lista no app real.
- **Custo:** S. **Risco:** a lista aberta continua sendo do GTK; se ficar clara mesmo com `color-scheme`, trocar o `<select>` da Tidal pelo `DestChip` da aba Buscar (`Crate.tsx:1892`). `color-scheme` muda caret e scrollbars de todas as telas: conferir cada vista.
- **Comandos:** critique, audit, polish, bolder, quieter, distill, harden, onboard, colorize, typeset, layout, delight, clarify, adapt, optimize.

### A2. Aba Tidal: o mesmo erro duas vezes, com IP cru e cor de aviso
- **Tela:** Crate (aba Tidal).
- **O que o dono vê:** dois banners âmbar idênticos "fila indisponível (VM fora? http://100.64.242.118:8470)", cada um com "Tentar de novo"; o campo continua convidando a buscar; nada indica que a busca está rodando. O campo tem altura e raio diferentes do campo da aba Buscar.
- **Evidência:** `capture-1792970910645.png`; `TidalTab.tsx:892-899` (erro de carga da fila) e `:943-951` (erro da busca, que passa pela mesma fila); outros banners em `:372` e `:546` a confirmar; texto montado em `src-tauri/src/slsk/tidal_fila.rs:249`; `data-tone="amber"` para falha (rosa é erro pelo `DESIGN.md`; só existem as variantes mint e amber em `extractor-lab.css:3674-3678`); `.tdl-field[data-busy]` sem regra CSS; campo 34 px/12,5 px/`--radius-md` (:4136-4143) contra 40 px/13,5 px/`--radius-lg` na aba Buscar (:3508-3531).
- **Proposta:** (1) `TidalTab.tsx:943`: banner da busca só quando `props.load !== 'error'` (um banner por causa; o "Tentar de novo" refaz o poll e repete a última busca). (2) Texto em `tidal_fila.rs:249` e fallback de `:895`: "A fila da Tidal na VM não respondeu. Sem ela não dá para baixar." + [Tentar de novo]; host e porta no `title` e no log. (3) Com `load === 'error'`, campo e seletor desabilitados. (4) `.crate-banner[data-tone="rose"]` novo (fundo `color-mix(in srgb, var(--rose-ring) 10%, var(--bg-paper))`, borda 28 %, ícone `--rose-fg`, texto `--fg-2`) para falha; âmbar fica para token ausente (:883). (5) `.crate-tidal-input, .crate-tidal-select { height: 40px; font-size: 13.5px; border-radius: var(--radius-lg) }` e `max-width: 560px` no campo, como o da aba Buscar. (6) Busca ocupada: barra de 2 px em `--blue-ring` que percorre a base do `.tdl-field[data-busy="true"]` (só `transform`, para quando `searchState` sai de `loading`; estática sob reduced-motion).
- **Conferir:** com a fila parada, um banner só, sem IP no texto, campo apagado, mesma altura da aba Buscar; com a fila no ar, a barra percorre o campo durante a busca.
- **Custo:** S. **Risco:** `TidalTab.test.tsx:188-192` procura "fila indisponível" (manter a expressão ou atualizar). O 503 "Tidal ocupada" não pode ser escondido quando a lista carregou. A aba fica montada oculta: a animação não pode ficar órfã.
- **Comandos:** critique, audit, polish, bolder, quieter, distill, harden, onboard, animate, colorize, typeset, layout, delight, clarify, adapt, optimize.

### A3. Letra do Now Playing ilegível sobre a Tinta
- **Tela:** Now Playing.
- **O que o dono vê:** o card de letra parece desligado: linhas inativas cinza sobre vidro cinza-rosado, de 1,9:1 a 2,6:1; o rótulo "aligned" a cerca de 3:1. Antes do primeiro verso, tudo fica no tom mais apagado.
- **Evidência:** `capture-1792970482214.png` (medições de critique, audit e overdrive: 2,60 / 2,16 / 1,93 / 1,88:1); `extractor-lab.css:881-888` (`.np__lyric` em `--fg-7`, que o `DESIGN.md` define como "decorativo apenas"); `lib/lyricsInk.ts:41-48` (piso 3 no `--fg-7`); `NowPlaying.tsx:157-167` mede contra `GL_CANVAS` (#000) com o WebGL ligado, mas a Tinta pinta zonas claras e rosadas atrás do vidro (alpha 0,193).
- **Proposta:** (1) `measureInk` (`NowPlaying.tsx:158`): com o WebGL ativo, medir contra o pior fundo plausível, a cor mais clara entre `--bg-ink-rgb` e `--primary` (as mesmas que `src/gl/palette.ts` entrega às cenas), e exigir que cada tom passe contra vidro sobre preto e vidro sobre essa cor. (2) `.np__lyric` passa de `--fg-7` para `--fg-5`; pisos em `lyricsInk.ts`: linha distante 3:1, próxima e ativa 4,5:1. (3) Sincronizada e antes do primeiro verso (`activeLine === -1`): as três primeiras linhas como `is-near`. (4) Cabeçalho do card em `--fg-5`.
- **Conferir:** recortar o card na captura nova, com a Tinta rosa atrás, e medir cada linha visível no pior ponto; repetir com Relevo, Lorem e fundo 2D.
- **Custo:** S. **Risco:** a diferença entre ativa e inativa encolhe; a ativa mantém peso 600 e `--fg-1`. Os testes de `lyricsInk` (pisos por papel) mudam. Se nenhuma tinta resolver sobre o rosa, o próximo passo é o piso de alpha do vidro (B4), que é decisão sua.
- **Comandos:** critique, audit, polish, quieter, colorize, typeset, overdrive (onboard e bolder registraram sem medir).

### A4. O título do Now Playing passa por baixo do card de letra
- **Tela:** Now Playing.
- **O que o dono vê:** "Gun Funk" (76 px) fica atrás do vidro, e "LYRICS · SYNCED" cai em cima das letras do título, a única palavra grande do app.
- **Evidência:** `capture-1792970482214.png` (card x 663-1316, y 112-697; título até x≈962); `NowPlaying.tsx:205-215` restaura a caixa salva (`rustify-lyrics-card`, 653x585) com `clamp()` só ao contêiner (:111-118); `.np__left` com `max-width: 880px` (`extractor-lab.css:660-667`); card com `z-index: 2` (:785-790).
- **Proposta:** o título dá passagem, sem mexer na posição que você escolheu. O `ResizeObserver` que já existe (`NowPlaying.tsx:216-222`) mede o `.np__left`; quando o card está visível e começa acima do fim do bloco do título, o `.np__left` recebe `max-width: min(880px, box().x - left - 28px)` (mínimo 280 px), no elemento e só ao soltar o arrasto, no resize e na troca de faixa, nunca por quadro. O `text-wrap: balance` quebra o título em duas linhas. `.np__title` ganha `overflow-wrap: anywhere` e limite de 3 linhas para títulos longos.
- **Conferir:** captura com "Machine Gun Funk" e com um título de 80 caracteres, com a caixa salva atual: nenhum glifo sob o vidro.
- **Custo:** M. **Risco:** `-webkit-line-clamp` com `balance` pode quebrar diferente no WebKitGTK; medir. Fonte Baumans é mais larga que a Instrument Sans: testar nas duas. Se você quiser que o card também desvie sozinho, ver B3.
- **Comandos:** critique, audit, polish, bolder, quieter, distill, harden, onboard, typeset, layout, delight, overdrive, adapt.

### A5. Lista "Recently played" da Home sem vidro: o texto some quando a Tinta passa rosa
- **Tela:** Home (também Histórico e Recently played, que usam `.row-list`).
- **O que o dono vê:** artista e álbum quase invisíveis quando o fundo fica rosa: subtítulo 1,41:1, "1 d ago" 1,29:1, "View history" 1,58:1. Na captura de 26/10 a lista passa só porque o fundo estava escuro naquele instante.
- **Evidência:** `capture-1792962727862.png` contra `capture-1792970293280.png`; `.row-list` (`extractor-lab.css:585`) e `.section__head` (:444) sem fundo, direto sobre o `.app-bg` ambient (opacidade 0,8, :234). A tabela de Álbum/Playlist/Faixas (`.tracks`, :995) já tem o vidro barato.
- **Proposta:** `.row-list { background: rgba(var(--glass-tint), calc(var(--glass-alpha) - 0.07)); border: 1px solid var(--line-2); border-radius: var(--radius-xl); overflow: hidden }` e `.row-list > .row:last-child { border-bottom: 0 }`, sem `backdrop-filter` (Regra do Vidro Barato). O cabeçalho da seção entra no bloco com `padding: 12px 12px 0`.
- **Conferir:** captura com a Tinta rosa atrás (ou Speed = 0 num quadro claro): "1 d ago" e subtítulo a 4,5:1 no pior ponto; conferir Histórico.
- **Custo:** S. **Risco:** nenhum custo de quadro.
- **Comandos:** audit, colorize, quieter.

### A6. Cards do topo da Home: texto branco sobre capa clara e título centralizado por acidente
- **Tela:** Home.
- **O que o dono vê:** no card com a capa do Ready To Die, o fim do título fica a cerca de 3:1 e "04:15 · ready to resume" entre 1,8:1 e 2,7:1; é a área mais clara da Home. Nos três cards, o eyebrow fica à esquerda e título e subtítulo centralizados.
- **Evidência:** `capture-1792970293280.png`; `extractor-lab.css:522-552` (`brightness(0.92)`, gradiente 135deg 0,72 → 0,15 que clareia exatamente onde ficam título e subtítulo, sub a 74 %, brancos literais em :545-552); `.hero-tile` é `<button>` e nem o reset (:168) nem a regra (:506-517) definem `text-align` (o `.np__artist` já precisou de `text-align:left` pelo mesmo motivo, :731); eyebrow a 10,5 px (:553-554).
- **Proposta:** `.hero-tile { text-align: left; align-items: flex-start }`; gradiente para `linear-gradient(135deg, rgba(0,0,0,.72) 0%, rgba(0,0,0,.58) 100%)` (sobre capa branca dá cerca de 5,9:1); `.hero-tile__bg` com `brightness(0.75)`; sub e eyebrow a 0,88; eyebrow a 11 px; brancos literais viram tokens novos `--on-scrim` e `--on-scrim-2` no `:root`. `h3.hero-tile__title` vira `h2` (o detector acusa h1 seguido de h3).
- **Conferir:** captura com capa branca, capa preta e capa saturada: pior ponto sob o subtítulo a 4,5:1 e título a 3:1 ou mais; três cards alinhados à esquerda.
- **Custo:** S. **Risco:** a capa do card fica mais escura. **Atualizar o `DESIGN.md`** (Cards / Containers descreve "0,72 → 0,15"): a mudança cumpre a Regra do Piso, que prevalece sobre o valor descrito.
- **Comandos:** critique, polish, bolder, quieter, distill, harden, onboard, colorize, typeset, layout, overdrive.

### A7. O card de retomada diz "ready to resume" com a música tocando
- **Tela:** Home.
- **O que o dono vê:** a primeira tela do dia afirma uma coisa falsa: "PICK UP WHERE YOU LEFT OFF · 04:15 · ready to resume" com a barra mostrando pausa (tocando) e a duração no lugar do ponto onde parou. O terceiro card diz "1 tracks".
- **Evidência:** `capture-1792970293280.png`; `Home.tsx:99-112` decide só por `player.currentTrack` (sem `isPlaying`) e usa `durationSecs`; `Home.tsx:141` (plural).
- **Proposta:** tocando: eyebrow "Tocando agora" e sub "1:52 de 4:15" (mono tabular, memo arredondado ao segundo); pausada: "Continuar de onde parou" e "parou em 1:52 de 4:15". Plural por helper ("1 faixa", "n faixas").
- **Conferir:** com música tocando o card nunca diz "continuar"; pausado mostra a posição real.
- **Custo:** S. **Risco:** `Home.test.tsx` tem asserts de texto. Retomar do ponto ao clicar (em vez de só navegar) é melhoria de comportamento do delight; entra junto se o teste cobrir.
- **Comandos:** critique, delight (audit e harden registraram a dúvida do estado).

### A8. A marca da barra lateral é um quadrado branco
- **Tela:** barra lateral, todas as telas.
- **O que o dono vê:** um retângulo branco de 20 px no canto superior esquerdo, o objeto mais claro da moldura depois do botão play.
- **Evidência:** todas as capturas (x 22-44, y 60-80); `Sidebar.tsx:23` e `:87` importam `src/assets/logo-cassette.png` (960x1320, opaco), que é a foto de uma prancha de especificação ("Cassette · Paper Outline, all 1.5px stroke", amostras 64/32/20 px), espremida em 20x20. O ícone verdadeiro do app (`src-tauri/icons/128x128.png`, cassete de traço) não está na interface.
- **Proposta:** SVG inline do cassete redesenhado a partir de `src-tauri/icons/128x128.png` (viewBox 24, traço 1,5-2 px, `stroke="currentColor"`, sem preenchimento de papel), herdando a cor do `.brand__mark` (`extractor-lab.css:334`); `aria-label="Rustify"`. Apagar o PNG da prancha (66 KB).
- **Conferir:** captura em tema escuro e claro: a marca tem o peso dos ícones vizinhos e não forma bloco; modo só-ícones (56 px).
- **Custo:** S. **Risco:** é a marca: a variante com etiqueta ferrugem é pergunta (P5). Nenhum risco técnico.
- **Comandos:** critique, audit, polish, bolder, quieter, distill, harden, onboard, colorize, layout, delight.

### A9. Painel da Stations pintado com cor crua e tinta de tema claro
- **Tela:** Stations (e a curva do EQ no Signal, pelo código).
- **O que o dono vê:** metade do destaque "Your Mix" é um quadro preto com três pontos azuis; a grade e os 28 pontos não aparecem. O eyebrow da mesma tela está no acento rosa: dois acentos.
- **Evidência:** `capture-1792970593688.png` (x 1110-1780); `components/dsp/StationViz.tsx:111, 120, 136` (`rgba(0,0,0,0.05)`, `rgba(23,23,23,0.45)`, invisíveis sobre #0c0c0c), `:149-156` (`rgba(59,130,246)`, `rgba(37,99,235)`, anel `rgba(255,255,255,0.95)`); rAF contínuo em `:163-166`. `EqCanvas.tsx:310, 320, 412, 422, 442` repete o padrão (estimado em 1,1:1 sobre o paper; Signal sem captura).
- **Proposta (mínimo, vale com qualquer decisão de B2):** helper `readCanvasInk()` lê `--fg-1`, `--fg-5`, `--line-2`, `--primary` (ou `--blue-ring`) e `--bg-paper` uma vez no mount e de novo em `rustify:theme-applied` e na troca de acento da capa, nunca por quadro; sementes e halo no acento com `--halo-alpha`, grade em `--line-2`, pontos em `--fg-5`, anel em `--bg-paper`. O StationViz passa a quadro estático (sai o rAF).
- **Conferir:** captura da Stations e do Signal no Really Dark: pontos visíveis, um acento só na tela, curva do EQ a 3:1 contra o paper.
- **Custo:** S. **Risco:** `StationViz.test.tsx` fixa cores. Sem `getComputedStyle` por quadro.
- **Comandos:** critique, audit, polish, bolder, quieter, distill, harden, onboard, colorize, animate, delight, overdrive.

### A10. Stations: cada card repete a mesma frase três vezes
- **Tela:** Stations.
- **O que o dono vê:** "chill · romance" / "mood · chill romance" / "chill romance"; "gerada a partir das suas tracks favoritas" três vezes no destaque; nomes de mood quebrando em 3 a 4 linhas e desalinhando a grade; lixeira visível em todos os 15 cards; cabeçalho "Smart radio — geradas a partir de seeds e embeddings (qdrant)".
- **Evidência:** `capture-1792970593688.png`; `Stations.tsx:165-171` (seedLine), `:232-239` (desc), `:99-121` e `:141-146` (dica + SeedChips), `:444` (cabeçalho); `extractor-lab.css:2820-2860` (nome sem limite de linhas), `:2862-2886` (lixeira a 0,35), `:2785` (grade).
- **Proposta:** não renderizar `.st-card__desc` quando, normalizada, repete o nome ou a query; seedLine só para semente ("5 faixas-semente"); `SeedChips` fora do destaque quando repete a dica; `.st-card__name` com `-webkit-line-clamp: 2` e `title` completo; `.st-grid { grid-auto-rows: 1fr }`; lixeira com opacidade 0 em repouso e 1 em hover/foco (doutrina "invisíveis quando secundários"); cabeçalho "Rádios montadas a partir do que você ouve.".
- **Conferir:** nenhum card com a mesma palavra duas vezes; linha de cards na mesma altura; lixeira só no hover.
- **Custo:** S. **Risco:** testes de Stations (seedLine, chips) mudam. Stations duplicadas ("chill" duas vezes) são dado, não UI: dedup na criação é tarefa à parte.
- **Comandos:** critique, audit, polish, bolder, quieter, distill, harden, onboard, typeset, layout, clarify, delight, adapt.

### A11. Ficha técnica do Now Playing cola palavras e repete o PipeWire
- **Tela:** Now Playing.
- **O que o dono vê:** "96kHz", "SinkPipeWire", "DSPEQ · LIM"; "Local · PipeWire" acima do título e "PipeWire" de novo na ficha.
- **Evidência:** `capture-1792970482214.png`; `extractor-lab.css:754` (`.np__specs > span { display: inline-flex }` descarta o espaço do JSX); `NowPlaying.tsx:403, 432, 436, 444, 450`.
- **Proposta:** `.np__specs > span { display: inline-flex; align-items: center; gap: 0.3em }`; `<b>24</b> bits` para não virar "24 -bit"; "Sink" vira "Saída"; "stereo" vira "estéreo"; sai o `np__tag-source` "Local · PipeWire" (a ficha já diz).
- **Conferir:** "96 kHz", "24 bits", "Saída PipeWire", "DSP EQ · LIM"; selo de qualidade e "estéreo" intactos.
- **Custo:** S. **Risco:** `NowPlaying.test.tsx` contém "Sink" e "DSP".
- **Comandos:** critique, audit, polish, typeset, distill, clarify.

### A12. Crate (Buscar): barra espalhada, chips de estado com peso de botão, estado vazio que contradiz o campo
- **Tela:** Crate, aba Buscar.
- **O que o dono vê:** depois de [Buscar], "rede ok", "SoundCloud: token ok", "ffmpeg: ok" e o destino com vãos iguais de 93 px; cinco controles onde só dois são clicáveis. O vazio manda "Ctrl+K → digite → Procurar na rede" com o campo logo acima; "0 baixando" sempre.
- **Evidência:** `capture-1792970795660.png`; `.coll-toolbar { justify-content: space-between }` (`extractor-lab.css:2513-2519`) vaza para `.crate-toolbar` (:3503-3507); `.crate-net-status` com 40 px, borda e fundo (:3579-3588); `Crate.tsx:1773` ("baixando"), `:2088-2096` (vazio).
- **Proposta:** `.crate-toolbar { justify-content: flex-start }` e `.crate-toolbar .crate-dest { margin-left: auto }`; `.crate-net-status` sem borda e sem fundo, 12 px, `--fg-5`, ponto de 6 px; falha volta com borda `--amber-ring`/`--rose-ring` (manter o id `crate-sources`, alvo de `Crate.tsx:1445`); "ffmpeg" vira "conversor". "baixando" só com `activeCount() > 0`. Vazio: "Busque uma música ou cole um link" + "A busca roda quando você aperta Enter, para não pesar a rede Soulseek." + kbd Enter; ícone em 24 px (o código usa 26).
- **Conferir:** captura com busca e destino agrupados, status quietos, uma instrução que bate com o campo.
- **Custo:** S. **Risco:** `Crate.test.tsx` procura "rede ok", "ffmpeg: ok", "Nada buscado ainda". Colapsar em "fontes ok" é B13.
- **Comandos:** critique, polish, quieter, distill, harden, onboard, bolder, layout, adapt, clarify.

### A13. Tweaks mostra o nome mascarado da GPU
- **Tela:** Tweaks (seção Fundo).
- **O que o dono vê:** "Apple GPU · 60 fps", rótulo que você já reprovou.
- **Evidência:** `views/Tweaks.tsx:198-202`; rejeição registrada no `DESIGN.md` e no `rustify-cto.md`.
- **Proposta:** só "<fps> fps" em mono tabular, ponto em `--green-ring` com 58 ou mais e `--amber-ring` abaixo; o renderer no máximo no `title`.
- **Conferir:** captura do Tweaks aberto na seção Fundo.
- **Custo:** S. **Risco:** nenhum.
- **Comandos:** critique.

### A14. Texto abaixo do piso de 11 px; "RES", "←" e slug na barra de título
- **Tela:** global (barra de título, hero-tiles, paleta ⌘K, letra, Stations, Signal).
- **O que o dono vê:** "RES" em mono 10 px que não diz nada; voltar como caractere "←"; "rustify-player" como slug; eyebrows e rodapé da paleta em 10-10,5 px.
- **Evidência:** `detect-20261026-011212.json` (RES 10 px; eyebrows dos hero-tiles 10,5; `.palette__esc` 10; `.palette__footer` 10,5); `Titlebar.tsx:89, 98-100, 104-113`; `extractor-lab.css:305-319, 553-554, 1260, 1296, 881, 2657, 2880, 2212`. A Regra do Piso de 11 pede 11 px (12,1 com zoom).
- **Proposta:** token `--fs-label: 11px` no `:root` e troca das declarações funcionais acima; "RES" vira `<Icon name="lucide:activity" size={14}>` com `title`/`aria-label` "Recursos (Ctrl+R)" (é o HUD de recursos); "←" vira `lucide:arrow-left`; "Rustify Player".
- **Conferir:** detector na Home com a paleta aberta: zero `undersized-ui-text`; titlebar só com ícones Lucide.
- **Custo:** S. **Risco:** eyebrow a 11 px pode quebrar linha no tile estreito (usar ellipsis). Os 61 valores abaixo de 12 px restantes entram na reforma de tokens (B20). Ícone novo precisa estar no subconjunto offline.
- **Comandos:** critique, audit, quieter, onboard, typeset, layout, adapt, distill, harden, clarify, polish.

### A15. Trilho de progresso da barra do player abaixo de 3:1
- **Tela:** barra do player.
- **O que o dono vê:** o trilho de 3 px quase some entre os tempos.
- **Evidência:** `.progress` em `var(--line-2)` (branco a 8 %) e `.progress__fill` em `--fg-3` (`extractor-lab.css:1167-1186`), cerca de 1,2:1 contra o paper; a Regra do Piso pede 3:1 para controles.
- **Proposta:** trilho em `color-mix(in srgb, var(--fg-1) 22%, transparent)` (cerca de 3:1); preenchimento continua carbono 3, como manda o `DESIGN.md`.
- **Conferir:** captura com a faixa tocando; medir trilho e preenchimento contra o paper.
- **Custo:** S. **Risco:** nenhum. Preencher com o acento é B15.
- **Comandos:** bolder, polish.

### A16. prefers-reduced-motion cobre só 3 animações
- **Tela:** global e S24.
- **O que o dono vê:** com "reduzir animações" ligado no GNOME, nada muda além de três detalhes: o fundo segue com kick e ondas, a rota desliza, menus pulam, o pulso do NOW PLAYING continua.
- **Evidência:** blocos só em `extractor-lab.css:1406, 2673, 4261` e `StationViz.tsx:56`; sem versão calma em `.view` (:405/412), `track-ctx-pop` (:3401), pulso (:712), rail da letra (:880), gaveta (:1330), paleta (:1241), `.app-bg` (:220), vu do mini (:396); `src/mobile/styles/app.css` sem nenhum bloco; motor GL e SpectrumCanvas não consultam a preferência. O `PRODUCT.md` exige versão calma.
- **Proposta:** bloco único no fim do CSS (`animation: none` em `.view`, menu, pulso, vu; `transition: none` no rail; gaveta e paleta só com opacidade); o mesmo em `app.css` do S24. No fundo: com `matchMedia('(prefers-reduced-motion: reduce)')` e o knob não tocado (dirty-flag do Tweaks), fator de calma no sinal (`src/gl/signal.ts`): velocidade x0,25, pulso do kick zerado, ondas da Lorem desligadas; mesmo fator no 2D via `bgSpeed`. Calma, não tela morta; nada de multiplicar `uTime` por sinal.
- **Conferir:** ligar a preferência no GNOME: rota sem deslocamento, fundo lento e sem pulso.
- **Custo:** S. **Risco:** o WebKitGTK só reflete a preferência se o GTK a expuser; sem ela o bloco é inerte, o que é seguro.
- **Comandos:** audit, animate, adapt, delight.

### A17. Tempo e números: "1 d ago" igual em todas as linhas, 04:16 contra 4:15
- **Tela:** Home, Stations, barra do player, Histórico.
- **O que o dono vê:** as oito linhas dizem "1 d ago"; a mesma faixa mostra 04:16 na lista, 04:15 no card e 4:15 na barra; "last: 10 sem" na Stations.
- **Evidência:** `lib/format.ts:5-8` (`fmtDur` arredonda, `MM:SS`) e `:11-18` (`relTime` em inglês); `Stations.tsx:85-93` (`formatRelative` próprio); cópia em `CommandPalette.tsx:55`; `PlayerBar.tsx:612-632` (`formatDuration`, `aria-label="Seek"`, "of"); estatísticas do cabeçalho em `<b>` proporcional (`Home.tsx:69-71`).
- **Proposta:** uma `relTime` em PT-BR com hora para o recente ("agora", "há 12 min", "hoje 14:32", "ontem 22:10", dia da semana até 6 dias, depois "12 out"); `fmtDur` com `Math.floor`, `M:SS` (`H:MM:SS` acima de 1 h), usado em todos os lugares; apagar `formatRelative` da Stations e a cópia da paleta; `aria-label="Posição da faixa"`, "1:20 de 4:15"; `tabular-nums` nas estatísticas.
- **Conferir:** captura da Home com horários distintos por linha e 4:15 nos três lugares.
- **Custo:** S. **Risco:** testes de `relTime` e `TrackRowList`; colunas de 42/60 px com faixas de 10:00+ e de mais de 1 h.
- **Comandos:** critique, harden, clarify, typeset, bolder.

### A18. Linha da Home joga 600 px de vazio entre o título e a hora
- **Tela:** Home (e Histórico).
- **O que o dono vê:** título até x≈370, "1 d ago" em x≈1327 e duração em x≈1700: o olho cruza a tela para ligar faixa e hora.
- **Evidência:** `capture-1792970293280.png`; `.row` com `40px 1fr 220px 120px 60px` (`extractor-lab.css:588`), coluna de álbum vazia na Home.
- **Proposta:** variante `.row--no-album` (Home e Histórico) com `40px minmax(0,1fr) auto auto`, gap 14 px, hora alinhada à direita com `min-width: 72px` logo antes da duração. Tracks, Álbum e Playlist ficam como estão; `contain-intrinsic-size` de 61 px intacto.
- **Conferir:** hora e duração a no máximo 120 px entre si; Histórico conferido.
- **Custo:** S. **Risco:** baixo.
- **Comandos:** layout, adapt, bolder.

### A19. Pílula técnica: o ponto verde vale para "medido sem corte" e para "nunca medido"; rótulos sem explicação
- **Tela:** barra do player (e selo da capa no Now Playing).
- **O que o dono vê:** "● FLAC 24/96 · EQ · LIM" com ponto verde em toda faixa, conferida ou não; "RÁDIO" e a pílula sem dica do que são; "Like" em inglês.
- **Evidência:** `extractor-lab.css:1211` (ponto `--green-ring` para tudo que não é lossy); `src/lib/quality.ts:35-56` (`title` nulo para `sem_corte` e ausente); `PlayerBar.tsx:482-489` (`.pb-src` sem motivo no rádio), `:499-507` (Like).
- **Proposta:** `qualityBadge` ganha `verified` para `sem_corte`, com `title` "Medido no conteúdo: sem corte de lossy."; faixa sem medição ou "indeterminado" ganha `.pb-tech--unmeasured` (ponto em `--fg-6`, sem halo, "Qualidade ainda não medida"). `title`/`aria-label` em PT-BR: pílula "FLAC 24 bits, 96 kHz. EQ e limitador ligados"; RÁDIO "Tocando por rádio: o motor escolheu esta faixa"; "Curtir" / "Curtida".
- **Conferir:** hover na pílula de faixa do acervo semeado e de faixa recém-chegada.
- **Custo:** S. **Risco:** nenhum; faixas não medidas ficam cinza até o backfill, o que é verdade.
- **Comandos:** delight, clarify.

### A20. Now Playing sem música diz "Nothing playing" e não oferece caminho
- **Tela:** Now Playing (estado vazio, sem captura).
- **O que o dono vê:** título "Nothing playing" a 76 px, "—" em artista e álbum, selo NOW PLAYING pulsando sem faixa.
- **Evidência:** `NowPlaying.tsx:401-430`; o `DESIGN.md` pede estado vazio desenhado (modelo do Crate).
- **Proposta:** "Nada tocando" em 22 px e duas ações: [Continuar <última faixa do histórico>] (`libListHistory(1)`) e [Aleatório no acervo] (a função `shuffleAll` da Home, movida para `lib/` ou `store/`); selo e ficha ocultos.
- **Conferir:** com a fila zerada, as duas ações e nenhum "—".
- **Custo:** S. **Risco:** testes procuram "Nothing playing".
- **Comandos:** delight.

### A21. Acento de repouso do Really Dark ainda é rosa-malva
- **Tela:** global.
- **O que o dono vê:** com a capa acromática do Ready To Die, chip RÁDIO, botão de letra, selo NOW PLAYING e eyebrow MOST PLAYED saem em #997081.
- **Evidência:** todas as capturas; `~/.local/share/rustify-player/themes/really-dark.yaml` (accent.primary #997081, container #4d3740); a Regra do Acento Único e os Don'ts já registram a sua direção de 26/10 (repouso neutro, cor vem da capa; "alinhar é tarefa do theme-maker").
- **Proposta:** pelo subagente `theme-maker`, arquivo de tema com accent.primary #b8b8b8, primary-container #2a2a2a, on-primary #0a0a0a, on-primary-container #e6e6e6; `scripts/themes/validate.py` sem reprovação. Capa colorida continua tingindo pelo adaptiveAccent. O S24 (`tokens.css --accent`) só se você quiser o mesmo no celular.
- **Conferir:** Home e Now Playing com capa acromática (neutro) e com capa colorida (acento volta).
- **Custo:** S. **Risco:** conferir se o ink da Tinta deriva do acento e não fica cinza.
- **Comandos:** colorize.

### A22. A curva `--ease-out` não desacelera; o trilho da letra passa do teto e mede por quadro
- **Tela:** global; Now Playing.
- **O que o dono vê:** respostas de 150 ms que arrancam devagar (parecem arrastadas); linha ativa da letra deslizando em 600 ms.
- **Evidência:** `extractor-lab.css:140` e `src/mobile/styles/tokens.css:50` (`cubic-bezier(0.4,0,0.2,1)`, a ease-in-out do Material); `.np__lyrics-rail` em 600 ms (:880), acima do teto de 500 ms do `rustify-cto.md`; `NowPlaying.tsx:307-326` roda `requestAnimationFrame` eterno lendo `offsetTop` e escrevendo `transform`.
- **Proposta:** `--ease-out: cubic-bezier(0.16, 1, 0.3, 1)` e `--ease-in: cubic-bezier(0.4, 0, 1, 1)` para saídas (gaveta e paleta ao fechar); rail em `var(--dur-screen)` novo (0,36 s); trocar o laço rAF por `createEffect(on(activeLine))` mais `ResizeObserver` no viewport.
- **Conferir:** abrir e fechar gaveta e paleta; no Performance do WebKit, o layout por quadro da letra some; `NowPlaying.behavior.test.tsx` passando.
- **Custo:** S. **Risco:** muda a sensação de tudo que usa o token (fundo 420 ms e trilho parecem mais rápidos no começo). Valor estático: não toca a regra do `:root`.
- **Comandos:** animate, overdrive.

### A23. Chips, tiles e navegação sem resposta ao toque
- **Tela:** global.
- **O que o dono vê:** clicar e segurar num chip, num hero-tile ou num item da barra lateral não dá retorno; a doutrina do `DESIGN.md` é "táteis ao toque".
- **Evidência:** `extractor-lab.css:1783-1789` cobre só `.pb-icon-btn`, `.pb-like`, `.tog`, `.segmented button`, `.sm-toggle`.
- **Proposta:** estender a regra a `.chip:active`, `.hero-tile:active` (`scale(0.995)`), `.nav-item:active`, mantendo `transform 0.08s`. Transporte (play, anterior, próxima) fica de fora (ver C1).
- **Conferir:** clicar e segurar em cada um.
- **Custo:** S. **Risco:** nenhum.
- **Comandos:** animate.

### A24. Interface em inglês, setas "→" e jargão
- **Tela:** Home, Stations, Now Playing, Crate.
- **O que o dono vê:** "Pick up where you left off", "Quick start", "From your library", "Shuffle all", "Recently played", "View history →", "tracks · albums · embedded", "Most played", "Play station", "All stations", "played", "last:", "New from current track →", "NOW PLAYING", "LYRICS · SYNCED", "aligned", "SoundCloud: token ok", "DESTINO → destino padrão", separador de milhar "2,203".
- **Evidência:** `Home.tsx:62, 67-71, 101, 110-111, 117, 125-141, 155-156, 180`; `Stations.tsx:133, 150, 241, 247, 444, 516, 523, 531, 564`; `NowPlaying.tsx:440-455, 481-487`; Crate. `PRODUCT.md`: PT-BR em todo texto, Crate/Tweaks/Signal/Stations como nomes próprios. `DESIGN.md` Don't: seta "→" em botão.
- **Proposta:** troca em lote: "Continuar de onde parou", "Início rápido", "Do seu acervo", "Tocar tudo em aleatório", "Tocadas recentemente", "Ver histórico", "2.203 faixas · 956 álbuns · 2.203 com vetor" (`toLocaleString('pt-BR')`), "Mais tocada", "Tocar station", "Todas as stations", "19 reproduções · última há 1 sem", "Nova a partir da faixa atual", "Nova station por clima", "Tocando agora", "Letra · sincronizada" (sai "aligned"), "Soulseek conectado", "SoundCloud conectado", "Conversor pronto", "Salvar em: pasta padrão". Sem setas. "Station" fica como nome próprio (a área se chama Stations).
- **Conferir:** grep pelos textos antigos sem resultado; capturas das três telas.
- **Custo:** M. **Risco:** muitos testes casam texto (Home, Stations, NowPlaying, PlayerBar, CommandPalette, Crate). Textos em PT são ~15 % mais longos: conferir os cards do topo. O `PRODUCT.md` diz que a migração vai à parte: leva própria, logo depois da leva 1.
- **Comandos:** critique, audit, polish, distill, harden, onboard, typeset, clarify, delight, quieter.

### A25. A abertura do app carrega a coleção Lucide inteira
- **Tela:** abertura do app.
- **O que o dono vê:** nada na tela; o boot faz parse de 566 KB de JSON para usar 63 ícones.
- **Evidência:** `dist/assets/boot-desktop-*.js` com 624 KB, dos quais 566 KB são `@iconify-json/lucide/icons.json`; `src/icons-offline.ts:17-19` (`addCollection(lucide)`).
- **Proposta:** `scripts/gen-icons.mjs` no prebuild gera `src/icons-subset.json` com os nomes usados (mapa `ICONS` e `icon="..."`), e o build falha se um nome do `ICONS` não estiver no subconjunto. Continua Lucide offline, sem CDN.
- **Conferir:** boot cai para ~80-100 KB; capturas da Home e do Crate com todos os ícones.
- **Custo:** M. **Risco:** nome montado em tempo de execução vira quadrado vazio; o gate do build precisa cobrir isso.
- **Comandos:** optimize.

### A26. S24: alvos de toque de 30 px e tons abaixo do piso
- **Tela:** S24 (só pelo código, sem captura).
- **O que o dono vê:** ícones de excluir station e afins com área de toque de 30 px; rótulo inativo da tabbar a 3,84:1.
- **Evidência:** `src/mobile/styles/app.css:888-891` (`.iconbtn.sm` 30x30, usado em `src/mobile/screens/Stations.tsx:69`), ícones em `:540-556`; `tokens.css`: `--t4` #6e6e6e sobre #0c0c0c = 3,84:1 (9,5 px), accent #997081 sobre `--s-low` = 4,49:1, erro #8b7575 = 4,56:1.
- **Proposta:** `.iconbtn.sm { width: 44px; height: 44px; margin: -7px }` (densidade visual igual); `--t4` para #7c7c7c (ou #808080), accent para #a37d8f, erro para #9c8484.
- **Conferir:** `smoke_mobile.py` com dump de bounding boxes (nenhum alvo abaixo de 44); `impeccable detect --cdp` via `adb forward` (ainda não testado) e print da tabbar com o aparelho desbloqueado.
- **Custo:** S. **Risco:** medido só por fórmula; o accent depende de A21 se você quiser o celular neutro.
- **Comandos:** adapt, colorize.

### A27. Espaçamento sem token: o gutter de 40 px está solto em 18 regras
- **Tela:** global.
- **O que o dono vê:** nada hoje; o modo compacto precisa sobrescrever cada seletor e já exigiu exceção.
- **Evidência:** `grep "padding:[^;]*40px"` em `extractor-lab.css`: 18 regras (`.view__head` :419, `.crate-toolbar` :3505, `.crate-tidal` :4131, `.crate-banner` :3654…); bloco compacto em :1662-1669. O `rustify-cto.md` manda criar o token que falta.
- **Proposta:** `--space-gutter: 40px`, `--space-gutter-compact: 24px`, `--space-block: 36px` no `:root`; o bloco `html[data-density="compact"]` só redefine o token. Sem transition nessas vars.
- **Conferir:** capturas de Home e Crate nos dois modos de densidade: nenhum pixel muda no padrão.
- **Custo:** M. **Risco:** regressão sutil em telas sem captura; regenerar `DESIGN.md` e sidecar junto.
- **Comandos:** layout, adapt.

## B. Decisão do CEO

Mudam comportamento, mudam aparência de forma marcante ou conflitam com a direção documentada. Ordem: impacto no uso diário vezes custo.

### B1. Painel da Stations: mosaico das capas das sementes no lugar dos pontos
- **Tela:** Stations. **O que o dono vê hoje:** os pontos são sorteados (`StationViz.tsx:31-45`, `Math.random`) e as sementes têm posição fixa copiada do mockup (`:22-27`): não representam a station. O destaque ocupa 390 px e só cabe 1,5 linha de cards; "Your Mix" aparece no destaque e de novo como primeiro card.
- **Proposta:** até 5 capas das `seed_track_ids` em leque (44-64 px, `--radius-md`; a do centro maior) com a legenda "nasce destas 5 faixas"; mood station mostra as palavras do clima ou as capas das mais tocadas. Destaque cai para ~190 px; "Your Mix" sai da grade quando está no destaque. Alternativas: mapa real por projeção dos vetores MERT (L, comando novo; agrupa mais por artista que por estilo, CMR-302) ou só remover o painel (contraria o Princípio 5).
- **Trade-off:** dado real e a capa vira a ousadia da tela, contra um IPC por destaque e o fim do StationViz (código investido). **Custo:** M. **Comandos:** critique, audit, polish, distill, onboard, animate, delight, overdrive, layout, harden, bolder.
- **Recomendação:** mosaico das sementes, com "Your Mix" fora da grade.

### B2. Capa do Now Playing maior
- **Tela:** Now Playing. **Hoje:** 218 px na tela (2,4 % do canvas) ao lado de um título de 76 px; o álbum fica menor que a palavra "Machine".
- **Proposta:** `.np__cover { width: clamp(200px, 17vw, 300px); aspect-ratio: 1 }` (~300 px no seu monitor), tirando o estilo inline de 200 px (`NowPlaying.tsx:381, 389`); quebra de 760 px mantida.
- **Trade-off:** a capa vira metade da ousadia da tela, contra menos largura para o título (depende de A4) e capa de baixa resolução borrando a 300 px. Conflita com o `DESIGN.md` (Layout fixa 200 px). **Custo:** S. **Comandos:** critique, bolder.
- **Recomendação:** protótipo no app junto com A4, aprovação no seu olho.

### B3. O card de letra também desvia sozinho do título
- **Tela:** Now Playing. A4 faz o título ceder sem tocar na sua posição. Esta é a alternativa de mover o card (obstáculos = título, capa, ficha; ímã de 48 px ao soltar; primeira abertura na coluna livre).
- **Trade-off:** título sempre inteiro, contra o card "pular" ao trocar para faixa de título longo. **Custo:** M. **Comandos:** critique, audit, quieter, overdrive, layout, onboard, distill, harden.
- **Recomendação:** não; ficar com A4 e só fazer a primeira abertura (sem posição salva) nascer na coluna livre.

### B4. Vidro da letra mais fumê quando o fundo WebGL está ligado
- **Tela:** Now Playing. Se A3 não alcançar 3:1/4,5:1 sobre a Tinta rosa, o próximo passo é piso de `--lyrics-bg-alpha` em ~0,55 só no WebGL (a conta do audit dá #f5f3ee a mais de 6:1 e cinza #a8a39a a 3,3:1), ou subir o default de 0,193 para 0,32 sem tocar no valor salvo.
- **Trade-off:** letra legível contra passar por cima do slider "Lyrics glass" que você regulou. **Custo:** S. **Comandos:** audit, quieter.
- **Recomendação:** aplicar só como piso e só se a medição depois de A3 falhar.

### B5. Card "From your library" vira a descoberta do dia
- **Tela:** Home. **Hoje:** é sempre `d().albums[0]`, o primeiro álbum em ordem (um single da Peggy Gou), e a Home chama `libRecommendations()` a cada abertura e descarta o resultado (`Home.tsx:29, 36, 138-141`).
- **Proposta:** `recs.discover[0]` (ou `based_on_top[0]`) com a capa como fundo, eyebrow "Para descobrir" e motivo em uma linha ("no seu acervo, nunca ouvida até o fim"); clique toca e semeia o rádio. Alternativas: remover o card (distill) ou álbum mais tocado no mês.
- **Trade-off:** usa trabalho que o motor já faz e cumpre o Princípio 3, contra tipar o retorno e ajustar testes. **Custo:** M. **Comandos:** critique, distill, bolder, delight.
- **Recomendação:** sim, descoberta do dia.

### B6. Desempenho do fundo nas telas de trabalho (Direção C do overdrive)
- **Tela:** Home, Stations, Crate, biblioteca (e S24). **Hoje:** o canvas de 1857x1048 desenha em resolução cheia (Tinta 8,4 ms) por trás de `filter: blur(8px) saturate(0.9)` e opacidade 0,8 (`extractor-lab.css:234-237`), e a ida e volta ao Now Playing interpola o blur da camada por 420 ms (:219-221). Nenhum número medido; a cmr-auto roda a 97-98 °C.
- **Proposta:** primeiro medir (fps do Tweaks e tempos de quadro durante a troca de rota, máquina ociosa). Se passar do critério, nada muda. Se falhar: o modo ambient renderiza no buffer reduzido que o motor já tem (`gl/engine.ts:286-303`, ~1/4 das linhas), com desfoque, saturação e opacidade no shader de composição (`uAmbient` interpolado na CPU, não CSS); o 2D fica com o filter atual. S24: mesmo tratamento e o `.sheet .panel` (`app.css:969`) sem `backdrop-filter`.
- **Trade-off:** folga de quadro e térmica para o Now Playing, contra mudar a implementação descrita no `DESIGN.md` (blur 8 px) e o risco de a Home mudar de cara (comparação lado a lado é o portão). **Custo:** M. **Comandos:** overdrive, optimize, animate.
- **Recomendação:** medir já; se o filter custar quadros, fazer C antes de qualquer movimento novo.

### B7. Chip RÁDIO diz quando a faixa é descoberta
- **Tela:** barra do player. **Hoje:** o motor serve conhecida, conhecida, descoberta (`autoplay_mix`, `desktop.rs:539`) e a tela não diz qual.
- **Proposta:** `lib_autoplay_next` devolve `autoplay_pick` por faixa (campo opcional); o chip mostra "rádio · descoberta" só nas descobertas; tooltip com motivo ("Conhecida: você ouviu até o fim 7 vezes").
- **Trade-off:** cumpre o Princípio 3, contra mudar o contrato IPC (o S24 fica sem o campo até portar). **Custo:** M. **Comandos:** delight.
- **Recomendação:** sim.

### B8. Chegada de download do Crate avisa fora do Crate
- **Tela:** barra lateral e Crate. **Hoje:** o badge some quando o job termina (`Sidebar.tsx:106-107`); a linha pronta não diz que passou no portão espectral (`Crate.tsx:454-459`).
- **Proposta:** ponto de 6 px em `--blue-ring` com "2 faixas novas no acervo" até abrir o Crate; linha "✓ no acervo · conferida, sem corte · em <playlist>"; Tocar vira o botão primário nesse estado.
- **Trade-off:** reforça a razão de ser do acervo, contra um sinal novo na barra lateral. **Custo:** M. **Comandos:** delight.
- **Recomendação:** sim.

### B9. Curtir com um pulso único
- **Tela:** barra do player. **Hoje:** só troca a cor do coração de 14 px (`PlayerBar.tsx:499-507`).
- **Proposta:** `scale(1) → 1.22 → 1` em 240 ms só ao curtir, nunca ao descurtir nem ao carregar faixa curtida; sem animação sob reduced-motion.
- **Trade-off:** confirma a ação de maior peso no motor, contra um movimento novo na barra. **Custo:** S. **Comandos:** animate, delight.
- **Recomendação:** sim (não é gesto repetido como play/pause).

### B10. Movimento na troca de faixa
- **Tela:** Now Playing e barra. **Hoje:** capa e título trocam no mesmo quadro enquanto o fundo faz lerp de 350 ms; a capa lazy pode piscar vazia.
- **Proposta:** crossfade de capa de 220 ms (camada antiga por baixo até o `load`) e saída/entrada do título em 6 px, só quando a troca anterior foi há mais de 1,5 s; em rajada de pulos (77 % dos pulos em até 5 s), corte seco. Alternativa maior: gesto de chegada escalonado de 520 ms (animate). Fade de 180 ms na capa lazy das grades.
- **Trade-off:** costura cor e conteúdo, contra a regra "próxima não anima" (a proposta anima o conteúdo, não o controle) e o custo de camadas sobre o canvas de 2 MP. **Custo:** M. **Comandos:** animate, delight, overdrive.
- **Recomendação:** só o crossfade de capa fora de rajada, com fps medido antes de entrar.

### B11. Direção A: "a capa voa" da barra até o Now Playing
- **Tela:** Now Playing. FLIP da capa de 44 px até a de 200 px em 360 ms, meta entra com 80 ms de atraso; cinema (F) sai por `transform`; só crossfade sob reduced-motion. Junto: decidir a transição de tela (hoje fade de 250 ms com 6 px em toda rota; animate quer 140 ms só opacidade, overdrive quer 360 ms).
- **Trade-off:** o momento autoral do app, contra a medição junto com a transição do fundo (que B6 elimina). **Custo:** M. **Comandos:** overdrive, animate.
- **Recomendação:** depois de B6, com protótipo; nas rotas de trabalho, fade só de opacidade.

### B12. Direção B: a letra assenta com mola e anuncia a próxima linha; seek mostra o verso
- **Tela:** Now Playing e barra. Mola via `linear()` (conferir suporte no WebKitGTK 2.52) e `is-next` 400 ms antes do verso; no seek, hover mostra o tempo e o verso daquele ponto (letra movida para `store/lyrics.ts`).
- **Trade-off:** barata e de uso diário, contra depender de LRC bem alinhado. **Custo:** S (letra) / M (seek). **Comandos:** overdrive.
- **Recomendação:** a parte da letra junto de A22; o seek com verso depois.

### B13. Chips de diagnóstico do Crate colapsados
- **Tela:** Crate. Depois de A12, os três status podem virar um ponto verde "fontes ok" (detalhe no `title`), e o chip da fonte com problema volta sozinho em âmbar/rosa.
- **Trade-off:** barra limpa, contra esconder o estado do token do SoundCloud que você confere às vezes. **Custo:** S. **Comandos:** critique, quieter, distill, harden.
- **Recomendação:** ponto único "fontes ok", chip só na falha.

### B14. Fundo das telas de trabalho mais escuro
- **Tela:** Home, Stations, Crate. Opacidade do ambient de 0,80 para ~0,55 e saturate 0,75 (quieter), ou token `--bg-ambient-opacity` (colorize).
- **Trade-off:** mais calma atrás do texto, contra a assinatura; conflita com o valor do `DESIGN.md`. **Custo:** S. **Comandos:** quieter, colorize.
- **Recomendação:** não; A5 resolve a leitura sem tocar no fundo.

### B15. Preenchimento do progresso no acento da capa
- **Tela:** barra do player. **Trade-off:** o controle mais olhado ganha a cor da faixa, contra ampliar o papel do acento além de "ligado, atual, foco" (o `DESIGN.md` define carbono 3). **Custo:** S. **Comandos:** bolder.
- **Recomendação:** não; A15 resolve o contraste.

### B16. Sinais ok/aviso/erro e tons das stations com mais croma
- **Tela:** Crate, barra do player, Stations. **Hoje:** #809078 / #908870 / #8b7575 diferem por poucos graus num ponto de 6 px; os oito tons diferem do neutro em ~2 %. **Trade-off:** varredura por cor, contra a descrição "apagados" do `DESIGN.md` e a Moldura Quieta. **Custo:** S / M. **Comandos:** colorize.
- **Recomendação:** não mexer na cor; diferenciar erro por forma (ícone) e deixar os tons para o caso de B1 não vir.

### B17. Reflow do desktop para janela menor
- **Tela:** barra do player, Stations, Crate. Só 2 media queries de largura em 4.400 linhas; a janela vai a 960x600. Propostas: barra do player abaixo de 1180 px (pílula técnica escondida, trilho de volume 64 px), destaque da Stations empilhado abaixo de 1100 px, gutter em `clamp(20px, 3.2vw, 40px)`, camada `pointer: coarse`, Tweaks com `vh` dividido pelo zoom. **Custo:** S a M. **Comandos:** adapt, layout.
- **Recomendação:** só se você redimensiona a janela (P8); se sim, começar pela barra do player.

### B18. Variante "cor da capa" no card de retomada
- **Tela:** Home. Fundo na cor dominante da capa (deriveInk até 4,5:1) e capa nítida de 112 px à direita, no lugar do blur com gradiente preto. Muda a receita do `DESIGN.md`. **Custo:** S/M. **Comandos:** overdrive.
- **Recomendação:** não agora; A6 resolve o contraste.

### B19. Now Playing: compor o bloco capa + título embaixo; ficha com mais hierarquia
- **Tela:** Now Playing. Ancorar o bloco embaixo (composição de pé) e ficha a 12 px com a primeira linha em `--fg-2`/600. **Comandos:** layout, bolder. **Custo:** S.
- **Recomendação:** não ancorar; a ficha a 12 px com hierarquia de cor pode entrar como ajuste se você gostar no protótipo de B2.

### B20. Reforma tipográfica por tokens de papel
- **Tela:** global. 227 `font-size` no CSS em nove degraus entre 9,5 e 13,5 px (126 abaixo de 12 px); proposta de `--text-label`, `--text-meta`, `--text-body`, `--text-title` e compensação de texto claro sobre escuro (entrelinha, tracking, peso). **Custo:** L. **Comandos:** typeset.
- **Trade-off:** cumpre a Regra dos Três Tamanhos de verdade, contra aumento visível de rótulos e selos e risco em pílulas de altura fixa.
- **Recomendação:** leva própria depois de A14 e A24.

### B21. Card de letra cai para fundo sólido se o fps cair
- **Tela:** Now Playing. Medir fps com o card aberto (Tinta, Mandala); abaixo de 57 por 5 s, `data-lyrics-solid="on"` automático com nota no Tweaks. **Custo:** M. **Comandos:** optimize.
- **Recomendação:** medir primeiro; sem número, não mexer.

### B22. S24: folha do Now Playing segue o dedo; paisagem
- **Tela:** S24. Arrasto do `.np` com velocidade e mola, FLIP da capa do mini player; layout de paisagem. **Custo:** M cada. **Comandos:** overdrive, adapt.
- **Recomendação:** arrasto sim, numa leva do APK; paisagem não (sem uso).

### B23. Descoberta no ponto de uso
- **Tela:** barra lateral, Tweaks. Tooltip imediato (400 ms) com atalho no modo só-ícones; dica única na primeira abertura do Tweaks. **Custo:** S. **Comandos:** layout, onboard.
- **Recomendação:** tooltip sim; dica do Tweaks não (dono experiente).

## C. Descartado

| Proposta | Comando | Motivo |
|---|---|---|
| Feedback de pressão (`scale`) em play/pause, anterior e próxima | animate | O `DESIGN.md` (Buttons) diz "nunca animar play/pause ou próxima" e o `rustify-cto.md` diz que gesto repetido não anima; o `:active` nos chips, tiles e navegação entrou em A23. |
| Selo de formato na capa só quando há aviso de qualidade | distill | Contraria a decisão do CMR-297 (selo na capa e na ficha), sem fato novo. |
| Fundo das telas ambient a 30 fps | optimize | O critério de 60 fps medidos para o fundo animado é decisão registrada; B6 ataca o mesmo custo sem baixar a taxa. |
| Título em escala Feature (28 px) no card de retomada da Home | bolder | O `DESIGN.md` faz do Display a única palavra grande e reserva o Feature à Stations; a única ousadia permitida por tela é a do Now Playing. |
| Remover o painel da Stations sem substituto | distill (opção a) | Princípio 5 do `PRODUCT.md`: redesign nunca faz menos; o substituto está em B1. |

## O que não foi avaliado e como fechar

| Lacuna | Como fechar |
|---|---|
| Telas sem captura: Álbum, Artista, Playlists, Library (Álbuns, Artistas, Faixas), Search, Histórico, fila/QueueDrawer, Settings, Signal (curva do EQ estimada em 1,1:1), Tweaks aberto, paleta ⌘K aberta (só o JSON do detector), menu de contexto, diálogo Mover para playlist, SelectionBar | `scripts/impeccable/app_eval.sh capture` em cada rota com o app ocioso (o script devolve a rota original); `app_eval.sh detect` nas mesmas rotas (o detector só rodou na Home). |
| Estados não capturados: Crate com resultados (Soulseek, SoundCloud), aba Fila, prévia e página de artista da Tidal, Now Playing sem música, Now Playing com linha ativa e com título longo, Home com a Tinta rosa atrás da lista, downloads em andamento e prontos | Mesma captura, montando o estado pela ponte (`app_eval.sh js`) ou pedindo ao CEO 5 minutos sem usar o app. |
| Hover, foco de teclado, pressionado, lista aberta dos `<select>` (popup do GTK), arrasto do card de letra | Captura com o estado forçado pela ponte (`:focus-visible` via `element.focus()`, classe de hover simulada); a lista aberta do select só se vê no app real com o mouse. |
| Animação e ritmo: troca de rota, transição ambient/focused de 420 ms, trilho da letra, pulso do NOW PLAYING, kick do fundo | Gravação de tela da cmr-auto; PNG estático não serve. |
| Contraste medido por pixel: hero com capas variadas, letra sobre a Tinta, lista da Home sobre rosa, outras cenas (Relevo, Lorem, Mandala) e fundo 2D | Recortar as capturas novas e medir o pior ponto (o detector não mede texto sobre capa nem sobre fundo animado). Repetir com três capas (branca, preta, saturada). |
| Fonte: as capturas usam Baumans/Righteous (larguras e quebras diferentes; "VM" aparece como "UM") | Uma rodada de capturas com a Instrument Sans (fonte do sistema) antes de aprovar medidas de quebra e corte. |
| Outros temas além do Really Dark | Capturas com um tema claro e um escuro alternativo, principalmente para A1, A8 e A9. |
| Desempenho: fps do ambient e da troca de rota, custo do `filter: blur(8px)` de tela cheia, `backdrop-filter` do card de letra (até 32 px), temperatura da cmr-auto, tempo de abertura antes e depois de A25 | fps do Tweaks e tempos de quadro pela ponte a 1857x1048 com a máquina ociosa; `scripts/gl-bench` ganha `ambient=1`; critério: média de 58 ou mais e no máximo 2 % dos quadros acima de 20 ms. |
| Suporte do WebKitGTK 2.52: CSS `linear()`, View Transitions, `vh` sob o zoom do Tweaks, `prefers-reduced-motion` exposto pelo GTK | `app_eval.sh js 'return CSS.supports("transition-timing-function","linear(0,1)")'` e testes equivalentes; ligar "reduzir animação" no GNOME e ler `matchMedia`. |
| Janela menor (960x600) | Redimensionar pela ponte (`manage_window`) com o app ocioso e capturar barra do player, Stations e Crate. |
| S24 inteiro (`src/mobile/`): contraste, toque, folha do Now Playing, tabbar | `adb forward` + `impeccable detect --cdp` no WebView (caminho ainda não testado); `scripts/android/smoke_mobile.py` e `cdp_eval.py` com o aparelho desbloqueado e o app em primeiro plano (keyguard corta a rede, App Freezer congela o CDP). |
| Barra do player com pausa (tocando) e tempo parado em 0:00 por ~10 min entre as capturas, com a Home dizendo "pronta para retomar" | Verificar pela ponte se o player estava tocando (`ipc_get_backend_state` ou o snapshot do player); se não estava, é defeito do estado restaurado do `state.json`. |
| Telas sem snapshot do critique (o roteiro pede avaliações A e B isoladas e gravação em `.impeccable/critique/`) | Rodar `critique` de novo com o app livre, depois da leva 1, para ter a linha de tendência. |

## Perguntas para o CEO

1. **Stations:** troco os pontos sorteados do destaque pelas capas das faixas que geram a station, e tiro o "Your Mix" repetido da grade? *Recomendo sim.*
2. **Capa do Now Playing:** cresce de 200 px para cerca de 300 px no seu monitor (muda o `DESIGN.md`)? *Recomendo um protótipo no app, junto com o título que cede ao card de letra, e você aprova no olho.*
3. **Card "From your library" da Home:** passa a mostrar a descoberta do dia, tirada das recomendações que o app já calcula e hoje descarta? *Recomendo sim.*
4. **Letra sobre a Tinta:** se, depois da correção de contraste, a letra ainda não passar, aceito o vidro mais fumê só com o fundo WebGL ligado, passando por cima do slider "Lyrics glass"? *Recomendo sim, só como piso.*
5. **Marca da barra lateral:** o cassete do ícone do app em traço monocromático na cor do texto, ou com a etiqueta ferrugem? *Recomendo monocromático (segue a moldura quieta); a etiqueta seria uma cor fixa fora das três portas.*
6. **Chips de diagnóstico do Crate:** sempre visíveis, ou um ponto "fontes ok" e o chip da fonte só quando ela falha? *Recomendo o ponto único.*
7. **Ordem do overdrive:** C (desfoque do fundo na GPU, invisível, libera quadro), depois A (a capa voa até o Now Playing), com a parte da letra de B junto? E o pulso único ao curtir e o "rádio · descoberta" no chip? *Recomendo medir e fazer C primeiro, A como momento autoral, e sim para o pulso e para o chip.*
8. **Janela:** você redimensiona o Rustify no desktop ou ele fica sempre em tela cheia? *Se fica em tela cheia, o reflow (B17) sai da lista.*

## Plano sugerido

### Leva 1 (desktop, 0.2.97): itens A sem texto em lote

Ordem de execução, agrupada por arquivo, para tocar cada arquivo uma vez:

1. **`src/styles/extractor-lab.css`** (o grosso): A1 (selects e `option`), A2 (`.crate-banner[data-tone="rose"]`, campo de 40 px, `data-busy`), A3 (`.np__lyric` em `--fg-5`), A5 (`.row-list` com vidro), A6 (hero-tile: `text-align`, gradiente, brilho, eyebrow 11, tokens `--on-scrim`), A10 (`.st-card__name` clamp, `grid-auto-rows`, lixeira), A11 (`.np__specs` gap), A12 (`.crate-toolbar`, `.crate-net-status`), A14 (`--fs-label` e os tamanhos citados), A15 (trilho), A16 (bloco reduced-motion), A18 (`.row--no-album`), A19 (`.pb-tech--unmeasured`), A22 (`--ease-out`, `--ease-in`, `--dur-screen`, rail), A23 (`:active`).
2. **`src/tauri.ts`**: A1 (`colorScheme` em `applyTheme`).
3. **`src/views/crate/TidalTab.tsx`** + **`src-tauri/src/slsk/tidal_fila.rs`**: A2.
4. **`src/views/NowPlaying.tsx`** + **`src/lib/lyricsInk.ts`**: A3, A4, A11 (texto), A20, A22 (rAF trocado por efeito).
5. **`src/views/Home.tsx`**: A6 (`h2`), A7, A18 (classe).
6. **`src/components/Sidebar.tsx`** + asset: A8.
7. **`src/components/dsp/StationViz.tsx`** + **`EqCanvas.tsx`**: A9.
8. **`src/views/Stations.tsx`**: A10.
9. **`src/views/Crate.tsx`**: A12.
10. **`src/components/Titlebar.tsx`**: A14.
11. **`src/views/Tweaks.tsx`**: A13.
12. **`src/lib/format.ts`** (+ `Stations.tsx`, `CommandPalette.tsx`, `PlayerBar.tsx`): A17.
13. **`src/lib/quality.ts`** + **`src/components/PlayerBar.tsx`**: A19.
14. **`src/store/tweaks.ts`** + **`src/gl/signal.ts`**: A16 (fator de calma do fundo).
15. **`scripts/gen-icons.mjs`** + **`src/icons-offline.ts`**: A25.
16. **Tema `really-dark` na cmr-auto** (subagente `theme-maker`, fora do repo): A21.
17. **`DESIGN.md`** + sidecar `.impeccable/design.json`: atualizar o gradiente do hero-tile (A6), o rail e a curva (A22), `--fs-label` e os tokens novos.

Verificação da leva: `npm run typecheck`, testes do frontend (Home, Stations, NowPlaying, PlayerBar, Crate, TidalTab, lyricsInk, StationViz), `cargo check`; capturas antes e depois com `app_eval.sh capture` em Home, Now Playing, Stations e as duas abas do Crate; `app_eval.sh detect` sem `undersized-ui-text`; medir contraste no pior ponto de A3, A5 e A6; fps do Tweaks no Now Playing (critério de 60 fps). Bump de versão antes do `release.sh`; depois, `dpkg -i` na cmr-auto.

### Leva 2 (desktop): texto e tokens
- A24 (PT-BR, setas, jargão), com os testes que casam texto.
- A27 (tokens de espaçamento), com capturas nos dois modos de densidade.

### Leva S24 (APK)
- A26 (alvos de toque e tons), depois de testar `impeccable detect --cdp` via `adb forward`.

### Espera resposta
- B1 (mosaico da Stations), B2 (capa maior), B3/B4 (card e vidro da letra), B5 (descoberta do dia), B13 (chips do Crate), B17 (reflow, depende de P8).
- Medições antes de decidir: B6 (fundo ambient), B10 e B11 (movimento), B21 (card de letra sólido).
- Com recomendação de sim, aguardando OK: B7 (rádio · descoberta), B8 (chegada de download), B9 (pulso do like), B12 (letra com mola), B22 (arrasto no S24), B23 (tooltip da barra lateral).
- Com recomendação de não: B14, B15, B16, B18, B19 (ancoragem); B20 fica para leva própria.
