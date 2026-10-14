# Funk Brasileiro pelo som (MERT): resultado da validação (CMR-299)

Data: 14/10/2026. Script: `scripts/curator/funk_mert_classify.py`. Testes:
`python3 scripts/curator/test_funk_mert_classify.py` (11 testes, precisa de numpy).
JSON irmão: `docs/contexto/14102026-funk-mert-classificacao.json` (formato da proposta).

## Resumo em uma frase

**O som do MERT, do jeito que está no acervo, não separa os subgêneros do funk.** A
validação deu 35% de acerto, longe da meta de 90%. Nenhuma faixa ganhou confiança
"alta" ou "media" pelo MERT. O plano de mudança continua dependendo da proposta por
artista e da sua revisão.

## Método (curto)

1. Li as 2199 faixas do Qdrant da cmr-auto (só leitura). Todas têm vetor MERT.
2. Âncoras = faixas que você aprovou (linhas "alta" da proposta: 257 faixas, 49 artistas)
   e as playlists que já existem: Rap & Hip-Hop (679), Eletrônica (168), MPB (94),
   Country & Folk (7).
3. Techfunk não tem linha "alta". Usei as 2 linhas "media" (Radio libertadora,
   CyberKills; 12 faixas) como âncoras provisórias.
4. Cada faixa não aprovada (173) olha as 7 âncoras mais parecidas. Cada vizinha vota
   no seu destino com peso igual à semelhança. Margem = diferença entre o 1º e o 2º.
5. Subtraí a média do acervo antes de comparar. Sem isso, toda faixa parece com toda
   faixa (semelhança média de 0,80).
6. Validação: para cada artista aprovado, tirei TODAS as faixas dele e vi se os
   vizinhos restantes acertam o destino. Tirar só a faixa vazaria: faixas do mesmo
   artista são quase gêmeas no MERT.

## Validação (meta: 90%)

| Grupo de âncoras | Acerto |
|---|---:|
| Funk aprovado por você (257 faixas) | **90/257 = 35%** |
| Playlists externas (948 faixas) | 803/948 = 85% |
| Techfunk provisório (12 faixas) | 0/12 = 0% |

Acerto por destino, só no funk aprovado:

| Destino aprovado | Acerto | Para onde o MERT mandou |
|---|---:|---|
| Funk Brasileiro (223) | 90 (40%) | Rap & Hip-Hop 102, Eletrônica 27, MPB 3, Mega Funk 1 |
| Eletrofunk (24) | 0 (0%) | Eletrônica 12, Rap & Hip-Hop 11, Funk Brasileiro 1 |
| Mega Funk (9) | 0 (0%) | Rap & Hip-Hop 4, Eletrônica 3, Funk Brasileiro 2 |
| MPB (1, Marina Sena) | 0 | Rap & Hip-Hop 1 |

Externas: Rap 612/679, Eletrônica 131/168, MPB 60/94, Country & Folk 0/7.

**A margem não ajuda.** Mesmo quando os 7 vizinhos concordam (margem acima de 0,8), o
acerto é 36%. Por faixa de margem: 31%, 41%, 29%, 33%, 40%, 36%. Por isso a
calibração não achou limiar nenhum: tudo que o MERT classificou sai "baixa".

## O que eu testei antes de concluir (registrado, nada foi ajustado para "passar")

Mesma validação (tirando o artista inteiro), medida no funk aprovado:

| Variante | Acerto | Acerto médio por destino |
|---|---:|---:|
| k=7, média subtraída, com externas (**o método usado**) | 35% | 10% |
| k=7, vetor cru (sem subtrair a média) | 22% | 6% |
| k=7, voto dividido pelo tamanho da classe | 30% | 21% |
| Centroide por destino | 34% | 19% |
| k=7 só entre Funk Brasileiro / Eletrofunk / Mega Funk | 87% | 36% |
| Idem, voto dividido pelo tamanho da classe | 48% | 49% |
| Classificador linear (ridge, teste à parte; melhor regularização) | 46% (54% só funk) | 22% (41% só funk) |

- k de 3 a 15 dá 32% a 37%. Mantive k=7.
- O 87% "só funk" é ilusão: ele chama quase tudo de Funk Brasileiro (221/223) e erra
  todo Eletrofunk (2/24) e todo Mega Funk (0/9).
- **Teste de sanidade do próprio vetor:** com o mesmo método, separar as playlists
  grandes do acervo entre si dá Rap 74%, Funk Brasileiro 57%, Jazz 52%, Rock 51%,
  Eletrônica 51%, MPB 36%, Trance 25%, Funk & Soul 21%. Ou seja: nem Jazz contra Rock
  o MERT separa bem quando o artista some.

**Por quê (medido à parte).** A semelhança dentro do mesmo artista (0,13 no funk, 0,24 no Mega Funk) é
2 a 5 vezes maior que entre artistas do mesmo subgênero (0,03 a 0,09). O vetor guarda
"quem gravou / como foi mixado" muito mais do que "que estilo é". Com o artista fora,
sobra quase nada de estilo. Hipótese não verificada: o vetor pode ter sido calculado em
um trecho curto da faixa, ou numa camada do MERT que não é a melhor para gênero.

## Techfunk: a classe não se sustenta

- As duas âncoras provisórias não se parecem entre si: semelhança média entre Radio
  libertadora e CyberKills = **-0,02** (abaixo de zero).
- Elas se parecem mais com o Funk Brasileiro aprovado (0,05) do que com a outra
  âncora de Techfunk.
- Contra a playlist Trance (referência de "techno/trance de fato"): 0,005. Igual ao
  funk aprovado contra Trance (-0,01). Nada as aproxima do techno.
- Na validação, nenhuma das 12 voltou para Techfunk: Rap 5, Funk Brasileiro 4,
  Eletrônica 3.
- Ressalva: são só 2 artistas e 12 faixas, e o vetor mostrou que não separa estilo.
  O MERT não confirma Techfunk; também não serve para negar com segurança.

## Contagem por destino (442 faixas)

| Destino | Proposta (por artista) | MERT puro, faixa a faixa | Plano do JSON novo (padrão: confiança >= media) |
|---|---:|---:|---:|
| Funk Brasileiro (fica) | 361 | 145 | 408 |
| Eletrofunk | 46 | 0 | 24 |
| Mega Funk | 10 | 3 | 9 |
| Techfunk | 16 | 0 | 0 |
| Eletrônica | 4 | 85 | 0 |
| Rap & Hip-Hop | 2 | 205 | 0 |
| MPB | 2 | 4 | 1 |
| Country & Folk | 1 | 0 | 0 |

- "MERT puro" = o voto de cada faixa (para as aprovadas, o voto na validação). Ele
  manda quase metade do funk para Rap & Hip-Hop. Isso não é achado musical: é o
  mesmo erro da validação.
- "Plano do JSON novo" = o que `funk_split_plan.py` gera hoje com o JSON novo: só move
  as linhas que você aprovou (Eletrofunk 24, Mega Funk 9, MPB 1). Todo o resto fica
  em Funk Brasileiro até decisão sua. Com `--min-confidence baixa` ele seguiria o
  MERT (Rap 105, Eletrônica 31, Eletrofunk 24, Mega Funk 11, MPB 2). **Não usar.**

## Recomendação

1. Não mover nada com base no MERT.
2. Mover agora só o que você já aprovou (as linhas "alta"): o JSON novo faz isso.
3. Para o resto, a decisão volta para a proposta por artista + sua escuta, ou para
   outro sinal (BPM, letra, tags).
4. Vale investigar o próprio vetor MERT do app (trecho e camada usados), porque ele
   também alimenta o rádio e as estações.

## Anomalias nos dados

- Nenhuma faixa sem vetor MERT (442/442 no funk; 948/948 nas externas).
- Nomes das playlists externas batem com o esperado: `Eletrônica`, `MPB`,
  `Rap & Hip-Hop`, `Country & Folk`.
- 13 faixas estão soltas na pasta do artista, sem pasta de álbum. Não atrapalha.
- A linha "Gal Costa" (todos) da proposta não cobre faixa nenhuma: a única faixa da
  Gal está na linha do álbum "Azul (Illusionize & Linkage Remix) [tidal]".
- Pastas que são o mesmo artista com grafia diferente ("DJ Anderson do Paraiso" /
  "Paraíso", "Dj GBR" / "DJ GBR", "Mc Jacare" / "Jacaré"): na validação contam como um
  artista só.
- Rap & Hip-Hop tem 679 faixas contra 223 do funk aprovado. Esse desequilíbrio pesa,
  mas a variante que compensa o tamanho também falhou (30%).

## Como ler as tabelas abaixo

Colunas: pasta, destino da proposta (confiança), destino MERT, margem (0 = empate,
1 = unânime), nº de faixas, voto faixa a faixa. Toda decisão MERT aqui é "baixa".

## Divergências contra a proposta (111 pastas, 253 faixas)

### Pastas que você aprovou e o MERT discorda (o destino aprovado vale; isto mede o erro do MERT): 36 pastas, 106 faixas

| Pasta | Proposta | MERT | Margem | Faixas | Voto faixa a faixa |
|---|---|---|---:|---:|---|
| OO Rubinho | Funk Brasileiro (alta) | Rap & Hip-Hop | 0.19 | 20 | Rap & Hip-Hop 12, Eletrônica 5, Funk Brasileiro 3 |
| D.A.N.V, DJ Kingdom, VKKramer | Funk Brasileiro (alta) | Rap & Hip-Hop | 0.06 | 12 | Rap & Hip-Hop 5, Eletrônica 4, Funk Brasileiro 3 |
| Syon Trio | Funk Brasileiro (alta) | Rap & Hip-Hop | 0.19 | 9 | Rap & Hip-Hop 5, Eletrônica 3, Funk Brasileiro 1 |
| DJ Anderson do Paraiso | Funk Brasileiro (alta) | Rap & Hip-Hop | 0.51 | 8 | Rap & Hip-Hop 6, Funk Brasileiro 1, MPB 1 |
| MC Kevin o Chris / 2022 - Deixa Se Envolver (Spring Love) [Remixes Pt. 1] | Eletrofunk (alta) | Rap & Hip-Hop | 0.09 | 6 | Rap & Hip-Hop 3, Eletrônica 3 |
| DJ Petroski | Mega Funk (alta) | Eletrônica | 0.09 | 5 | Rap & Hip-Hop 2, Funk Brasileiro 2, Eletrônica 1 |
| Mc Livinho | Funk Brasileiro (alta) | Rap & Hip-Hop | 0.32 | 5 | Rap & Hip-Hop 4, Funk Brasileiro 1 |
| Illusionize | Eletrofunk (alta) | Eletrônica | 0.63 | 4 | Eletrônica 4 |
| DENNIS | Funk Brasileiro (alta) | Eletrônica | 0.09 | 3 | Funk Brasileiro 1, Eletrônica 1, MPB 1 |
| FatSync | Eletrofunk (alta) | Eletrônica | 0.81 | 3 | Eletrônica 3 |
| MC Kevin o Chris | Funk Brasileiro (alta) | Rap & Hip-Hop | 0.48 | 3 | Rap & Hip-Hop 2, Funk Brasileiro 1 |
| GP DA ZL | Funk Brasileiro (alta) | Rap & Hip-Hop | 0.01 | 2 | Funk Brasileiro 1, Rap & Hip-Hop 1 |
| MU540 | Eletrofunk (alta) | Rap & Hip-Hop | 0.63 | 2 | Rap & Hip-Hop 2 |
| Vintage Culture | Eletrofunk (alta) | Rap & Hip-Hop | 0.27 | 2 | Rap & Hip-Hop 2 |
| Alok, Mc Don Juan e DJ GBR | Eletrofunk (alta) | Rap & Hip-Hop | 0.73 | 1 | Rap & Hip-Hop 1 |
| Classmatic | Eletrofunk (alta) | Eletrônica | 0.44 | 1 | Eletrônica 1 |
| DJ Anderson do Paraíso | Funk Brasileiro (alta) | Rap & Hip-Hop | 0.30 | 1 | Rap & Hip-Hop 1 |
| DJ Fernando Souza | Mega Funk (alta) | Rap & Hip-Hop | 0.15 | 1 | Rap & Hip-Hop 1 |
| DJ GBR | Funk Brasileiro (alta) | Eletrônica | 0.14 | 1 | Eletrônica 1 |
| DJ Guuga / MEGA ELETRO FUNK - Last Night [tidal] | Eletrofunk (alta) | Rap & Hip-Hop | 0.42 | 1 | Rap & Hip-Hop 1 |
| DJ Luan Mark | Mega Funk (alta) | Eletrônica | 0.69 | 1 | Eletrônica 1 |
| DJ Maninho | Mega Funk (alta) | Rap & Hip-Hop | 0.56 | 1 | Rap & Hip-Hop 1 |
| Dubdogz | Eletrofunk (alta) | Rap & Hip-Hop | 0.02 | 1 | Rap & Hip-Hop 1 |
| Dyamante DJ | Funk Brasileiro (alta) | Rap & Hip-Hop | 0.35 | 1 | Rap & Hip-Hop 1 |
| Furacão 2000 | Funk Brasileiro (alta) | Eletrônica | 0.17 | 1 | Eletrônica 1 |
| KVSH | Eletrofunk (alta) | Eletrônica | 0.01 | 1 | Eletrônica 1 |
| Marina Sena | MPB (alta) | Rap & Hip-Hop | 0.27 | 1 | Rap & Hip-Hop 1 |
| MC Don Juan | Funk Brasileiro (alta) | Rap & Hip-Hop | 1.00 | 1 | Rap & Hip-Hop 1 |
| MC Fioti | Funk Brasileiro (alta) | Rap & Hip-Hop | 0.73 | 1 | Rap & Hip-Hop 1 |
| Mc Jacare | Funk Brasileiro (alta) | Eletrônica | 0.58 | 1 | Eletrônica 1 |
| Mc Jacaré / Eletrofunk Raiz [tidal] | Eletrofunk (alta) | Rap & Hip-Hop | 0.42 | 1 | Rap & Hip-Hop 1 |
| Mc Menor Mr, Mano Gothia, Mc Dutra Rg, Caio Passos, Mc Meno K, Mc Sartori, DJ Camarozano | Funk Brasileiro (alta) | Rap & Hip-Hop | 0.74 | 1 | Rap & Hip-Hop 1 |
| MC Th | Eletrofunk (alta) | Funk Brasileiro | 0.06 | 1 | Funk Brasileiro 1 |
| Papatinho | Funk Brasileiro (alta) | Rap & Hip-Hop | 0.73 | 1 | Rap & Hip-Hop 1 |
| petrus.wav | Funk Brasileiro (alta) | Eletrônica | 0.18 | 1 | Eletrônica 1 |
| TAIDigital | Mega Funk (alta) | Eletrônica | 0.19 | 1 | Eletrônica 1 |

### Techfunk provisório: 2 pastas, 12 faixas

| Pasta | Proposta | MERT | Margem | Faixas | Voto faixa a faixa |
|---|---|---|---:|---:|---|
| [2025] Radio libertadora! | Techfunk (media) | Funk Brasileiro | 0.10 | 11 | Rap & Hip-Hop 4, Funk Brasileiro 4, Eletrônica 3 |
| CyberKills | Techfunk (media) | Rap & Hip-Hop | 0.00 | 1 | Rap & Hip-Hop 1 |

### Pastas não aprovadas (MERT sugere outro destino, sempre com confiança baixa): 73 pastas, 135 faixas

| Pasta | Proposta | MERT | Margem | Faixas | Voto faixa a faixa |
|---|---|---|---:|---:|---|
| Humildes | Funk Brasileiro (media) | Rap & Hip-Hop | 0.21 | 22 | Rap & Hip-Hop 13, Funk Brasileiro 7, Eletrônica 2 |
| Various Artists | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.16 | 11 | Rap & Hip-Hop 7, Funk Brasileiro 2, Eletrônica 2 |
| BadSista | Funk Brasileiro (media) | Rap & Hip-Hop | 0.06 | 6 | Rap & Hip-Hop 3, Funk Brasileiro 2, Eletrônica 1 |
| Pedro Sampaio | Funk Brasileiro (media) | Rap & Hip-Hop | 0.00 | 6 | Eletrônica 3, Rap & Hip-Hop 2, Funk Brasileiro 1 |
| DJ Johnny Souza | Funk Brasileiro (media) | Eletrônica | 0.10 | 5 | Funk Brasileiro 3, Eletrônica 1, Rap & Hip-Hop 1 |
| DJ Zigão | Funk Brasileiro (media) | Rap & Hip-Hop | 0.14 | 4 | Rap & Hip-Hop 3, Funk Brasileiro 1 |
| Kioma, Buarky, kLap e Mu540 | Eletrofunk (media) | Rap & Hip-Hop | 0.04 | 4 | Rap & Hip-Hop 2, Eletrônica 2 |
| Dj Luan Gomes | Funk Brasileiro (media) | Rap & Hip-Hop | 0.47 | 3 | Rap & Hip-Hop 3 |
| Beltran | Eletrofunk (media) | Eletrônica | 0.50 | 2 | Eletrônica 2 |
| Bronka / Electric Baile [tidal] | Eletrofunk (baixa) | Eletrônica | 0.72 | 2 | Eletrônica 2 |
| DJ Guuga | Funk Brasileiro (media) | Rap & Hip-Hop | 0.21 | 2 | Rap & Hip-Hop 1, Funk Brasileiro 1 |
| FBC | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.09 | 2 | Rap & Hip-Hop 1, Eletrônica 1 |
| Felipe Amorim | Funk Brasileiro (media) | Rap & Hip-Hop | 0.25 | 2 | Rap & Hip-Hop 2 |
| Flux Zone | Techfunk (baixa) | Rap & Hip-Hop | 0.28 | 2 | Rap & Hip-Hop 2 |
| Kyan | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.27 | 2 | Rap & Hip-Hop 2 |
| L7NNON | Funk Brasileiro (media) | Rap & Hip-Hop | 0.25 | 2 | Rap & Hip-Hop 2 |
| PinkPantheress | Eletrofunk (media) | Rap & Hip-Hop | 0.73 | 2 | Rap & Hip-Hop 2 |
| AKALEX | Eletrofunk (baixa) | Eletrônica | 0.67 | 1 | Eletrônica 1 |
| Andruss | Eletrofunk (media) | Mega Funk | 0.25 | 1 | Mega Funk 1 |
| Astrophysics | Techfunk (baixa) | Funk Brasileiro | 0.15 | 1 | Funk Brasileiro 1 |
| ATANA | Eletrofunk (media) | Eletrônica | 0.74 | 1 | Eletrônica 1 |
| Bellaire | Eletrofunk (media) | Rap & Hip-Hop | 0.11 | 1 | Rap & Hip-Hop 1 |
| Bronka / BRONKA SUCKS [tidal] | Funk Brasileiro (baixa) | Eletrônica | 0.40 | 1 | Eletrônica 1 |
| CHAMOS | Eletrofunk (media) | Funk Brasileiro | 0.31 | 1 | Funk Brasileiro 1 |
| Dave Nunes | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.25 | 1 | Rap & Hip-Hop 1 |
| Dennis & Friends (2020) | Mega Funk (media) | Eletrônica | 0.60 | 1 | Eletrônica 1 |
| Dj Aguilar | Funk Brasileiro (media) | Rap & Hip-Hop | 0.28 | 1 | Rap & Hip-Hop 1 |
| Dj Duarte | Funk Brasileiro (media) | Rap & Hip-Hop | 0.27 | 1 | Rap & Hip-Hop 1 |
| Dj Gbr | Funk Brasileiro (media) | Rap & Hip-Hop | 0.27 | 1 | Rap & Hip-Hop 1 |
| DJ Gui Marques | Funk Brasileiro (media) | Rap & Hip-Hop | 0.05 | 1 | Rap & Hip-Hop 1 |
| DJ Holanda | Funk Brasileiro (media) | Rap & Hip-Hop | 0.27 | 1 | Rap & Hip-Hop 1 |
| DJ Léo da 17 | Funk Brasileiro (media) | Rap & Hip-Hop | 0.75 | 1 | Rap & Hip-Hop 1 |
| DJ NATAN 22 | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.30 | 1 | Rap & Hip-Hop 1 |
| Dj Nattan | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.75 | 1 | Rap & Hip-Hop 1 |
| DJ Patrick Muniz | Funk Brasileiro (media) | Rap & Hip-Hop | 0.26 | 1 | Rap & Hip-Hop 1 |
| DJ Ramon Sucesso | Funk Brasileiro (media) | Rap & Hip-Hop | 0.69 | 1 | Rap & Hip-Hop 1 |
| DJ Rogerinho do Querô | Funk Brasileiro (media) | Eletrônica | 0.57 | 1 | Eletrônica 1 |
| DJ SV | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.44 | 1 | Rap & Hip-Hop 1 |
| Dj THG | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.30 | 1 | Rap & Hip-Hop 1 |
| DJ Topo | Funk Brasileiro (media) | Rap & Hip-Hop | 0.46 | 1 | Rap & Hip-Hop 1 |
| DJ WIN | Funk Brasileiro (media) | Rap & Hip-Hop | 0.45 | 1 | Rap & Hip-Hop 1 |
| DJ Ws da Igrejinha | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.59 | 1 | Rap & Hip-Hop 1 |
| Don Low | Funk Brasileiro (baixa) | Eletrônica | 0.43 | 1 | Eletrônica 1 |
| Duquesa | Funk Brasileiro (media) | Eletrônica | 0.59 | 1 | Eletrônica 1 |
| Eddy M | Funk Brasileiro (baixa) | Eletrônica | 1.00 | 1 | Eletrônica 1 |
| Fezzo | Funk Brasileiro (baixa) | Eletrônica | 0.43 | 1 | Eletrônica 1 |
| Freenzy Music | Eletrofunk (baixa) | Eletrônica | 0.55 | 1 | Eletrônica 1 |
| Giu | Eletrofunk (baixa) | Eletrônica | 0.69 | 1 | Eletrônica 1 |
| Gordo | Eletrofunk (media) | Funk Brasileiro | 0.40 | 1 | Funk Brasileiro 1 |
| HUGEL | Eletrofunk (media) | Rap & Hip-Hop | 0.16 | 1 | Rap & Hip-Hop 1 |
| ilysam | Funk Brasileiro (baixa) | Eletrônica | 1.00 | 1 | Eletrônica 1 |
| JAUM, O GANG$TAR | Funk Brasileiro (media) | Rap & Hip-Hop | 1.00 | 1 | Rap & Hip-Hop 1 |
| Ladji Mouflet | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.30 | 1 | Rap & Hip-Hop 1 |
| Lou Garcia | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.04 | 1 | Rap & Hip-Hop 1 |
| Luan Pereira | Country & Folk (baixa) | Rap & Hip-Hop | 1.00 | 1 | Rap & Hip-Hop 1 |
| Mc Gabzin | Funk Brasileiro (media) | Rap & Hip-Hop | 0.34 | 1 | Rap & Hip-Hop 1 |
| MC Menor MT | Funk Brasileiro (media) | Mega Funk | 0.17 | 1 | Mega Funk 1 |
| MC Pogba | Funk Brasileiro (media) | Eletrônica | 0.58 | 1 | Eletrônica 1 |
| MC Saci | Techfunk (baixa) | Rap & Hip-Hop | 0.08 | 1 | Rap & Hip-Hop 1 |
| Meloko | Eletrofunk (media) | Eletrônica | 0.72 | 1 | Eletrônica 1 |
| Menor Teteu | Funk Brasileiro (media) | Rap & Hip-Hop | 0.71 | 1 | Rap & Hip-Hop 1 |
| Mulú | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.70 | 1 | Rap & Hip-Hop 1 |
| Niack | Funk Brasileiro (media) | Rap & Hip-Hop | 0.31 | 1 | Rap & Hip-Hop 1 |
| Nilo | Funk Brasileiro (baixa) | Rap & Hip-Hop | 1.00 | 1 | Rap & Hip-Hop 1 |
| Novin Yarp | Funk Brasileiro (media) | Rap & Hip-Hop | 0.07 | 1 | Rap & Hip-Hop 1 |
| PinkPantheress + DJ Caio Prince + Adame DJ | Eletrofunk (media) | Rap & Hip-Hop | 0.72 | 1 | Rap & Hip-Hop 1 |
| Prod. DTM | Funk Brasileiro (media) | Eletrônica | 0.56 | 1 | Eletrônica 1 |
| shonci | Funk Brasileiro (baixa) | Eletrônica | 0.56 | 1 | Eletrônica 1 |
| Spinnin Records | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.29 | 1 | Rap & Hip-Hop 1 |
| TR | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.19 | 1 | Rap & Hip-Hop 1 |
| VEIGH | Rap & Hip-Hop (media) | Eletrônica | 0.05 | 1 | Eletrônica 1 |
| ZAC | Eletrofunk (baixa) | Eletrônica | 1.00 | 1 | Eletrônica 1 |
| Zé Felipe | Funk Brasileiro (media) | Rap & Hip-Hop | 0.56 | 1 | Rap & Hip-Hop 1 |

## Casos que eram confiança "baixa" na proposta

O MERT não resolve nenhum deles: toda resposta tem confiança baixa (a margem não prevê acerto).

| Pasta | Proposta | MERT | Margem | Faixas | Voto faixa a faixa |
|---|---|---|---:|---:|---|
| MC Saci | Techfunk (baixa) | Rap & Hip-Hop | 0.08 | 1 | Rap & Hip-Hop 1 |
| Flux Zone | Techfunk (baixa) | Rap & Hip-Hop | 0.28 | 2 | Rap & Hip-Hop 2 |
| Astrophysics | Techfunk (baixa) | Funk Brasileiro | 0.15 | 1 | Funk Brasileiro 1 |
| ENNE (BR) | Eletrônica (baixa) | Eletrônica | 0.58 | 1 | Eletrônica 1 |
| AKALEX | Eletrofunk (baixa) | Eletrônica | 0.67 | 1 | Eletrônica 1 |
| Bronka / Electric Baile [tidal] | Eletrofunk (baixa) | Eletrônica | 0.72 | 2 | Eletrônica 2 |
| Bronka / BRONKA SUCKS [tidal] | Funk Brasileiro (baixa) | Eletrônica | 0.40 | 1 | Eletrônica 1 |
| Freenzy Music | Eletrofunk (baixa) | Eletrônica | 0.55 | 1 | Eletrônica 1 |
| Giu | Eletrofunk (baixa) | Eletrônica | 0.69 | 1 | Eletrônica 1 |
| Gal Costa | Eletrofunk (baixa) | sem faixas (ver anomalias) | | 0 | |
| Dave Nunes | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.25 | 1 | Rap & Hip-Hop 1 |
| DJ CZ | Funk Brasileiro (baixa) | Funk Brasileiro | 1.00 | 1 | Funk Brasileiro 1 |
| Dj Caio Vieira | Funk Brasileiro (baixa) | Funk Brasileiro | 0.12 | 1 | Funk Brasileiro 1 |
| FBC | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.09 | 2 | Rap & Hip-Hop 1, Eletrônica 1 |
| DJ JZ | Funk Brasileiro (baixa) | Funk Brasileiro | 0.12 | 1 | Funk Brasileiro 1 |
| DJ NATAN 22 | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.30 | 1 | Rap & Hip-Hop 1 |
| Dj Nattan | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.75 | 1 | Rap & Hip-Hop 1 |
| DJ NK3 | Funk Brasileiro (baixa) | Funk Brasileiro | 0.21 | 1 | Funk Brasileiro 1 |
| Dj Olliver | Funk Brasileiro (baixa) | Funk Brasileiro | 0.57 | 1 | Funk Brasileiro 1 |
| DJ Ryder | Funk Brasileiro (baixa) | Funk Brasileiro | 0.43 | 1 | Funk Brasileiro 1 |
| DJ SV | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.44 | 1 | Rap & Hip-Hop 1 |
| Dj THG | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.30 | 1 | Rap & Hip-Hop 1 |
| DJ Ws da Igrejinha | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.59 | 1 | Rap & Hip-Hop 1 |
| Don Low | Funk Brasileiro (baixa) | Eletrônica | 0.43 | 1 | Eletrônica 1 |
| Eddy M | Funk Brasileiro (baixa) | Eletrônica | 1.00 | 1 | Eletrônica 1 |
| Fezzo | Funk Brasileiro (baixa) | Eletrônica | 0.43 | 1 | Eletrônica 1 |
| ilysam | Funk Brasileiro (baixa) | Eletrônica | 1.00 | 1 | Eletrônica 1 |
| Jeninho | Funk Brasileiro (baixa) | Funk Brasileiro | 0.13 | 1 | Funk Brasileiro 1 |
| Kyan | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.27 | 2 | Rap & Hip-Hop 2 |
| Ladji Mouflet | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.30 | 1 | Rap & Hip-Hop 1 |
| Lou Garcia | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.04 | 1 | Rap & Hip-Hop 1 |
| Mulú | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.70 | 1 | Rap & Hip-Hop 1 |
| Nilo | Funk Brasileiro (baixa) | Rap & Hip-Hop | 1.00 | 1 | Rap & Hip-Hop 1 |
| shonci | Funk Brasileiro (baixa) | Eletrônica | 0.56 | 1 | Eletrônica 1 |
| TR | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.19 | 1 | Rap & Hip-Hop 1 |
| Gal Costa / Azul (Illusionize & Linkage Remix) [tidal] | MPB (baixa) | MPB | 0.54 | 1 | MPB 1 |
| Luan Pereira | Country & Folk (baixa) | Rap & Hip-Hop | 1.00 | 1 | Rap & Hip-Hop 1 |
| ZAC | Eletrofunk (baixa) | Eletrônica | 1.00 | 1 | Eletrônica 1 |
| Spinnin Records | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.29 | 1 | Rap & Hip-Hop 1 |
| Various Artists | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.16 | 11 | Rap & Hip-Hop 7, Funk Brasileiro 2, Eletrônica 2 |

## Pastas divididas (30): as faixas votaram em destinos diferentes

Mostra que o voto do MERT muda de faixa para faixa dentro do mesmo artista/álbum, inclusive nas pastas aprovadas (DJ Piu, DJ Arana, DJ K).

| Pasta | Proposta | MERT | Margem | Faixas | Voto faixa a faixa |
|---|---|---|---:|---:|---|
| DJ Piu | Funk Brasileiro (alta) | Funk Brasileiro | 0.03 | 50 | Funk Brasileiro 24, Rap & Hip-Hop 21, Eletrônica 4, Mega Funk 1 |
| DJ Arana | Funk Brasileiro (alta) | Funk Brasileiro | 0.09 | 27 | Rap & Hip-Hop 13, Funk Brasileiro 12, Eletrônica 2 |
| Humildes | Funk Brasileiro (media) | Rap & Hip-Hop | 0.21 | 22 | Rap & Hip-Hop 13, Funk Brasileiro 7, Eletrônica 2 |
| _Compilations | Funk Brasileiro (alta) | Funk Brasileiro | 0.03 | 20 | Funk Brasileiro 10, Rap & Hip-Hop 9, MPB 1 |
| OO Rubinho | Funk Brasileiro (alta) | Rap & Hip-Hop | 0.19 | 20 | Rap & Hip-Hop 12, Eletrônica 5, Funk Brasileiro 3 |
| DJ K | Funk Brasileiro (alta) | Funk Brasileiro | 0.01 | 15 | Funk Brasileiro 9, Rap & Hip-Hop 5, Eletrônica 1 |
| D.A.N.V, DJ Kingdom, VKKramer | Funk Brasileiro (alta) | Rap & Hip-Hop | 0.06 | 12 | Rap & Hip-Hop 5, Eletrônica 4, Funk Brasileiro 3 |
| [2025] Radio libertadora! | Techfunk (media) | Funk Brasileiro | 0.10 | 11 | Rap & Hip-Hop 4, Funk Brasileiro 4, Eletrônica 3 |
| Various Artists | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.16 | 11 | Rap & Hip-Hop 7, Funk Brasileiro 2, Eletrônica 2 |
| Adame DJ | Funk Brasileiro (media) | Funk Brasileiro | 0.46 | 10 | Funk Brasileiro 8, Eletrônica 1, Rap & Hip-Hop 1 |
| DJ Jeeh FDC | Funk Brasileiro (alta) | Funk Brasileiro | 0.02 | 10 | Rap & Hip-Hop 6, Funk Brasileiro 4 |
| DJ GB FAIXA PRETA | Funk Brasileiro (alta) | Funk Brasileiro | 0.17 | 9 | Funk Brasileiro 5, Rap & Hip-Hop 3, Eletrônica 1 |
| Syon Trio | Funk Brasileiro (alta) | Rap & Hip-Hop | 0.19 | 9 | Rap & Hip-Hop 5, Eletrônica 3, Funk Brasileiro 1 |
| DJ Anderson do Paraiso | Funk Brasileiro (alta) | Rap & Hip-Hop | 0.51 | 8 | Rap & Hip-Hop 6, Funk Brasileiro 1, MPB 1 |
| DJ LK DE ITAPE | Funk Brasileiro (alta) | Funk Brasileiro | 0.11 | 7 | Funk Brasileiro 4, Rap & Hip-Hop 2, Eletrônica 1 |
| BadSista | Funk Brasileiro (media) | Rap & Hip-Hop | 0.06 | 6 | Rap & Hip-Hop 3, Funk Brasileiro 2, Eletrônica 1 |
| MC Kevin o Chris / 2022 - Deixa Se Envolver (Spring Love) [Remixes Pt. 1] | Eletrofunk (alta) | Rap & Hip-Hop | 0.09 | 6 | Rap & Hip-Hop 3, Eletrônica 3 |
| Pedro Sampaio | Funk Brasileiro (media) | Rap & Hip-Hop | 0.00 | 6 | Eletrônica 3, Rap & Hip-Hop 2, Funk Brasileiro 1 |
| DJ Johnny Souza | Funk Brasileiro (media) | Eletrônica | 0.10 | 5 | Funk Brasileiro 3, Eletrônica 1, Rap & Hip-Hop 1 |
| DJ Petroski | Mega Funk (alta) | Eletrônica | 0.09 | 5 | Rap & Hip-Hop 2, Funk Brasileiro 2, Eletrônica 1 |
| Mc Livinho | Funk Brasileiro (alta) | Rap & Hip-Hop | 0.32 | 5 | Rap & Hip-Hop 4, Funk Brasileiro 1 |
| DJ Zigão | Funk Brasileiro (media) | Rap & Hip-Hop | 0.14 | 4 | Rap & Hip-Hop 3, Funk Brasileiro 1 |
| Kioma, Buarky, kLap e Mu540 | Eletrofunk (media) | Rap & Hip-Hop | 0.04 | 4 | Rap & Hip-Hop 2, Eletrônica 2 |
| Mc Jacaré | Funk Brasileiro (alta) | Funk Brasileiro | 0.03 | 4 | Rap & Hip-Hop 2, Eletrônica 1, Funk Brasileiro 1 |
| DENNIS | Funk Brasileiro (alta) | Eletrônica | 0.09 | 3 | Funk Brasileiro 1, Eletrônica 1, MPB 1 |
| MC Kevin o Chris | Funk Brasileiro (alta) | Rap & Hip-Hop | 0.48 | 3 | Rap & Hip-Hop 2, Funk Brasileiro 1 |
| Victor Lou | Funk Brasileiro (media) | Funk Brasileiro | 0.00 | 3 | Eletrônica 1, Rap & Hip-Hop 1, Funk Brasileiro 1 |
| DJ Guuga | Funk Brasileiro (media) | Rap & Hip-Hop | 0.21 | 2 | Rap & Hip-Hop 1, Funk Brasileiro 1 |
| FBC | Funk Brasileiro (baixa) | Rap & Hip-Hop | 0.09 | 2 | Rap & Hip-Hop 1, Eletrônica 1 |
| GP DA ZL | Funk Brasileiro (alta) | Rap & Hip-Hop | 0.01 | 2 | Funk Brasileiro 1, Rap & Hip-Hop 1 |
