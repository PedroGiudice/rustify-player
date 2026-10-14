# MERT: a camada do meio prevê melhor o que o CEO aceita no autoplay? (CMR-302)

Data: 14/10/2026. Script: `scripts/curator/mert_autoplay_eval.py`. Testes: `scripts/curator/test_mert_autoplay_eval.py`.
Continua `docs/contexto/14102026-mert-camadas.md` (camada x estilo). Nada mudou no app nem no banco.

## O que foi medido

1. Para as 2199 faixas do acervo, calculei de novo o vetor de som com os 30 s do MEIO REAL da faixa, guardando as 13 camadas do MERT.
2. Comparei 5 versões do vetor: `app` (o que o app usa hoje: camada 12, trecho de 15 a 45 s), `L12c` (camada 12, meio real), `L6c` e `L7c` (camadas 6 e 7, meio real) e `mid58c` (média das camadas 5 a 8, meio real).
3. Para cada faixa que o motor escolheu (autoplay e station), medi a semelhança entre ela e a última faixa que o CEO ouviu até o fim antes dela, na mesma sessão. Segunda leitura: semelhança com o "gosto" do momento.
4. Pergunta de cada número: "quanto mais parecida, mais chance de o CEO aceitar?". A nota é a AUC: 0,5 = não prevê nada; 1,0 = prevê tudo.
5. O intervalo (IC 95%) vem de 1000 sorteios de sessões inteiras. Se o intervalo da diferença entre duas versões cruza o zero, a diferença pode ser ruído.

## Quantos eventos

Eventos depois do sinal v3 (mesma regra da régua: `signal_schema >= 3`, legado por data). Aceite = `track_ended`; pulo = `track_skipped`.

| Origem | Eventos | Aceites | Sem semente | Com semente (usados) | Sessões |
|---|---|---|---|---|---|
| autoplay | 1582 | 407 | 128 | 1454 | 26 |
| station | 286 | 50 | 32 | 254 | 10 |

Todas as faixas desses eventos têm vetor (as 68 faixas do funk movidas hoje foram extraídas de novo com o id novo).

## Resultado principal: autoplay, semente -> faixa

O app mudou a regra do rádio na v0.2.75 (18/08). Antes, depois de um pulo, o motor buscava a próxima faixa a partir da faixa PULADA. Desde a v0.2.75, busca a partir da última faixa ACEITA. Isso muda o teste, então os números vão separados.

| Versão do vetor | Todos (n=1454) | Antes da v0.2.75 (n=771, 337 aceites) | Desde a v0.2.75 (n=683, 63 aceites) |
|---|---|---|---|
| app (camada 12, 15-45 s) | 0,743 [0,572; 0,784] | 0,785 [0,673; 0,838] | 0,520 [0,457; 0,585] |
| L12c (camada 12, meio) | 0,664 [0,585; 0,701] | 0,700 [0,613; 0,759] | 0,565 [0,493; 0,627] |
| L6c (camada 6, meio) | 0,625 [0,563; 0,678] | 0,682 [0,611; 0,754] | 0,579 [0,497; 0,660] |
| L7c (camada 7, meio) | 0,628 [0,567; 0,681] | 0,684 [0,613; 0,757] | 0,587 [0,504; 0,660] |
| mid58c (camadas 5-8, meio) | 0,624 [0,564; 0,675] | 0,676 [0,606; 0,749] | 0,583 [0,496; 0,664] |

Leitura:

- Antes da v0.2.75, o vetor do app "ganha" com folga. Isso NÃO é qualidade do vetor. Depois de um pulo, o motor andava para longe da última faixa aceita, e "longe" era medido justamente com o vetor do app. As faixas longe eram puladas de novo. O vetor do app prevê o próprio caminho do motor.
- Desde a v0.2.75 (o motor de hoje), o vetor do app não prevê nada (0,520, intervalo cruza 0,5). As versões do meio ficam em 0,58 a 0,59. Diferença contra o app: L7c +0,07 [-0,014; +0,150]; L6c +0,06 [-0,023; +0,151]; L12c +0,05 [-0,028; +0,113]. Todas cruzam o zero por pouco: tendência, não prova.

## Station, semente -> faixa

| Versão do vetor | Todos (n=254, 42 aceites) | Desde a v0.2.75 (n=159, 38 aceites) |
|---|---|---|
| app | 0,503 [0,397; 0,603] | 0,483 [0,370; 0,641] |
| L12c | 0,603 [0,478; 0,694] | 0,582 [0,441; 0,688] |
| L6c | 0,565 [0,481; 0,684] | 0,570 [0,452; 0,711] |
| L7c | 0,564 [0,466; 0,664] | 0,572 [0,466; 0,698] |
| mid58c | 0,569 [0,472; 0,672] | 0,575 [0,464; 0,702] |

No total da station, a diferença contra o app não cruza o zero para L12c (+0,10 [+0,028; +0,143]) e L6c (+0,06 [+0,011; +0,148]). Desde a v0.2.75 todas cruzam o zero por pouco. Base pequena: 10 sessões, 42 aceites. Antes da v0.2.75 a station tem só 4 aceites em 2 sessões; esse recorte não serve para nada.

A semente da station aqui é a última faixa aceita. O motor da station usa a definição da própria station, não essa faixa. Então essa leitura mede "a faixa nova combina com a anterior", não o critério do motor.

## Segunda leitura: gosto -> faixa

Gosto = os positivos do momento de cada evento (regra do `derive_behavioral_signals`, só com eventos ANTERIORES ao avaliado, mais até 10 likes de `track_enrichments` dados antes). Semelhança da faixa com a média desses positivos.

| Versão do vetor | Autoplay (n=1582) | Station (n=286) |
|---|---|---|
| app | 0,523 [0,441; 0,659] | 0,567 [0,473; 0,695] |
| L12c | 0,526 [0,471; 0,672] | 0,586 [0,477; 0,739] |
| L6c | 0,514 [0,464; 0,683] | 0,556 [0,468; 0,723] |
| L7c | 0,529 [0,480; 0,685] | 0,557 [0,468; 0,720] |
| mid58c | 0,522 [0,473; 0,683] | 0,553 [0,458; 0,716] |

Nenhuma versão prevê aceite pelo gosto. Todas ficam perto de 0,5, e as diferenças são ruído.

## Janela ou camada?

Medido no autoplay desde a v0.2.75 (o motor de hoje):

- Efeito da JANELA (L12c menos app, mesma camada): +0,045 [-0,028; +0,113]; a diferença foi <= 0 em 11% dos sorteios.
- Efeito da CAMADA (L6c menos L12c, mesma janela): +0,014 [-0,041; +0,081]; <= 0 em 32% dos sorteios.

A maior parte do ganho aparente vem da janela (meio real da faixa), não da camada. Nenhum dos dois passa no teste de ruído com os dados de hoje. Na station o efeito da janela é parecido (+0,10 [-0,015; +0,142], <= 0 em 3%); o da camada é zero.

## Conclusão

Com o motor de hoje, o vetor que o app usa não prevê o que o CEO aceita (AUC 0,52), e o vetor com o meio real da faixa, em qualquer camada, prevê um pouco melhor (0,57 a 0,59), mas a diferença ainda está no limite do ruído.

## Limites

- Poucas sessões: 19 no autoplay desde a v0.2.75, e no autoplay todo as 5 maiores sessões somam metade dos eventos (718 de 1454). Os intervalos são largos por isso.
- Desde a v0.2.75, só 63 aceites no autoplay (skip de 91% nesse recorte).
- O teste olha só para as faixas que o motor ESCOLHEU com o vetor do app. Não dá para saber como o CEO reagiria a faixas que outro vetor escolheria.
- A semente é inferida (última faixa aceita na sessão, sessão = intervalo de até 30 min no mesmo aparelho). O `context_id` dos eventos é o id da rodada (`radio:<hora>`), não a faixa-semente, então não ajuda. O primeiro evento da sessão, sem aceite antes, fica fora (128 no autoplay, 32 na station). Se a faixa-semente for a mesma do evento, também fica fora.

## Dados e reuso

- Vetores (float16, 13 camadas x 768 por faixa, índice por track_id e caminho): `~/.local/share/rustify-curator/mert-layers-20261014/batches/` (um `.npz` + `.json` por lote). Avaliação completa: `avaliacao.json` na mesma pasta.
- Extração: 2199 faixas em 6405 s (1 h 47 min, 2 processos de 7 threads no `rustify-embed`, cerca de 2,9 s por faixa). 68 faixas sumiram do caminho no meio (lote do funk sendo movido) e foram extraídas de novo na passada final, com o id novo. 38 faixas saíram pelo GStreamer porque o ffmpeg não lia.
- Rodar de novo: `uv run --with numpy python3 scripts/curator/mert_autoplay_eval.py extract` (só extrai os ids que faltam) e depois `... evaluate`. Precisa do túnel 16333, ssh na cmr-auto e Docker na VM. Só leitura no Qdrant e na cmr-auto; o container não é reiniciado nem editado (o script copia a si mesmo para `/tmp` dentro dele e apaga no fim).
