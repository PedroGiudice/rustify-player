# Piloto funk BR: Bandcamp + SoundCloud (12/10/2026)

Relatório gerado pelo workflow de curadoria (5 varreduras + verificação por URL +
síntese; 29 agentes). Dados brutos em `12102026-piloto-funk-br-candidatos.json`
(121 aprovados com URL, 6 em dúvida, diagnóstico de ferramentas).

Execução (fechada em 12/10, exceto os pagos):
- Bandcamp NYP: 6 releases, 35 FLAC via `bcdl-free`, normalizados com
  `scripts/curator/normalize_release.py`, em `~/Music/Funk Brasileiro` na cmr-auto.
- SoundCloud: 15 de 17 singles baixados do ARQUIVO ORIGINAL com `scdl --auth-token`
  (cookie `oauth_token` extraído do Chrome da cmr-auto para `~/.secrets`): 9 WAV
  (2 em 24 bit) e 6 MP3 320 convertidos para FLAC com COMMENT `source: lossy mp3`.
  Fora: DJ Piu "Bumbum na Nuca" (original MP3 128) e DJ John Saucer (gate externo).
- Tudo indexado (1851 pontos), MERT 1851/1851, vibe 1851/1851
  (`2026-10-12-opus-vibe-annotations-piloto-funk-35.json` e `-lote2-30.json`, este
  com 15 do Black Alien que o CEO adicionou no mesmo dia). slskd reescaneado
  (`shares.start_scan`): 2917 -> 3363 arquivos ofertados.
- Pendente: 6 releases pagos (~US$ 27) aguardando compra do CEO; cookie `identity`
  do Bandcamp já em `~/.secrets/bandcamp-identity.txt` para o `bcdl-free --identity`.

---

# Piloto Funk Brasileiro: Bandcamp + SoundCloud (12/10/2026)

## Resumo

- **80 faixas** em 29 releases, 10 subcenas, nenhum artista com mais de 2 releases, nada de megapop, nada já presente no acervo (53 faixas conferidas no Qdrant real da cmr-auto: 0 duplicatas; a frente SoundCloud já tinha 0/40).
- **52 faixas free/NYP** (6 releases Bandcamp name-your-price com FLAC + 17 faixas SoundCloud com download nativo ou gate Hypeddit) e **28 faixas pagas** em 6 releases Bandcamp, todas com FLAC.
- **Custo das pagas: EUR 13 + US$ 14** nos mínimos (cerca de US$ 28 somados, na ordem de R$ 150 a 170 conforme o câmbio do dia); metade disso é o PANICO NO SUBMUNDO do DJ K, prioridade 1.

## Lista free / NYP (52 faixas)

| # | Artista | Release | Fonte | Disp. | Faixas | Subcena | Por quê |
|---|---|---|---|---|---|---|---|
| 1 | OO Rubinho | Bruxaria Cósmica (2023) | [Bandcamp](https://oorubinho.bandcamp.com/album/bruxaria-c-smica) | nyp | 7 | selo / experimental (funkcore, hardfunk) | Vizinho do HARDFUNK já no acervo; download NYP testado, saiu FLAC 24-bit |
| 2 | A Baile (D.A.N.V, DJ Kingdom, VKKramer) | A Baile, Vol. 1 (2025) | [Bandcamp](https://abaile.bandcamp.com/album/a-baile-vol-1) | nyp | 12 | funk BH (coletivo) | Expande BH além do Anderson; primeiro coletivo BR no Boiler Room; FLAC 24-bit |
| 3 | DJ Johnny Souza | Mundo Souza (2024) | [Bandcamp](https://djjohnnysouza.bandcamp.com/album/mundo-souza-2024) | nyp | 5 | funk carioca 150/180 experimental | O 150 do Rio pelo lado experimental; faixas de 1 a 2 min |
| 4 | Kioma, Buarky, kLap e Mu540 | Funk Rave EP (2020) | [Bandcamp](https://funknacaixa.bandcamp.com/album/funk-rave-ep) | nyp | 4 | funk rave SP (Funk na Caixa) | Documento do funk rave de SP com Mu540, nome que o acervo não tem |
| 5 | BadSista | BadSista EP (2016) | [Bandcamp](https://funknacaixa.bandcamp.com/album/badsista-ep) | nyp | 6 | rasterinha / neo baile SP | Subcena rasterinha ausente; único release da artista sem piso de preço |
| 6 | dj paran0ia | gqom automotivo (2023) | [Bandcamp](https://djparanoia.bandcamp.com/album/gqom-automotivo-free-dl) | nyp | 1 | funk BH experimental x gqom | Amostra grátis do produtor cujos álbuns (US$ 10 e 12) ficam para a próxima leva |
| 7 | DJ Arana | Festa do Pente Rala (2024) | [SoundCloud](https://soundcloud.com/user-577945535/festa-do-pente-rala-dj-arana) | free (nativo) | 1 | mandelão SP | Lançamento recente do artista mais tocado do acervo; sufixo .mp3 no título; perfil não verificado |
| 8 | DJ Arana | Um Cara Tranquilo (2026) | [SoundCloud](https://soundcloud.com/user-577945535/um-cara-tranquilo-dj-arana) | free (nativo) | 1 | mandelão SP | Faixa de abril/2026 sem sufixo de formato (pode ser WAV); teste do download original |
| 9 | DJ Léo da 17 | Pega Meu Piru (MC MN, c/ DJ K) (2020) | [SoundCloud](https://soundcloud.com/djleoda17/pega-meu-piru-mc-mn-dj-leo-da) | free (nativo) | 1 | mandelão SP / bruxaria (DZ7) | Coprodução com DJ K, nome novo pro acervo |
| 10 | DJ Blakes | Montagem Iraque - Netflix Que Nada (2020) | [SoundCloud](https://soundcloud.com/djblakes/montagem-iraque-netflix-que-nada-dj-blakes-mc-nem-jm-e-mc-mn-2020) | free (nativo) | 1 | mandelão SP | Citado pela RA e pelo funk.BR da NTS; única faixa dele baixável |
| 11 | DJ Piu | Bumbum na Nuca 2020 (MC GW) | [SoundCloud](https://soundcloud.com/djpiuoficial/mc-gw-e-dj-piu-bumbum-na-nuca-2020) | free (nativo) | 1 | mandelão SP | Faixa do DJ com mais faixas no acervo (50) que não está lá |
| 12 | DJ LA Beat & DJ K9 | Convocação da Bruxaria (2020) | [SoundCloud](https://soundcloud.com/djlabeat/convocacao-dos-bruxos-mc-th-e-mc-bn-dj-la-beat-dj-k9-2020) | free (nativo) | 1 | bruxaria | 186 mil plays, perfil verificado, cota aberta |
| 13 | MAC10TA | Bruxaria do Beco da Morte (2025) | [SoundCloud](https://soundcloud.com/mac10ta/bruxaria-do-beco-da-morte-wav) | free (nativo) | 1 | bruxaria online SP | Slug termina em -wav, indício de original lossless |
| 14 | CyberKills | Mandelão da Toranja 160BPM (FKA twigs) (2022) | [SoundCloud](https://soundcloud.com/cyberkills/fka-twigs-cyberkills-mandelao-da-toranja-160bpm) | free (nativo) | 1 | mandelão x pop | Mesmo gosto dos remixes PinkPantheress x Adame; lossless garantido no Bandcamp por EUR 1,50 |
| 15 | DJ John Saucer | You Will See Beat Bolha (2025) | [SoundCloud](https://soundcloud.com/djjohnsaucer/you-will-bolha-dj-john-1) | free (gate Hypeddit) | 1 | beat bolha (Brasília) | Subcena ausente; artista declara 'FREE DOWNLOAD EM WAV'; testa o fluxo com gate |
| 16 | Adame DJ | Job (2026) | [SoundCloud](https://soundcloud.com/adamedj/job) | free (nativo) | 1 | funk capixaba (ES) | Lançamento de março/2026 do Adame, ausente do Bandcamp dele; página sem gênero, confirmar ao ouvir |
| 17 | DJ Gui Marques | Mandelão MC Mr Bim (c/ Vitn MPC) (2018) | [SoundCloud](https://soundcloud.com/djguimarques/mandelao-mc-mr-bim-gui-marques-vitn-mpc) | free (nativo) | 1 | mandelão de BH | 643 mil plays, perfil verificado |
| 18 | DJ Anderson do Paraiso | Última Bruxaria do Ano (2022) | [SoundCloud](https://soundcloud.com/djandersondoparaiso/ultima-bruxaria-do-ano-dj-anderson-do-paraiso) | free (nativo) | 1 | funk BH / bruxaria | Fora das 9 faixas do artista no acervo (owned=false); perfil verificado |
| 19 | DJ WIN | Vou Voltar Nada (MC Braz e Rick) (2022) | [SoundCloud](https://soundcloud.com/djwinoficial/mc-braz-e-rick-vou-voltar-nada) | free (nativo) | 1 | funk BH | Título termina em .wav: original provavelmente lossless |
| 20 | DJ Ramon Sucesso | Emporio Armani no Corpo (MC Henry) (2023) | [SoundCloud](https://soundcloud.com/ramon-sucesso-15722/mc-henry-emporio-armani-no-corpo-dj-ramon-sucesso) | free (nativo) | 1 | funk carioca / ritmada | Deep cut do DJ que a Lugar Alto lançou em vinil |
| 21 | DJ Rogerinho do Querô | Sequência do Vapo Vapo vs Brega Funk (2019) | [SoundCloud](https://soundcloud.com/rogerinhodoquero/sequencia-do-vapo-vapo-vs-brega-funk-dj-rogerinho-do-quero) | free (nativo) | 1 | funk carioca (Baixada) x brega funk | 1,2 milhão de plays; abre a adjacência brega funk |
| 22 | DJ RD do Martins | 10 Minutinhos Tambor + Grave (2024) | [SoundCloud](https://soundcloud.com/djrddomartins/10-minutinhos-tambor-grave-dj-rd-do-martins-dum-dum-dum) | free (nativo) | 1 | tamborzão carioca (set 22 min) | Tamborzão puro, 1 milhão de plays; entra como faixa única de mix |
| 23 | DJ Fernando Souza | Mega Funk Menó Neurose, Se Prepara 3 (2026) | [SoundCloud](https://soundcloud.com/megafunkcwb_music/mega-funk-meno-neurose-djfernando_souza) | free (nativo) | 1 | mega funk (Curitiba) | Subcena do Sul quase ausente; canal do próprio produtor (não é o homônimo de tribal house) |

Pastas de destino seguem `Funk Brasileiro/<Artista>/<Release>` (sem ano). Para o Anderson usar a grafia sem acento, `DJ Anderson do Paraiso`, que é a da pasta maior do acervo (há uma duplicata só por acento a unificar).

## Lista paga (28 faixas, para decisão de compra)

| # | Artista | Release | Selo | Preço mínimo | Faixas | Subcena | Por quê |
|---|---|---|---|---|---|---|---|
| 1 | DJ K | [Panico no Submundo](https://nyegenyegetapes.bandcamp.com/album/panico-no-submundo) (2023) | Nyege Nyege Tapes | EUR 8 | 15 | bruxaria (Heliópolis) | Disco-marco da bruxaria; o acervo só tem o sucessor Radio Libertadora!. Prioridade 1 |
| 2 | Iguana | [Escama](https://iguanaslair.bandcamp.com/album/escama) (2025) | Acta Recordings | US$ 5 | 5 | mandelão experimental SP | Ponte entre Arana/Piu e o lado experimental; EP de estreia do dono da Acta |
| 3 | Adame DJ | [Rolê](https://boysnoizerecords.bandcamp.com/album/rol) (2025) | Boysnoize Records | EUR 5 | 4 | funk capixaba x techno | Adame com MCs na Boysnoize; nenhuma faixa repete as 9 do acervo |
| 4 | DJ Ramon Sucesso | [Sexta dos Crias](https://djramonsucesso.bandcamp.com/album/sexta-dos-crias) (2023) | Lugar Alto | US$ 7 | 2 | montagem carioca experimental | Cena de selo (Honest Jon's); duas montagens de 16 e 17 min em FLAC 24-bit |
| 5 | Zero de Fato | [Pique Rugal Beat Laser do Bololo x Tava no Fluxo Maligno da Bruxaria](https://zerodefato.bandcamp.com/track/pique-rugal-beat-laser-do-bololo-x-tava-no-fluxo-maligno-da-bruxaria) (2024) | autolançado | US$ 1 | 1 | bruxaria x UK garage (RS) | Cena gaúcha; compra simbólica para validar o fluxo pós-compra |
| 6 | DJ Ricardo Paiva | [Bruxaria 8000 (Pararapapa)](https://djricardopaiva.bandcamp.com/track/bruxaria-8000-pararapapa) (2025) | autolançado | US$ 1 | 1 | bruxaria / favela bass SP | Segunda compra simbólica, produtor-pesquisador da cena |

Total: EUR 13 + US$ 14 nos mínimos. Todos os preços são 'ou mais' (pay-what-you-want com piso), lidos nas páginas em 12/10/2026.

## Cobertura por subcena

O piloto cobre dez subcenas: mandelão de SP (Arana, Léo da 17, Blakes, Piu, Iguana), bruxaria (DJ K, LA Beat & K9, MAC10TA, Zero de Fato, Ricardo Paiva), funk de BH (A Baile, Gui Marques, Anderson, DJ WIN, paran0ia), funk carioca em suas camadas tamborzão, ritmada e 150 (Johnny Souza, Ramon Sucesso, RD do Martins, Rogerinho), cena de selo e experimental (OO Rubinho, Lugar Alto, Acta, Nyege Nyege), funk rave e rasterinha de SP (Funk na Caixa), beat bolha (John Saucer), mega funk do Sul (Fernando Souza), funk capixaba cruzado com techno (Adame) e remix de pop em mandelão (CyberKills). O eixo mais forte do gosto observado (mandelão SP) entra com 6 faixas novas de 5 produtores, três deles já no acervo (Arana, Piu, Léo da 17 via DZ7); o eixo BH ganha 19 faixas; o carioca, 10. A regra de no máximo 2 releases por artista foi respeitada (Arana, Adame e Ramon Sucesso têm 2 cada). Pela natureza das fontes, o lado SoundCloud é todo de faixas avulsas e o Bandcamp concentra os releases completos.

## O que ficou de fora e por quê

- **Já no acervo**: Paraiso Sombrio (8/8 faixas no Qdrant) e Queridão (pasta e 1 faixa existem; comprar completaria a pasta por EUR 7, mas o piloto não aceita in_acervo=true, fica para decisão à parte).
- **Teto de 80 faixas**: 70 releases aprovados ficaram como reserva por volume, não por mérito. Primeiros da fila: NTS funk.BR São Paulo (22 faixas, GBP 10, panorama da cena com Arana, K, P7, Blakes, Deekapz), DJ RaMeMes Sem Limites (QTV, 8, US$ 5), Mega das Comunidades de BH (6, US$ 6, inclui a faixa que é o Mega 6.0 com 2,6 milhões de plays), VINÍ ADIANTE (4, US$ 2), Man Recordings Baile Funk Montagems (9, EUR 10) e Baile Funk Masters #1 (Sandrinho, 7, EUR 8), DJ Kingdom Feroz & Furiosa (6, NYP), MAKHNO FETICHE (9, grátis, títulos escatológicos), pipa FUNK É MATEMÁTICA (8, NYP, mais ambient/idm que funk), XXIII // 150 (13, NYP, metade produtores europeus), Terror Se Liga na Pista (4, NYP, produtor português), e as faixas SC de DJ João da Inestan, DJ LV MDP, DJ Caio Vieira (perfil não verificado), DJ LC da Roça, DJ LK de Itapê, Projeto Nostalgia e Montagem Bruxaria do Diabo (Léo da 17), Caio Prince (set 19 min), petrus.wav/Kazais e sobraw.
- **SPEEDTEST VOLT MIX: O Retorno (Lado A)**: NYP legítimo, mas 63 faixas sozinho estourariam o teto e diluiriam a diversidade; vale como lote próprio se o CEO quiser volt mix em massa.
- **OO Rubinho combinações**: as duas páginas divergem (a do artista marca paid US$ 7 e sem stream, a do selo Business Casual marca NYP) e a frente de tags duvida que seja funk BR; resolver com o bc_probe no dia do download.
- **Preço alto para decisão humana**: Humildes Vol. 3 Lado A e Lado B (US$ 40 cada; a pasta Humildes de 22 faixas é o Vol. 2 incompleto, sem sobreposição confirmada), Mixagens e Assombrações (US$ 30), TToten Maluko e Vol. 5 (US$ 30 cada), Botano Remixes (EUR 29), DJ Dayeh De Rolê na 011 (US$ 20), DJ Ariel (US$ 17,50), DJ Cris Fontedofunk e Drive do Adame 4 (US$ 15).
- **Dúvidas que não eram só de preço**: Acta Caudal (post-club internacional), Bailefunk Kakeko (vocais em japonês), DJ Arana BU KA NAM (gênero marcado Trance, subida hoje), QTV MIMOSA (funk só como vertente), IANCO Famoso Machuca Xot4 (terceira versão de música que o acervo já tem duas vezes).
- **Notas das varreduras**: as páginas de tag do Bandcamp estão atrás de desafio JS e só abriram pelo Chrome via API interna (38 tags, 945 itens, tags funk-sp, funk-bh e tamborzão quase vazias); a varredura de selos cobriu 21 catálogos completos e descartou Blum Discos, QTZL, Sinistra, Funk Machine (não existem ou não são funk BR); a frente SoundCloud varreu 37 perfis e 24 buscas pela API v2 e encontrou os artistas-âncora do acervo sem nada baixável (DJ K 0/81, DZ7 0/193, GBR com cota esgotada, Anderson 'DOWNLOAD' 21/21 esgotadas), gates Hypeddit mortos (leva dez/2025 do Adame) e perfis descartados por megapop (DJ Guuga) ou gosto (DJ Rhuivo); a frente de imprensa confirmou que os discos premiados (Mu540 4x4, Halc DJ, Alexia, XABLAU, RORO, Blakes Mandelãoworld, KN de Vila Velha, WS da Igrejinha) só existem em streaming; a frente de vizinhança não achou Piu, GB Faixa Preta, Jeeh FDC, GBR, Nattan, Luan Mark, Camarozano, JAUM, Drae, Dennis, Alok e Spinnin com download legítimo. Esses buracos são o caso de uso da camada 2 (streaming), fora desta etapa.
- **Ressalvas operacionais**: cota de download do SoundCloud pode esgotar até a hora de baixar; o perfil 'DJ ARANA OFICIAL' não é verificado (confirmar identidade ao ouvir); formato original no SoundCloud só se conhece ao baixar logado.

## Ferramentas

1. **Bandcamp free/NYP**: `bcdl-free` (free-bandcamp-downloader 0.5.1 via `uvx --python 3.12`) passa pelo Client Challenge e baixa FLAC/WAV; testado no Bruxaria Cósmica (FLAC 24-bit, 18 s). `bc_probe.py` (curl_cffi impersonate firefox) lê minimum_price e freeDownloadPage para classificar antes.
2. **Bandcamp comprado**: o mesmo `bcdl-free` com `--identity` (cookie `identity` do navegador logado da cmr-auto, guardado em ~/.secrets); a compra em si é manual no checkout. Não testado por falta do cookie; alternativas bannedcamp e bandcamp-collection-downloader correm risco de Client Challenge.
3. **Nunca usar yt-dlp, bandcamp-dl ou campdown no Bandcamp**: só entregam o stream MP3 128 (e o yt-dlp está quebrado para Bandcamp, issue 17618).
4. **SoundCloud original**: exige `oauth_token` de uma conta SoundCloud (gratuita); `scdl --only-original --original-name --auth-token` ou `yt-dlp --cookies-from-browser firefox -f download`. Sem login só sai stream AAC 160/MP3 128, inútil para o acervo. Gates Hypeddit: `hypeddit-dl` (Playwright) existe, mas com 2 faixas no piloto é mais barato fazer manual no navegador.
5. **Cota e formato**: filtrar `downloadable && has_downloads_left` pela API v2, não pelo título; `original_format` só aparece logado, então WAV/MP3 320 se descobre ao baixar (MP3 320 fica MP3, nunca converter para FLAC).
6. **Tagging**: sem beets/autotagger (cobertura MusicBrainz/Discogs para funk independente é baixa); usar `normaliza_tags.py` (mutagen + pillow): ARTIST/ALBUMARTIST canônicos, GENRE único 'Funk Brasileiro', DATE, TRACKNUMBER/TOTAL, capa JPEG 1000x1000; WAV vira FLAC pelo ffmpeg (não há binário flac na VM nem na cmr-auto). Depois, `~/Music/Funk Brasileiro/<Artista>/<Release>/` na cmr-auto e o indexer ingere.

## Próximo passo

Aprovação do CEO sobre (a) a lista free/NYP, que pode ser baixada hoje na cmr-auto sem custo, e (b) as 6 compras (EUR 13 + US$ 14). Antes do download: criar/obter o `oauth_token` do SoundCloud e o cookie `identity` do Bandcamp na cmr-auto, e verificar a cota das 17 faixas SC no dia.