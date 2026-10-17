# Versão lossless de verdade para as 167 faixas marcadas: busca e medida na Tidal (17/10/2026, CMR-297)

**Pergunta:** das 167 faixas que a 0.2.93 marca como lossy por dentro, quantas têm na Tidal a mesma
gravação sem corte espectral, prontas para troca?
**Resposta curta:** 25. Em 112 a Tidal vende a mesma faixa com o mesmo problema (o MP3 está na origem,
não no nosso download), 29 não estão na Tidal e 1 a Tidal não deixa baixar.

Nada mudou no acervo da cmr-auto. As candidatas foram baixadas e medidas num staging da VM
(`~/tidal-upgrade/staging`, 30 FLAC, 976 MB); a troca depende da decisão do CEO (fim deste documento).

**Dados brutos:** `docs/contexto/17102026-troca-lossless-tidal.jsonl` (uma linha por faixa: identidade,
classe de hoje, cada candidata da Tidal com casamento, etiqueta e medida).
**Ferramentas:** `scripts/curator/upgrade_tidal.py` (listar, buscar, lotes, juntar; testes em
`test_upgrade_tidal.py`) e `tidal_mix_dl.py --ids ... --no-dedup --no-push` com `TIDAL_MUSIC_ROOT` no staging.

## Método

1. **Lista ao vivo**: Qdrant da cmr-auto (túnel 16333), `quality_class` em `lossy` (126) ou
   `provavel_lossy` (41). Tags reais lidas do arquivo por ssh (o índice guarda "Various" como artista de
   coletânea). Identidade: 9 curtidas, 87 com plays (450 no total), 156 com vibe, 120 com vetor de letra.
2. **Busca na Tidal** (sessão PKCE da VM): ISRC da tag (inclusive tag com vários códigos), depois texto
   "artista título" e "título". Mesma gravação = ISRC igual com duração a até 10 s, ou `title_key` igual
   (a do `tidal_mix_dl`, mais "(Original Mix)" como neutro) + artista PRINCIPAL em comum + duração a até
   4 s. O principal conta porque no funk o mesmo MC repete o verso em produções de outros DJs (caso real:
   "Meu Carro Não Tem Porta Luva" do Dj Mathy 044 casava pelo MC). Até 3 candidatas por faixa,
   preferindo álbuns diferentes. Três casamentos foram feitos à mão (título diferente na Tidal) e estão
   marcados `manual`: Henri Salvador "Zip a di dou da", DJ Piu "O Maluca" e "Rave DJ Piu X Rave DJ Ery".
3. **Mesma origem**: faixa que já veio da Tidal (COMMENT `source: tidal` ou pasta `[tidal]`) contra o
   mesmo lançamento é o mesmo stream que já mediu lossy. Não foi baixada de novo, exceto as 12 do
   "Pânico no Submundo" (DJ K), que entraram por erro de classificação e serviram de contraprova:
   mediram o mesmo corte, ao Hz.
4. **Download e medida**: 130 candidatas pelo `tidal_mix_dl.py` oficial; o portão de qualidade apagou
   97 com corte e gravou o corte; as 30 aceitas foram medidas de novo com `quality_audit.py scan`
   (30/30 `sem_corte`). 3 falharam (2 com stream só em AAC, 1 com erro 400 persistente).

## Resultado

| Resultado | Faixas |
|---|---|
| encontrada limpa (troca válida) | 25 |
| encontrada, mas lossy também na Tidal | 68 |
| só existe a mesma de origem (já lossy) | 44 |
| não encontrada na Tidal | 29 |
| não medida (a Tidal recusa o stream: Yung Buda "Lopes") | 1 |
| **total** | **167** |

| Playlist | Total | Limpa | Lossy na Tidal | Só a mesma | Não encontrada | Não medida |
|---|---|---|---|---|---|---|
| Funk Brasileiro | 103 | 4 | 44 | 31 | 24 | |
| Trance | 14 | 10 | 4 | | | |
| Rap & Trap Brasileiro | 12 | 1 | 2 | 8 | | 1 |
| Rap & Hip-Hop | 9 | 2 | 5 | | 2 | |
| Jazz | 6 | 3 | 3 | | | |
| Funk & Soul | 5 | 3 | 2 | | | |
| Eletrofunk | 5 | 1 | | 4 | | |
| Eletrônica | 4 | | 2 | | 2 | |
| Techfunk | 3 | | 3 | | | |
| Rock | 2 | | 2 | | | |
| Mega Funk | 2 | | | 1 | 1 | |
| Blues | 2 | 1 | 1 | | | |

Por classe de hoje: das 126 `lossy`, 8 têm troca; das 41 `provavel_lossy`, 17 têm troca.

### O que a medida mostra

- **No funk o MP3 está na origem.** 77 faixas têm na Tidal o MESMO corte da nossa (diferença de até
  400 Hz), 64 delas abaixo de 19,5 kHz, quase todas funk: DJ Piu (14), DJ K (12 + 3 no Techfunk), DJ
  Arana (10), DJ GB Faixa Preta (9), DJ LK de Itapê (6). A distribuidora entregou MP3 às lojas; o
  Soulseek só copiou. Para essas, não existe versão melhor em streaming. Só o produtor (SoundCloud
  original, Bandcamp) teria.
- **Corte em 20,0-20,6 kHz igual ao da fonte oficial em 13 faixas** (12 delas `provavel_lossy`): Roberta
  Flack (3 lançamentos da Tidal, todos 20,5 kHz), Billie Holiday, Etta James, Yussef Kamaal, Niko B, Cone
  Crew, ANNA, Catz 'n Dogz, Vini Vici, Mark Sixma. Testei a hipótese de que o degrau viesse do conversor
  de taxa da masterização: com um FLAC limpo de 24/48 (PinkPantheress, desta leva), os conversores
  comuns (ffmpeg swr e soxr) cortam em 21,4 kHz ou não deixam degrau (`sem_corte`), e o MP3 320 do mesmo
  arquivo corta em 20,1 kHz (`provavel_lossy`). **A hipótese não se confirma**: nessa faixa de
  frequência o detector não distingue master de MP3 320. O que fica provado é só que a versão vendida
  tem o mesmo corte da nossa.
- **Funk & Soul e Jazz antigos**: Funkadelic "Hit It and Quit It" tem 16,1 kHz nos dois lançamentos da
  Tidal; Sonny Boy Williamson "Help Me" tem um lançamento em 10,4 kHz, um só em AAC e um limpo (o "Blues
  Gold", usado na troca).
- **Hilight Tribe "Temple of Light"** (9 faixas, 5 curtidas, 138 plays): nossa cópia do Soulseek é 24/44
  com corte em 20,3 kHz; a da Tidal é 16/44 sem corte. É a maior parte do ganho desta leva.

### As 25 trocas válidas

Todas medidas `sem_corte` no staging. "Hoje" = classe e corte no acervo.

| Playlist | Faixa | Artista | Hoje | Tidal | Casamento | Like | Plays |
|---|---|---|---|---|---|---|---|
| Blues | Help Me | Sonny Boy Williamson | lossy 11,9 kHz, 24/48 | 16/44,1 | título | | |
| Eletrofunk | Stars (DJ Caio Prince & Adame DJ remix) | PinkPantheress | lossy 15,3 kHz, 24/48 | 24/48 | ISRC | | |
| Funk & Soul | Keep Moving | Tom Misch | provável 20,0 kHz, 16/44,1 | 16/44,1 | título | | 1 |
| Funk & Soul | Changes | Charles Bradley | lossy 17,2 kHz, 24/48 | 16/44,1 | título | | 1 |
| Funk & Soul | After The Storm | Kali Uchis | provável 20,5 kHz, 16/44,1 | 16/44,1 | título | | 2 |
| Funk Brasileiro | Rebelião | DJ Arana | lossy 16,1 kHz, 16/44,1 | 16/44,1 | ISRC | | 1 |
| Funk Brasileiro | O Maluca | DJ Piu | lossy 16,0 kHz, 16/44,1 | 16/44,1 | manual | | 1 |
| Funk Brasileiro | Putaria Rola Solta | DJ Piu | lossy 16,1 kHz, 16/44,1 | 16/44,1 | título | | 1 |
| Funk Brasileiro | Rave DJ Piu X Rave DJ Ery (Remix) | DJ Piu | provável 20,0 kHz, 16/44,1 | 16/44,1 | manual | | 3 |
| Jazz | Zip a di dou da | Henri Salvador | lossy 16,1 kHz, 16/44,1 | 16/44,1 | manual | | |
| Jazz | Manhattan | Dinah Washington | provável 20,1 kHz, 16/44,1 | 16/44,1 | título | | |
| Jazz | Relaxing With Lee | Dizzy Gillespie, Charlie Parker | provável 20,6 kHz, 24/48 | 16/44,1 | ISRC | | |
| Rap & Hip-Hop | Headshots (4r Da Locals) | Isaiah Rashad | lossy 19,1 kHz, 16/44,1 | 16/44,1 | ISRC | | 14 |
| Rap & Hip-Hop | Am I Wrong | Anderson .Paak | provável 20,4 kHz, 24/44,1 | 16/44,1 | título | | 8 |
| Rap & Trap Brasileiro | Mitsubishi | Orochi, Kizzy | provável 20,1 kHz, 24/48 | 16/44,1 | título | | |
| Trance | Trippin Out | Burn In Noise, Menog | provável 20,3 kHz, 16/44,1 | 16/44,1 | título | | 8 |
| Trance | Wind Raker | Hilight Tribe | provável 20,3 kHz, 24/44,1 | 16/44,1 | título | sim | 23 |
| Trance | Eagle Eye | Hilight Tribe | provável 20,3 kHz, 24/44,1 | 16/44,1 | título | | 11 |
| Trance | Rainbow Serpent | Hilight Tribe | provável 20,3 kHz, 24/44,1 | 16/44,1 | título | | 10 |
| Trance | Esperanza | Hilight Tribe | provável 20,3 kHz, 24/44,1 | 16/44,1 | título | sim | 17 |
| Trance | Inti Raymi | Hilight Tribe | provável 20,3 kHz, 24/44,1 | 16/44,1 | título | sim | 10 |
| Trance | Gayatri | Hilight Tribe | provável 20,3 kHz, 24/44,1 | 16/44,1 | título | | 15 |
| Trance | High Jump | Hilight Tribe | provável 20,3 kHz, 24/44,1 | 16/44,1 | título | sim | 12 |
| Trance | Didge Kaida | Hilight Tribe | provável 20,3 kHz, 24/44,1 | 16/44,1 | título | | 19 |
| Trance | Temple of Light | Hilight Tribe | provável 20,3 kHz, 24/44,1 | 16/44,1 | título | sim | 21 |

Identidade em jogo nas 25: 5 curtidas, 178 plays (19 faixas com plays). Os 3 casamentos `manual` pedem
conferência de ouvido antes da troca. Várias versões limpas vêm de coletânea ou trilha ("Blues Gold",
"The Edge of Seventeen", "ride with me"): a troca deve manter as tags e a capa ANTIGAS (só o áudio muda),
senão a faixa muda de álbum na tela.

### Não encontradas (29)

- 15 do "Baile Da China" (2020, Dj Pivete/Jeffinho/Ricardinho): ISRC QZNWU20019xx não existe na Tidal.
- 6 originais MP3 do piloto SoundCloud de 12/10 (DJ Arana x2, DJ Blakes, DJ Gui Marques, DJ Rogerinho do
  Querô, Adame DJ "Job"): só existem no SoundCloud.
- Kendrick Lamar "Cartoon & Cereal" e "Black Friday" (lançamentos grátis, fora das lojas); DJ CARLOZS
  "Mega do Crosstalk"; Humildes "Clarice me perdoa por isso"; DJ Piu "Catucadão"; DJ Luan Mark "Mega Funk
  del Rey"; Cloonee "Sippin' Yak" e Ben Kim "Somebody To Love" (a Tidal só tem a edição curta, não a
  extended que temos).

## Pergunta do CEO: vale manter o SoundCloud no Crate?

Sim. Com a 0.2.93 nada abaixo de FLAC 16/44,1 entra por ele: MP3 é recusado no card, antes de baixar
("não entra (só lossless)"), e WAV/FLAC com corte é recusado ao chegar. O que se mede é o rendimento:

- Piloto de 12/10 (17 faixas, arquivo original logado): 8 lossless de verdade (47%), 6 originais MP3
  (4 deles MP3 128 regravado como 320), 1 WAV com MP3 por dentro (MAC10TA "Bruxaria do Beco da Morte",
  16,1 kHz, mesmo com "-wav" no link) e 2 sem download. Hoje os 7 lossy seriam recusados na porta.
- Funk que entrou por SoundCloud/Bandcamp desde 11/10: 5% com corte, contra 15% da Tidal e 43% do
  Soulseek (relatório de 15/10).
- As 6 faixas MP3 do piloto não existem na Tidal (busca de hoje): para esse funk o produtor é a única fonte.

Custo de manter: cliques perdidos em metade das tentativas. Ganho: a fonte mais limpa do funk e a única
de parte dele.

## Opções levadas ao CEO: como trocar as 25

O que muda no uso é igual nas duas opções: a faixa continua no mesmo álbum, com o mesmo like, os mesmos
plays e a mesma vibe, e a pílula da barra passa de "Lossy 20,3 kHz" para "FLAC 16/44". O app refaz sozinho
o vetor de som (áudio novo) e o de letra. A diferença está no disco e no Soulseek.

**(a) Sobrescrever no mesmo caminho.** Script: o arquivo antigo vai para uma quarentena fora do `~/Music`
na cmr-auto, o novo entra no lugar com as tags e a capa antigas. O id (hash do caminho) não muda, então
nada fica órfão, nem no S24. Contra: o arquivo da Tidal fica fora de pasta `[tidal]` e entra no
compartilhamento do Soulseek, contra a regra "nada da Tidal vai pro Soulseek". Contornar exigiria uma
lista de exceções por arquivo no `slskd.yml`, um segundo mecanismo que alguém esquece.

**(b) Pasta `[tidal]` com migração de id (recomendada).** Mesma troca de áudio da (a), seguida de um
renomear da pasta do álbum para `<Álbum> [tidal]` feito pelo próprio indexador, com a maquinaria do
"Mover para playlist" (`relocate.rs`: journal, payload, vetores, enrichment, plays). A regra do Soulseek
se cumpre pelo mecanismo que já existe, e o MP3 antigo sai do compartilhamento. Custos: (1) código
novo no mover (hoje ele só troca a pasta de 1º nível) e uma release com `dpkg -i`; (2) o id das 25 muda,
com a dívida do S24 já registrada no CMR-298: plays e likes que o celular registrar com o manifest antigo
ficam presos ao id apagado. Mitigação: reexportar o manifest e fazer o push logo depois da troca. (3) Em
álbum trocado em parte, o disco fica com duas pastas ("This Is DJ Piu" e "This Is DJ Piu [tidal]"); a
tela continua com um álbum só, porque agrupa pelas tags.

Recomendação: (b). A regra do Soulseek é decisão do CEO, e a (a) só a cumpre com um controle paralelo
frágil. Além disso o mesmo comando serve para as próximas trocas do CMR-297 (versão melhor que surgir
depois), em vez de um script de uso único.

## Decisão e execução (17/10/2026)

O CEO escolheu a **(a)**: sobrescrever no mesmo caminho, com quarentena do original, aceitando que o
arquivo da Tidal entre no share do Soulseek. Em seguida: "todas do tidal têm que estar nos mesmos caminhos
normais, como se fossem tracks normais". O alcance dessa frase (só estas faixas, ou também as 351 em
pasta `[tidal]` e os downloads novos) ficou para confirmar.

Execução:

1. **Mesma gravação, medida antes de trocar** (impressão digital Chromaprint pelo ffmpeg, melhor
   alinhamento em ±15 s, fração de bits iguais; controle com gravações diferentes: 0,55-0,62). 23 de 25
   entre 0,88 e 1,00, inclusive os casamentos manuais "O Maluca" (0,93, lido pelo GStreamer: o FLAC antigo
   tem lixo antes do primeiro quadro e o ffmpeg não o decodifica) e "Rave DJ Piu X Rave DJ Ery" (0,985).
   **Ficaram de fora, esperando o ouvido do CEO**: Sonny Boy Williamson "Help Me" (0,77; a da Tidal é
   mono puro, a nossa tem leve estéreo de ruído) e Henri Salvador "Zip a di dou da" (0,72; o remaster de
   2021 é estéreo, o nosso é praticamente mono). Os pares estão em `~/cmr297-ouvir/` na cmr-auto.
2. **Arquivo montado**: áudio da Tidal com as tags e as imagens do arquivo antigo (título, artista,
   álbum, número, data, gênero e capa idênticos, conferidos nos 23); saem ReplayGain, LENGTH e ENCODER do
   antigo; entram ISRC (se faltava) e um COMMENT `source: tidal ...; troca CMR-297 em 17/10/2026 no mesmo
   caminho, antes corte X kHz` (sem a palavra "lossy", que o `quality_audit.py` leria como lossy
   declarado). Os 23 medidos de novo: `sem_corte`.
3. **Letra sincronizada**: deslocamento medido por correlação do envelope (precisão de 10 ms), conferido
   com a impressão digital. "Rebelião" tinha `.lrc` alinhado à cópia velha e a versão da Tidal começa
   12,07 s depois: a letra foi deslocada (original na quarentena). "Changes" já usava a letra do lrclib da
   versão de streaming (agora fica certa; antes aparecia 1 s adiantada). "Keep Moving" só tem o aviso
   "esta música não possui letra".
4. **Troca na cmr-auto**: original copiado para `~/quarentena-lossy/<caminho>` com sha256 conferido; o
   novo veio de uma pasta de entrada no mesmo disco e foi renomeado por cima (atômico). 24 arquivos (23
   FLAC + 1 `.lrc`), 0 falhas. O watcher viu "modificado" e reescaneou.
5. **Conferido no índice** (antes x depois, mesmo id): 23/23 com caminho e tags iguais, like e vibe
   (`track_enrichments`) idênticos, plays iguais (178), classe `sem_corte`, vetor de som refeito do áudio
   novo (23/23 `done`). O vetor de letra das 15 que o tinham saiu na regravação do ponto e volta no
   backfill do próximo boot do app.
6. **Soulseek**: share reescaneado (3.396 arquivos); as 21 trocadas fora de pasta `[tidal]` estão nele,
   como decidido; nenhuma pasta `[tidal]` aparece (as 2 trocadas que já moravam em pasta `[tidal]`,
   "Relaxing With Lee" e "Mitsubishi", continuam fora).

Desfazer uma troca: `mv ~/quarentena-lossy/<caminho> ~/Music/<caminho>` na cmr-auto (o app reindexa pelo
mesmo id). Cópia extra dos 25 originais na VM em `~/tidal-upgrade/antigas/`.

## Faixas da Tidal no caminho normal (17/10/2026, 0.2.94)

Depois da troca o CEO decidiu que **toda faixa da Tidal mora no caminho normal**, renomeando as pastas
antigas e aceitando o custo no S24. Feito no mesmo dia:

- **App (0.2.94)**: o mover ganhou o alvo `MoveTarget::UnmarkTidal { playlist }` e o comando
  `lib_unmark_tidal`: mesma playlist, a pasta do álbum perde o ` [tidal]`, e o id novo leva payload,
  vetores, letra externa, like/vibe e plays, com o journal de queda do "Mover para playlist". Testes:
  regra de destino (5 casos) e ciclo completo contra o Qdrant da VM.
- **Renomeação**: 351 faixas em 309 pastas, sete playlists (Funk Brasileiro 152, Rap & Trap Brasileiro
  102, Jazz 60, Eletrofunk 26, Mega Funk 7, Eletrônica 3, MPB 1), disparadas pela ponte em lotes de até
  50, depois de um ensaio com a faixa de MPB. Relatórios do app: 351 movidas, 0 falhas. Auditoria
  externa (`move_audit.py verify --dest :sem-tidal`, foto tirada antes): 351/351 ok. Disco: 0 pastas e 0
  arquivos com `[tidal]`; journal de queda vazio. Só "Speak No Evil" (Wayne Shorter) se juntou a uma
  pasta que já existia, sem duplicata.
- **Antes de renomear**: o boot da 0.2.94 refez o vetor de letra de 14 das 15 trocadas; "Manhattan"
  (Dinah Washington) tinha a letra só no índice, no campo da letra das tags (leva antiga, anterior à
  regra da 0.2.71), e a regravação do ponto a perdeu: restaurada em `lyrics_text` a partir da foto (o
  vetor vem no próximo boot).
- **Soulseek**: filtro `'\[tidal\]'` removido do `slskd.yml` (cópia `slskd.yml.bak-cmr297-20261017`);
  share reescaneado: 3.396 para 4.242 arquivos (as 351 com letras e capas).
- **Baixador**: `tidal_mix_dl.py` não cria mais a marca e a dedup remota lista todos os FLAC; a página
  da fila (reiniciada) mostra a cobertura do acervo inteiro.
- **S24**: não estava no USB. O manifest do celular é de 11/09; até reexportar, plays e likes dessas
  351 faixas que ele sincronizar ficam no id antigo (custo aceito pelo CEO).

## Próximos passos

1. CEO ouve os 2 pares em espera e decide se troca (o staging da VM guarda as duas versões da Tidal).
2. S24 no USB: rodar o encode do acervo, `export_manifest.py --deploy` e `phone_push_retry.sh`.
3. Soulseek para as 29 não encontradas e as 112 lossy na Tidal: rendimento esperado baixo (no funk as
   cópias da rede vêm da mesma origem MP3); se for tentar, pelo Crate ([Trocar fonte]), respeitando o
   teto de 40 buscas por hora.
4. Funk lossy na origem: o caminho é o produtor (SoundCloud original, Bandcamp), faixa a faixa.
