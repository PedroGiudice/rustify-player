# MERT: qual camada guarda o estilo da música? (CMR-299)

Data: 14/10/2026. Script: `scripts/curator/mert_layer_probe.py`. Testes: `scripts/curator/test_mert_layer_probe.py`.

## O que foi medido

1. O app guarda só a ÚLTIMA das 13 camadas do MERT. A medição anterior mostrou que ela quase não separa os subgêneros do funk.
2. Aqui foram extraídas as 13 camadas (0 a 12) e a média delas, para 581 faixas, com o mesmo áudio e o mesmo modelo do app.
3. Conjunto: 257 faixas do funk aprovadas pelo CEO (Funk Brasileiro 223, Eletrofunk 24, Mega Funk 9, MPB 1) e 324 faixas de 7 playlists (até 50 por playlist, no máximo 3 por artista, semente fixa).
4. Teste: para cada faixa, o programa esconde TODAS as faixas do mesmo artista e tenta adivinhar o rótulo pelos 7 vizinhos mais parecidos (leave-one-artist-out, k=7). Os vetores são centrados pela média do conjunto.
5. O eixo do funk usa só os 3 subgêneros (256 faixas; a MPB solitária fica de fora). O eixo das playlists usa só as 7 externas.

## Prova de fidelidade

O vetor da camada 12 que calculei foi comparado com o vetor `mert` que o app guardou no Qdrant, faixa a faixa.

| | cosseno |
|---|---|
| Mínimo | 0,9815 |
| Mediana | 0,9996 |
| Média | 0,9993 |
| Faixas abaixo de 0,99 | 4 de 581 |

As 4 faixas abaixo de 0,99 são de eletrônica (0,981 a 0,989). Não investiguei o motivo. A mediana é praticamente 1: o pipeline reproduz o do app.

Achado que mudou o método: o app NÃO usa o centro da faixa inteira. O decodificador para com cerca de 60 s de áudio (`decode_flac`, "early termination") e só então toma os 30 s centrais. Na prática, o app embute dos 15 s aos 45 s da faixa. Com o centro verdadeiro da faixa, a mediana de fidelidade era 0,956 e o mínimo 0,47. Com a janela de 15 s a 45 s ficou 0,9996. Os números abaixo usam a janela de 15 s a 45 s.

## Resultados por camada

Acurácia balanceada = média do acerto por classe. Ela não deixa a classe grande enganar. Sorteio puro daria 0,33 no funk (3 classes) e 0,14 nas playlists (7 classes).

Gap de estilo = cosseno médio entre faixas do mesmo rótulo e artistas diferentes, menos o cosseno médio entre faixas de rótulos diferentes. Quanto maior, mais a camada junta quem tem o mesmo estilo.

| Camada | Funk: acurácia simples | Funk: acurácia balanceada | Playlists: acurácia balanceada | Gap de estilo (funk) | Gap de estilo (playlists) |
|---|---|---|---|---|---|
| 0 | 0,832 | 0,380 | 0,424 | -0,004 | 0,088 |
| 1 | 0,852 | 0,425 | 0,526 | 0,002 | 0,095 |
| 2 | 0,836 | 0,431 | 0,526 | 0,004 | 0,102 |
| 3 | 0,836 | 0,431 | 0,581 | 0,004 | 0,112 |
| 4 | 0,852 | **0,462** | 0,590 | 0,004 | 0,126 |
| 5 | 0,859 | 0,453 | 0,606 | 0,005 | 0,133 |
| 6 | 0,859 | 0,453 | **0,620** | **0,007** | 0,138 |
| 7 | 0,871 | 0,445 | 0,603 | 0,005 | **0,149** |
| 8 | 0,863 | 0,429 | 0,589 | 0,004 | 0,143 |
| 9 | 0,871 | 0,408 | 0,546 | 0,001 | 0,125 |
| 10 | 0,863 | 0,368 | 0,503 | 0,001 | 0,096 |
| 11 | 0,875 | 0,409 | 0,473 | 0,001 | 0,071 |
| 12 (a do app) | 0,871 | 0,346 | 0,457 | -0,001 | 0,063 |
| Média das 13 (bruta) | 0,852 | 0,413 | 0,569 | 0,003 | 0,113 |
| Média das 13 (cada camada normalizada antes) | 0,852 | 0,425 | 0,566 | 0,003 | 0,118 |

A acurácia simples do funk (0,83 a 0,88) engana: 87% das faixas já são Funk Brasileiro. Quem chuta sempre "Funk Brasileiro" acerta 0,87.

Cosseno médio entre faixas do mesmo artista (referência de "som parecido de verdade"): funk 0,089 na camada 12 e 0,100 a 0,139 nas demais; playlists 0,136 na camada 12 e até 0,187 na camada 8.

Recall por classe no funk (camada 12 / camada 4 / camada 6): Funk Brasileiro 1,00 / 0,93 / 0,94; Eletrofunk 0,04 / 0,46 / 0,42; Mega Funk 0,00 / 0,00 / 0,00. Nenhuma camada, nem as médias, acertou uma única faixa de Mega Funk (são 9).

Recall por playlist, camada 12 contra camada 6: Rap 0,58 / 0,82; Eletrônica 0,50 / 0,62; MPB 0,46 / 0,58; Jazz 0,26 / 0,64; Rock 0,48 / 0,70; Trance 0,52 / 0,58; Funk & Soul 0,40 / 0,40.

## Tempo de inferência

3,5 s por faixa em média (13 camadas, 8 threads, dentro do `rustify-embed`, com o serviço no ar). Total de 34 minutos para as 581 faixas. Ficou abaixo de 6 s, então a amostra de 50 por playlist foi mantida. MPB externa teve só 24 faixas por causa do teto de 3 por artista.

## O que os números dizem

- Playlists (gênero amplo): as camadas do meio são bem melhores que a última. A melhor acurácia balanceada é a da camada 6 (0,620), contra 0,457 da camada 12. O maior gap de estilo é o da camada 7 (0,149), mais que o dobro do da camada 12 (0,063). As camadas 5 a 8 ficam todas no topo.
- Funk (subgênero): nenhuma camada separa bem. O gap de estilo é praticamente zero em todas (no máximo 0,007). A melhor acurácia balanceada é a da camada 4 (0,462), mas o ganho sobre a camada 12 (0,346) vem de acertar parte do Eletrofunk (11 de 24 contra 1 de 24). Mega Funk continua em zero. Com só 24 e 9 faixas nas classes pequenas, a diferença entre as camadas 2 a 8 está dentro do ruído.
- A média das 13 camadas fica entre a última e as do meio nos dois eixos. Não supera a melhor camada isolada.
- A última camada, a que o app usa, é a pior ou quase a pior nos dois eixos de playlists e de funk.

## Limites

- Amostra pequena nas classes do funk (Eletrofunk 24, Mega Funk 9). Diferenças de poucos pontos na acurácia balanceada do funk não são confiáveis.
- Os rótulos do funk são os da proposta aprovada, definidos por artista. Faixas do mesmo artista nunca ficam juntas no teste.
- O vetor tem um único corte de 30 s (15 s a 45 s). Isso é o que o app faz, mas uma faixa que muda de estilo depois dos 45 s não é vista.
- 36 faixas (DJ Arana e DJ Piu) não saem do `ffmpeg` (o demuxer não entrega pacotes). Foram decodificadas pelo GStreamer, com a mesma regra de janela. A fidelidade delas ficou normal (mínimo 0,9908, mediana 0,9991).

## Reuso

Vetores das 13 camadas e a lista do conjunto ficam fora do repositório, em `/tmp/claude-1000/-home-opc-rustify-player/f45e305c-0261-4309-91b6-62db4c0b59fb/scratchpad/mert-layers/` (`layers.npz`, `set.json`, `resultados.json`). Rodar de novo: `python3 scripts/curator/mert_layer_probe.py all --work <dir>` (precisa do túnel 16333, ssh na cmr-auto e acesso ao Docker da VM). Só leitura no Qdrant e na cmr-auto; o container `rustify-embed` não é reiniciado nem editado (a sonda copia o próprio arquivo para `/tmp/mertprobe` dentro dele e apaga no fim).
