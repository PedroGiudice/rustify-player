# Proposta de classificacao da pasta Funk Brasileiro por subgenero (CMR-299)

Data: 2026-10-13. Acervo analisado: `~/Music/Funk Brasileiro` na cmr-auto, 442 faixas em 150 pastas de artista (confirmado via `find`), cruzado com o indice Qdrant (`rustify_tracks`, 442 pontos casando o path) e WebSearch para artistas desconhecidos. Tags de genero ID3/Qdrant sao majoritariamente so `funk brasileiro` (237/442) ou vazias (106/442) -- pouco uteis isoladamente; usadas como sinal corroborante quando presentes (`beat bruxaria`, `funk de bh`, `funk 150 bpm`, `house`, `electro`, `hip hop`).

Entregavel JSON irmao: `docs/contexto/13102026-funk-classificacao-proposta.json` (156 linhas -- algumas pastas de artista aparecem 2x porque um album diverge do resto do catalogo do artista).

## Resumo por pasta destino

| Pasta destino | Faixas | Pastas de artista/album |
|---|---:|---:|
| Funk Brasileiro | 288 | 94 |
| Eletrofunk | 46 | 29 |
| Mega Funk | 10 | 6 |
| Techfunk | 89 | 18 |
| Eletrônica | 4 | 4 |
| Rap & Hip-Hop | 2 | 2 |
| MPB | 2 | 2 |
| Country & Folk | 1 | 1 |
| **Total** | **442** | **156** |

## Resumo por confianca

| Confianca | Linhas |
|---|---:|
| alta | 45 |
| media | 70 |
| baixa | 41 |

**41 linhas de confianca baixa** precisam de decisao do CEO antes do lote (listadas na secao dedicada).

## Tabela por artista

Ordenada por pasta destino, depois por nome do artista. Quando o artista tem mais de uma linha, o `album_dir` indicado e o que diverge; a linha sem `album_dir` cobre o resto do catalogo daquele artista.

| Artista (pasta em disco) | Album (se diverge) | Faixas | Destino | Confianca | Justificativa |
|---|---|---:|---|---|---|
| _Compilations | — | 20 | Funk Brasileiro | alta | 2020 - Baile Da China: coletânea classica de baile funk paulista (DJ Jeffinho/Ricardinho) |
| Adame DJ | — | 10 | Funk Brasileiro | media | montagens/mandelão raiz; tag qdrant 'reggaeton' no album solo (funk com influencia reggaeton) |
| BadSista | — | 6 | Funk Brasileiro | media | EP com feat. Lei Di Dai, funk de baile convencional |
| Bronka | BRONKA SUCKS [tidal] | 1 | Funk Brasileiro | baixa | titulo 'Tesão Cabuloso' sem sinal eletronico |
| D.A.N.V, DJ Kingdom, VKKramer | — | 12 | Funk Brasileiro | alta | A Baile Vol.1 -- mandelão com features de MCs e VHOOR |
| Dave Nunes | — | 1 | Funk Brasileiro | baixa | titulo generico, sem sinal eletronico |
| DENNIS | — | 3 | Funk Brasileiro | alta | faixas regulares (Deixa de Onda, MOTINHA 2.0, Tá OK) -- funk melody/funk carioca classico do Dennis DJ |
| Dj Aguilar | — | 1 | Funk Brasileiro | media | titulo funk convencional |
| DJ Anderson do Paraiso | — | 8 | Funk Brasileiro | alta | Paraiso Sombrio = funk de BH (tag qdrant 'funk de bh'); unificar grafia com acento |
| DJ Anderson do Paraíso | — | 1 | Funk Brasileiro | alta | Queridão, funk de BH mainstream |
| Dj Caio Vieira | — | 1 | Funk Brasileiro | baixa | FAMOSINHA -- titulo generico de funk |
| DJ CARLOZS ((NORMAL)) | — | 1 | Funk Brasileiro | media | 'MEGA DO CROSSTALK' -- 'mega' aqui = montagem generica, nao mega funk SC especifico |
| DJ CZ | — | 1 | Funk Brasileiro | baixa | titulo generico |
| DJ Douglinhas | — | 1 | Funk Brasileiro | media | titulo funk convencional explicito |
| Dj Duarte | — | 1 | Funk Brasileiro | media | MONTAGEM -- montagem/mandelão classico |
| DJ GB FAIXA PRETA | — | 9 | Funk Brasileiro | alta | tag qdrant 'funk 150 bpm' -- automotivo paulista, bate com a definicao do CEO |
| Dj Gbr | — | 1 | Funk Brasileiro | media | Passinho do Bota, raiz carioca |
| DJ GBR | — | 1 | Funk Brasileiro | alta | Pump It, raiz carioca; billing padrao do artista é tudo-maiusculo |
| DJ Gui Marques | — | 1 | Funk Brasileiro | media | Mandelão explicito no titulo |
| DJ Guuga | — | 2 | Funk Brasileiro | media | demais albuns (Casamento, Vidrado Em Você) sem sinal eletronico, funk convencional |
| DJ Holanda | — | 1 | Funk Brasileiro | media | MONTAGEM feat. Mc Cyclope |
| DJ Jeeh FDC | — | 10 | Funk Brasileiro | alta | Alcateia -- mandelão com dezenas de MCs de feature |
| DJ Johnny Souza | — | 5 | Funk Brasileiro | media | Mundo Souza -- funk convencional |
| DJ JZ | — | 1 | Funk Brasileiro | baixa | titulo generico |
| DJ LK DE ITAPE | — | 7 | Funk Brasileiro | alta | titulos citam '150bpm' explicitamente -- automotivo bate com a definicao do CEO |
| Dj Luan Gomes | — | 3 | Funk Brasileiro | media | MTG (montagem) convencional |
| DJ Léo da 17 | — | 1 | Funk Brasileiro | media | colab com MC MN e DJ K -- funk raiz |
| DJ NATAN 22 | — | 1 | Funk Brasileiro | baixa | titulo generico |
| Dj Nattan | — | 1 | Funk Brasileiro | baixa | tag qdrant 'rio funk' -- carioca |
| DJ NK3 | — | 1 | Funk Brasileiro | baixa | titulo automotivo generico |
| Dj Olliver | — | 1 | Funk Brasileiro | baixa | titulo generico |
| dj paran0ia | — | 1 | Funk Brasileiro | media | GQOM AUTOMOTIVO -- fusao com gqom, mas base automotivo raiz |
| DJ Patrick Muniz | — | 1 | Funk Brasileiro | media | feat. Mc Rennan -- funk convencional |
| DJ Piu | — | 50 | Funk Brasileiro | alta | This Is DJ Piu -- 50 faixas de funk raiz/baile convencional |
| DJ Ramon Sucesso | — | 1 | Funk Brasileiro | media | feat. MC Henry -- funk convencional |
| DJ RD do Martins | — | 1 | Funk Brasileiro | alta | tag qdrant 'funk brasileiro' direta |
| DJ Rogerinho do Querô | — | 1 | Funk Brasileiro | media | Sequência do Vapo Vapo vs Brega Funk -- raiz |
| DJ Ryder | — | 1 | Funk Brasileiro | baixa | Sequência da Botação -- generico |
| DJ SV | — | 1 | Funk Brasileiro | baixa | titulo generico |
| Dj THG | — | 1 | Funk Brasileiro | baixa | titulo generico |
| DJ Topo | — | 1 | Funk Brasileiro | media | MTG (montagem) convencional |
| DJ WIN | — | 1 | Funk Brasileiro | media | feat. MC Braz e Rick -- funk convencional |
| DJ Ws da Igrejinha | — | 1 | Funk Brasileiro | baixa | titulo generico |
| DJ Zigão | — | 4 | Funk Brasileiro | media | montagens convencionais (Baile de Marginal etc.) |
| Don Low | — | 1 | Funk Brasileiro | baixa | NY Girls -- titulo sem sinal claro |
| Duquesa | — | 1 | Funk Brasileiro | media | cantora de funk feminejo mainstream brasileiro |
| Dyamante DJ | — | 1 | Funk Brasileiro | alta | confirmado: classificado como Baile Funk, hit 'Vai Novinha Ah Ah Ah' |
| Eddy M | — | 1 | Funk Brasileiro | baixa | titulo generico |
| FBC | — | 2 | Funk Brasileiro | baixa | BAILE -- titulo generico de baile funk |
| Felipe Amorim | — | 2 | Funk Brasileiro | media | cantor mainstream de funk-pop carioca |
| Fezzo | — | 1 | Funk Brasileiro | baixa | titulo generico, sem sinal eletronico |
| Furacão 2000 | — | 1 | Funk Brasileiro | alta | equipe de baile funk historica do Rio |
| Humildes | — | 22 | Funk Brasileiro | media | coletânea underground SoundCloud de funk/mandelão; FORA do funk: faixa 24 'BRING ME THE HORIZON' (banda de metalcore) -- mover para Rock |
| ilysam | — | 1 | Funk Brasileiro | baixa | titulo generico |
| JAUM, O GANG$TAR | — | 1 | Funk Brasileiro | media | QUANDO O GRAVE BATE FORTE -- funk raiz |
| JC no beat | — | 1 | Funk Brasileiro | media | 'no beat' -- convencao tipica de produtor de funk |
| Jeninho | — | 1 | Funk Brasileiro | baixa | Peão Todo Tatuado -- possivel cruzamento com agronejo, mantido como funk por falta de sinal mais forte |
| Kyan | — | 2 | Funk Brasileiro | baixa | Vilão da Mídia / Fantástico Mundo da Oakley -- possivel trap, nao confirmado como funk |
| L7NNON | — | 2 | Funk Brasileiro | media | confirmado colaborador de Papatinho na cena funk-trap carioca |
| Ladji Mouflet | — | 1 | Funk Brasileiro | baixa | remix generico |
| Lou Garcia | — | 1 | Funk Brasileiro | baixa | MTG Remix -- generico |
| MC Don Juan | — | 1 | Funk Brasileiro | alta | MC mainstream de funk carioca |
| MC Fioti | — | 1 | Funk Brasileiro | alta | MC mainstream (Bum Bum Tam Tam) |
| Mc Gabzin | — | 1 | Funk Brasileiro | media | MC convencional |
| Mc Jacare | — | 1 | Funk Brasileiro | alta | Pequi de Goiás -- funk raiz; unificar grafia com acento |
| Mc Jacaré | — | 4 | Funk Brasileiro | alta | demais albuns (Senta e Cala a Boca, Senta Pro Bruto, Toma Tapa, Vento Forte) -- funk MC raiz |
| MC Jvila | — | 1 | Funk Brasileiro | media | MC convencional |
| MC Kevin o Chris | — | 3 | Funk Brasileiro | alta | demais albuns (Tamborzão Raiz, Faz um Vuk Vuk) -- tamborzão carioca classico |
| Mc Kitinho | — | 1 | Funk Brasileiro | media | MC convencional |
| MC L da Vinte | — | 1 | Funk Brasileiro | media | Limitlezz Remix -- base e MC de funk, remix nao claramente eletronico |
| Mc Livinho | — | 5 | Funk Brasileiro | alta | MC mainstream de funk carioca |
| Mc Menor Mr, Mano Gothia, Mc Dutra Rg, Caio Passos, Mc Meno K, Mc Sartori, DJ Camarozano | — | 1 | Funk Brasileiro | alta | colab de MCs, raiz |
| MC Menor MT | — | 1 | Funk Brasileiro | media | MC convencional |
| Mc Neguinho do Morro | — | 1 | Funk Brasileiro | media | MC convencional |
| MC Pogba | — | 1 | Funk Brasileiro | media | MC convencional |
| MC Teteu | — | 1 | Funk Brasileiro | media | MC convencional |
| Menor Teteu | — | 1 | Funk Brasileiro | media | MC convencional (possivel mesma pessoa que MC Teteu, nao confirmado) |
| MLQ 2N | — | 1 | Funk Brasileiro | media | titulo diz literalmente 'Brazilian Funk' |
| Mulú | — | 1 | Funk Brasileiro | baixa | confirmado produtor de EDM/rasteirinha/funk carioca/reggaeton -- hibrido, sem bucket exato; mantido em funk por ser a base |
| Niack | — | 1 | Funk Brasileiro | media | confirmado: funk carioca com cruzamento pop |
| Nilo | — | 1 | Funk Brasileiro | baixa | titulo generico |
| Novin Yarp | — | 1 | Funk Brasileiro | media | MTG (montagem) convencional |
| Papatinho | — | 1 | Funk Brasileiro | alta | confirmado: produtor de funk-trap carioca, album 'MPC' inspirado no funk dos anos 90 do Rio |
| Pedro Sampaio | — | 6 | Funk Brasileiro | media | faixas 'SEQUÊNCIA' no formato classico de sequencia automotiva; artista tambem cruza com house/pop mas base e funk |
| Prod. DTM | — | 1 | Funk Brasileiro | media | RALLY FUNK -- automotivo/rally, raiz |
| Ricii Lompeurs | — | 1 | Funk Brasileiro | media | AUTOMOTIVO ESTABILIZAÇÃO -- automotivo explicito |
| shonci | — | 1 | Funk Brasileiro | baixa | titulo generico |
| Spinnin Records | — | 1 | Funk Brasileiro | baixa | faixa 'Mega Ritimada das Bruta 1.0' dentro de uma coletânea global de Phonk -- crossover automotivo/phonk, sem confirmacao de autoria brasileira |
| Syon Trio | — | 9 | Funk Brasileiro | alta | confirmado: 'Latin Funk Carioca band', mashups de funk carioca |
| TR | — | 1 | Funk Brasileiro | baixa | titulo generico |
| Various Artists | — | 11 | Funk Brasileiro | baixa | pasta heterogenea (varios mixes [tidal] + singles); maioria tem titulo/giria de funk raiz. Revisar manualmente antes do lote: 'Samba de Malandro' e 'TOP BRASIL - MAIS TOCADAS DO VERÃO 2026' sao os mais duvidosos |
| Victor Lou | — | 3 | Funk Brasileiro | media | titulo explicito 'FUNK VERSION' numa das faixas; tema submundo |
| ZAAC | — | 1 | Funk Brasileiro | media | produtor de funk-pop brasileiro conhecido (colaborações mainstream) |
| Zé Felipe | — | 1 | Funk Brasileiro | media | cruzamentos funk-pop do cantor; sem sinal de genero diferente |
| AKALEX | — | 1 | Eletrofunk | baixa | Party Funk -- titulo sugere hibrido funk+house de festa, sem confirmacao |
| Alok, Mc Don Juan e DJ GBR | — | 1 | Eletrofunk | alta | Alok e a referencia maior de brazilian bass; colab funk+EDM, tag qdrant 'dance' |
| Andruss | — | 1 | Eletrofunk | media | tech house 130bpm, label Club Sweat (foco bass/baile funk); existe remix baile funk separado do mesmo track |
| ATANA | — | 1 | Eletrofunk | media | House 120bpm, titulo 'A Caipora (Vaitimbora)' com giria funk, estetica brazilian bass |
| Bellaire | — | 1 | Eletrofunk | media | produtor parisiense, faixa 'Brasil' com estetica dance/bass direcionada ao publico brazilian bass |
| Beltran | — | 2 | Eletrofunk | media | produtor brasileiro de tech house underground; titulo 'Tira A Roupa' remete a funk |
| Bronka | Electric Baile [tidal] | 2 | Eletrofunk | baixa | titulo 'Electric Baile' sugere eletrofunk |
| CHAMOS | — | 1 | Eletrofunk | media | Ravezinha -- diminutivo de rave, sugere hibrido com house |
| Classmatic | — | 1 | Eletrofunk | alta | citado explicitamente pelo CEO |
| DJ Guuga | MEGA ELETRO FUNK - Last Night [tidal] | 1 | Eletrofunk | alta | titulo diz literalmente 'MEGA ELETRO FUNK' |
| Dubdogz | — | 1 | Eletrofunk | alta | citado explicitamente pelo CEO como exemplo de eletrofunk |
| FatSync | — | 3 | Eletrofunk | alta | confirmado: bass house brasileiro, Curitiba, lançou pela Spinnin Records |
| Freenzy Music | — | 1 | Eletrofunk | baixa | nome de projeto sugere EDM; 'Baile In Braza' tema funk/bass |
| Gal Costa | — | 0 | Eletrofunk | baixa | faixa e um remix de Illusionize (eletrofunk) sobre musica de Gal Costa -- nao e Gal Costa 'cantando funk', e remix dance |
| Giu | — | 1 | Eletrofunk | baixa | VIP Mix -- terminologia tipica de bass/dubstep |
| Gordo | — | 1 | Eletrofunk | media | produtor de tech/Latin house, faixa com feat. Mc Gw -- fusao funk+house |
| HUGEL | — | 1 | Eletrofunk | media | Bololo com MC Bin Laden (MC de funk) -- tech/Latin house + funk carioca |
| Illusionize | — | 4 | Eletrofunk | alta | citado explicitamente pelo CEO |
| Kioma, Buarky, kLap e Mu540 | — | 4 | Eletrofunk | media | Funk Rave EP -- Mu540 e o mesmo artista funk+house; enquadramento 'rave' |
| KVSH | — | 1 | Eletrofunk | alta | citado explicitamente pelo CEO |
| Mc Jacaré | Eletrofunk Raiz [tidal] | 1 | Eletrofunk | alta | album chama-se literalmente 'Eletrofunk Raiz' |
| MC Kevin o Chris | 2022 - Deixa Se Envolver (Spring Love) [Remixes Pt. 1] | 6 | Eletrofunk | alta | album de remixes tageados 'electro'/house na Qdrant |
| MC Th | — | 1 | Eletrofunk | alta | titulo da faixa inclui literalmente '(Eletrofunk)' |
| Meloko | — | 1 | Eletrofunk | media | confirmado: 'Brazil Funk' com vibe tech house, label propria AZZUR |
| MU540 | — | 2 | Eletrofunk | alta | confirmado: funde baile funk e afro-house deliberadamente ('4x4' EP, funk escondido dentro da house) |
| PinkPantheress | — | 2 | Eletrofunk | media | faixas 'Stars' com DJ Caio Prince & Adame DJ sao remix funk+house, tag qdrant 'house'; versao original pop fica no mesmo pacote |
| PinkPantheress + DJ Caio Prince + Adame DJ | — | 1 | Eletrofunk | media | mesma faixa 'Stars', remix funk+house -- duplicata da pasta PinkPantheress |
| Vintage Culture | — | 2 | Eletrofunk | alta | citado explicitamente pelo CEO |
| ZAC | — | 1 | Eletrofunk | baixa | Lost (Remix) -- padrao de nome/remix tipico de produtor house, sem confirmacao |
| Dennis & Friends (2020) | — | 1 | Mega Funk | media | faixa titulada 'Mega Funk Esse é Seu Momento'; artista e carioca/mainstream, nao exatamente da cena SC |
| DJ Fernando Souza | — | 1 | Mega Funk | alta | confirmado ativo na cena mega funk (SoundCloud/YouTube) |
| DJ Luan Mark | — | 1 | Mega Funk | alta | Mega Funk del Rey -- confirmado genero mega funk |
| DJ Maninho | — | 1 | Mega Funk | alta | Mega Funk Lost -- confirmado genero mega funk |
| DJ Petroski | — | 5 | Mega Funk | alta | confirmado: de Lages/SC, 'novo nome do mega funk', mistura funk+house (Mega Funk Minimal, Toxic, Show Me Love) |
| TAIDigital | — | 1 | Mega Funk | alta | MEGA FUNK UNDERGROUND -- confirmado produtor de mega funk |
| [2025] Radio libertadora! | — | 11 | Techfunk | media | titulos com TECHNO DE FAVELADO, PSY VEM FAZER NENEM, MEGA SUICIDIO AUDITIVO -- estetica tech/psy explicita |
| Astrophysics | — | 1 | Techfunk | baixa | BAILE DA MIKU -- tema vocaloid/techno-funk meme, sinal fraco |
| CyberKills | — | 1 | Techfunk | media | confirmado: dupla BR, 'funk mandelão + deconstructed club/EDM', remix 160bpm de FKA twigs -- extremo, perfil tech/experimental |
| DJ Anderson do Paraiso | Última Bruxaria do Ano | 1 | Funk Brasileiro | alta | faixa isolada tema bruxaria, diverge do resto do catalogo (funk de BH) [CEO 14/10: bruxaria é funk] |
| DJ Arana | — | 27 | Funk Brasileiro | alta | expoente do funk bruxaria confirmado (DJ Arana, DJ K, DJ Blakes); tag qdrant 'beat bruxaria' no album Rock pesado 2 [CEO 14/10: bruxaria é funk] |
| DJ Arana, Mc Larissa, Mc Lekão - Famoso Machuca Xota (2023) | — | 1 | Funk Brasileiro | alta | colab de DJ Arana, segue o estilo bruxaria do artista principal [CEO 14/10: bruxaria é funk] |
| DJ Blakes | — | 1 | Funk Brasileiro | alta | expoente citado do funk bruxaria [CEO 14/10: bruxaria é funk] |
| Dj GBR | — | 1 | Funk Brasileiro | alta | Mega Rave Sem Chão [tidal] -- titulo 'rave' sugere vertente eletronica/bruxaria do GBR, diverge do resto [CEO 14/10: bruxaria é funk] |
| DJ K | — | 15 | Funk Brasileiro | alta | expoente citado do funk bruxaria (Panico no Submundo) [CEO 14/10: bruxaria é funk] |
| DJ LA Beat & DJ K9 | — | 1 | Funk Brasileiro | alta | Convocação da Bruxaria -- tema explicito [CEO 14/10: bruxaria é funk] |
| Flux Zone | — | 2 | Techfunk | baixa | Machine Hearts / The Underground -- nomes sugerem techno, sem confirmacao de fusao com funk |
| GP DA ZL | — | 2 | Funk Brasileiro | alta | colabora com Jhow Dancer em 'Eu Quero Bruxaria'; ZL on Air / Mixtape Underground, estetica submundo [CEO 14/10: bruxaria é funk] |
| Jhow Dancer | — | 1 | Funk Brasileiro | alta | Violino Subverso classificado como Mandelão Funk mas cena bruxaria (feat. GP DA ZL, tema 'Eu Quero Bruxaria') [CEO 14/10: bruxaria é funk] |
| MAC10TA | — | 1 | Funk Brasileiro | alta | Bruxaria do Beco da Morte -- tema explicito [CEO 14/10: bruxaria é funk] |
| MC Saci | — | 1 | Techfunk | baixa | album 'Funktroit' (trocadilho Funk+Detroit/techno); sinal fraco |
| OO Rubinho | — | 20 | Funk Brasileiro | alta | Bruxaria Cósmica + HARDFUNK -- titulos tech/sci-fi (ALPHA, ZYLON, LASER, APHEX TUIM ref. a Aphex Twin, MEGATRON) [CEO 14/10: bruxaria é funk] |
| petrus.wav | — | 1 | Funk Brasileiro | baixa | titulo agressivo/vulgar no padrao bruxaria (FODE PRA KARALHO, versionamento MASTER V5); nao confirmado [CEO 14/10: bruxaria é funk] |
| Tropa do Bruxo | — | 1 | Funk Brasileiro | alta | nome e album ja citam bruxo/bruxaria [CEO 14/10: bruxaria é funk] |
| Demm Deep | — | 1 | Eletrônica | media | confirmado: French house puro (94bpm), titulo 'Brazilian Sky' e so tematico -- nao e funk |
| ENNE (BR) | — | 1 | Eletrônica | baixa | confirmado: minimal deep tech carioca, sem fusao evidente com funk -- nao e funk |
| OVEOUS | — | 1 | Eletrônica | media | House puro (Brobot Records), sem elemento de funk BR -- nao e funk |
| Quarterhead | — | 1 | Eletrônica | media | dupla alema de tech house, sem fusao com funk brasileiro -- nao e funk; pasta mais proxima = Eletrônica |
| Drae Da Skimask | — | 1 | Rap & Hip-Hop | media | tag qdrant 'hip hop'/'rap' direta -- Famoso Xota nao e funk |
| VEIGH | — | 1 | Rap & Hip-Hop | media | confirmado rapper de trap/drill carioca, nao e funk |
| Gal Costa | Azul (Illusionize & Linkage Remix) [tidal] | 1 | MPB | baixa | alternativa: manter como MPB (artista original) em vez de Eletrofunk (remix); ambiguidade reportada acima tambem |
| Marina Sena | — | 1 | MPB | alta | MPB/pop contemporanea, nao e funk |
| Luan Pereira | — | 1 | Country & Folk | baixa | sertanejo/agronejo (DENTRO DA HILUX); nao ha pasta de Sertanejo -- Country & Folk e a mais proxima |

## Unificacao de grafia (mesma entidade, nomes divergentes em disco)

| Pastas em disco | Grafia canonica proposta |
|---|---|
| `DJ Anderson do Paraiso`, `DJ Anderson do Paraíso` | DJ Anderson do Paraíso |
| `Dj Gbr`, `Dj GBR`, `DJ GBR` | DJ GBR |
| `Mc Jacare`, `Mc Jacaré` | Mc Jacaré |

Nao unificadas por falta de evidencia de que sejam a mesma pessoa (grafias parecidas mas sem confirmacao): `Dj Nattan` vs `DJ NATAN 22`; `MC Teteu` vs `Menor Teteu`.

## Faixas fora do escopo funk, dentro de pastas que ficam em Funk Brasileiro/Techfunk (excecao pontual, nao representavel no JSON por pasta)

- `Humildes/2023 - HUMILDES DO SOUNDCLOUD VOL. 2/24 - BRING ME THE HORIZON - CAN YOU FEEL MY HEART [FELI.flac` -- e a banda de metalcore Bring Me The Horizon, nao funk. Mover para `Rock`. Confianca alta.

## Casos de confianca baixa (decisao do CEO)

| Artista | Album | Destino proposto | Por que e duvidoso |
|---|---|---|---|
| Luan Pereira | — | Country & Folk | sertanejo/agronejo (DENTRO DA HILUX); nao ha pasta de Sertanejo -- Country & Folk e a mais proxima |
| AKALEX | — | Eletrofunk | Party Funk -- titulo sugere hibrido funk+house de festa, sem confirmacao |
| Bronka | Electric Baile [tidal] | Eletrofunk | titulo 'Electric Baile' sugere eletrofunk |
| Freenzy Music | — | Eletrofunk | nome de projeto sugere EDM; 'Baile In Braza' tema funk/bass |
| Giu | — | Eletrofunk | VIP Mix -- terminologia tipica de bass/dubstep |
| Gal Costa | — | Eletrofunk | faixa e um remix de Illusionize (eletrofunk) sobre musica de Gal Costa -- nao e Gal Costa 'cantando funk', e remix dance |
| ZAC | — | Eletrofunk | Lost (Remix) -- padrao de nome/remix tipico de produtor house, sem confirmacao |
| ENNE (BR) | — | Eletrônica | confirmado: minimal deep tech carioca, sem fusao evidente com funk -- nao e funk |
| Bronka | BRONKA SUCKS [tidal] | Funk Brasileiro | titulo 'Tesão Cabuloso' sem sinal eletronico |
| Dave Nunes | — | Funk Brasileiro | titulo generico, sem sinal eletronico |
| DJ CZ | — | Funk Brasileiro | titulo generico |
| Dj Caio Vieira | — | Funk Brasileiro | FAMOSINHA -- titulo generico de funk |
| FBC | — | Funk Brasileiro | BAILE -- titulo generico de baile funk |
| DJ JZ | — | Funk Brasileiro | titulo generico |
| DJ NATAN 22 | — | Funk Brasileiro | titulo generico |
| Dj Nattan | — | Funk Brasileiro | tag qdrant 'rio funk' -- carioca |
| DJ NK3 | — | Funk Brasileiro | titulo automotivo generico |
| Dj Olliver | — | Funk Brasileiro | titulo generico |
| DJ Ryder | — | Funk Brasileiro | Sequência da Botação -- generico |
| DJ SV | — | Funk Brasileiro | titulo generico |
| Dj THG | — | Funk Brasileiro | titulo generico |
| DJ Ws da Igrejinha | — | Funk Brasileiro | titulo generico |
| Don Low | — | Funk Brasileiro | NY Girls -- titulo sem sinal claro |
| Eddy M | — | Funk Brasileiro | titulo generico |
| Fezzo | — | Funk Brasileiro | titulo generico, sem sinal eletronico |
| ilysam | — | Funk Brasileiro | titulo generico |
| Jeninho | — | Funk Brasileiro | Peão Todo Tatuado -- possivel cruzamento com agronejo, mantido como funk por falta de sinal mais forte |
| Kyan | — | Funk Brasileiro | Vilão da Mídia / Fantástico Mundo da Oakley -- possivel trap, nao confirmado como funk |
| Ladji Mouflet | — | Funk Brasileiro | remix generico |
| Lou Garcia | — | Funk Brasileiro | MTG Remix -- generico |
| Mulú | — | Funk Brasileiro | confirmado produtor de EDM/rasteirinha/funk carioca/reggaeton -- hibrido, sem bucket exato; mantido em funk por ser a base |
| Nilo | — | Funk Brasileiro | titulo generico |
| shonci | — | Funk Brasileiro | titulo generico |
| TR | — | Funk Brasileiro | titulo generico |
| Spinnin Records | — | Funk Brasileiro | faixa 'Mega Ritimada das Bruta 1.0' dentro de uma coletânea global de Phonk -- crossover automotivo/phonk, sem confirmacao de autoria brasileira |
| Various Artists | — | Funk Brasileiro | pasta heterogenea (varios mixes [tidal] + singles); maioria tem titulo/giria de funk raiz. Revisar manualmente antes do lote: 'Samba de Malandro' e 'TOP BRASIL - MAIS TOCADAS DO VERÃO 2026' sao os mais duvidosos |
| Gal Costa | Azul (Illusionize & Linkage Remix) [tidal] | MPB | alternativa: manter como MPB (artista original) em vez de Eletrofunk (remix); ambiguidade reportada acima tambem |
| MC Saci | — | Techfunk | album 'Funktroit' (trocadilho Funk+Detroit/techno); sinal fraco |
| petrus.wav | — | Funk Brasileiro | titulo agressivo/vulgar no padrao bruxaria (FODE PRA KARALHO, versionamento MASTER V5); nao confirmado [CEO 14/10: bruxaria é funk] |
| Flux Zone | — | Techfunk | Machine Hearts / The Underground -- nomes sugerem techno, sem confirmacao de fusao com funk |
| Astrophysics | — | Techfunk | BAILE DA MIKU -- tema vocaloid/techno-funk meme, sinal fraco |

## Nao e funk (vai para pasta de genero ja existente)

| Artista | Album | Destino | Confianca | Justificativa |
|---|---|---|---|---|
| Quarterhead | — | Eletrônica | media | dupla alema de tech house, sem fusao com funk brasileiro -- nao e funk; pasta mais proxima = Eletrônica |
| OVEOUS | — | Eletrônica | media | House puro (Brobot Records), sem elemento de funk BR -- nao e funk |
| Demm Deep | — | Eletrônica | media | confirmado: French house puro (94bpm), titulo 'Brazilian Sky' e so tematico -- nao e funk |
| ENNE (BR) | — | Eletrônica | baixa | confirmado: minimal deep tech carioca, sem fusao evidente com funk -- nao e funk |
| Drae Da Skimask | — | Rap & Hip-Hop | media | tag qdrant 'hip hop'/'rap' direta -- Famoso Xota nao e funk |
| Marina Sena | — | MPB | alta | MPB/pop contemporanea, nao e funk |
| Gal Costa | Azul (Illusionize & Linkage Remix) [tidal] | MPB | baixa | alternativa: manter como MPB (artista original) em vez de Eletrofunk (remix); ambiguidade reportada acima tambem |
| Luan Pereira | — | Country & Folk | baixa | sertanejo/agronejo (DENTRO DA HILUX); nao ha pasta de Sertanejo -- Country & Folk e a mais proxima |
| VEIGH | — | Rap & Hip-Hop | media | confirmado rapper de trap/drill carioca, nao e funk |

## Metodologia

1. `find` na cmr-auto (via SSH) para a arvore completa de pastas e arquivos (442 faixas, 150 pastas de artista).
2. Scroll completo da collection `rustify_tracks` no Qdrant (tunel `127.0.0.1:16333`) filtrando `path` contendo `Funk Brasileiro` -- 442 pontos casaram 1:1 com o disco. Tags de genero quase todas vazias ou genericas; os poucos tags especificos (`beat bruxaria`, `funk de bh`, `funk 150 bpm`, `house`, `electro`, `hip hop`) foram usados como evidencia direta.
3. WebSearch para todo artista nao identificavel de cabeça, priorizando confirmar: (a) ligacao com a cena SC/Sul de Mega Funk, (b) ligacao com funk bruxaria/techfunk (DJ Arana, DJ K, DJ Blakes e correlatos), (c) producao declaradamente eletrofunk/brazilian bass, (d) generos totalmente fora do funk.
4. Classificacao por ALBUM quando o catalogo do artista cruza subgeneros (ex.: Mc Jacaré tem um album chamado literalmente 'Eletrofunk Raiz' entre discos de funk raiz convencional; MC Kevin o Chris tem um album inteiro de remixes house/electro).
5. Nao foi aberto, movido ou renomeado nenhum arquivo -- isso e tarefa do CMR-298 (comando de mover no app), ainda nao implementado.


## Ajuste do CEO (14/10/2026)

Bruxaria (DJ K, DJ Arana, DJ Blakes e demais linhas justificadas por "bruxaria") é **Funk Brasileiro**, não Techfunk. Techfunk fica só para funk com base techno/trance de fato. Observação do CEO: a classificação deveria ter usado os vetores MERT (vizinhança acústica) para diferenciar subgêneros, não só nomes e web; a próxima passada parte de âncoras aprovadas por ele e agrupa o resto por similaridade MERT.
