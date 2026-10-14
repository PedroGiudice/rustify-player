# Autoplay: o que separa a faixa que você aceita da que você pula (CMR-123)

Data: 14/10/2026. Script: `scripts/metrics/autoplay_forense.py`. Testes: `scripts/metrics/test_autoplay_forense.py`.
Continua `docs/contexto/14102026-mert-camadas-autoplay.md` (a semelhança de som com a faixa anterior não prevê o aceite).
Só leitura. Nada mudou no app nem no banco.

## Resumo em quatro frases

1. O que mais separa aceite de pulo é você já conhecer e gostar da faixa: o rádio acerta quando toca o que você já ouviu até o fim muitas vezes ou já curtiu.
2. O motor de hoje serve sobretudo faixas que você quase nunca ouviu até o fim: 72% das escolhas do autoplay são faixas que você ouviu inteiras no máximo 2 vezes, e nelas você pula 95%.
3. Três de cada quatro pulos acontecem nos primeiros 5 segundos, quase sempre em rajadas de "próxima, próxima, próxima". Mesmo descontando essas rajadas, o pulo do autoplay fica em 72%, ainda acima da meta de 55%.
4. Parecença com a faixa anterior (som, energia, valência, mesmo artista) quase não importa. Estar na mesma playlist ajuda um pouco.

## Como foi medido

- Eventos de autoplay e station depois do sinal v3 (mesma regra da régua). Aceite = a faixa terminou; pulo = você pulou (mesmo que tarde: 42 pulos do autoplay passaram de 50% da faixa).
- Período principal: desde a v0.2.75 (18/08), quando o rádio passou a lembrar o que você pulou na sessão. O período anterior (12/08 a 18/08) aparece só como contraste.
- Sessão = sequência no mesmo aparelho sem pausa de mais de 30 min. Semente = a última faixa que você ouviu até o fim antes, na mesma sessão.
- Para cada característica: quanto ela separa aceite de pulo. Para sim/não, a diferença na taxa de aceite. Para números, a AUC (0,5 = não separa nada; acima de 0,5 = valor maior, mais aceite; abaixo, o contrário).
- O intervalo [IC 95%] vem de 1000 sorteios de sessões inteiras. Se o intervalo cruza o zero (ou o 0,5 da AUC), pode ser acaso.
- Playlist na data do evento: as faixas de rap e funk mudaram de pasta em 14/10; para eventos anteriores usei a pasta antiga, pelos registros de lote. Nenhum evento é de 14/10 (o último é de 12/10), então todos usam a pasta antiga. Mudanças de pasta antes de 14/10 não têm registro e não foram reconstruídas.

## Quantos eventos

| Origem | Período | Eventos | Aceites | Pulo | Sessões |
|---|---|---|---|---|---|
| autoplay | desde a v0.2.75 | 806 | 68 | 92% | 21 |
| autoplay | 12/08 a 18/08 | 776 | 339 | 56% | 8 |
| station | desde a v0.2.75 | 186 | 44 | 76% | 8 |
| station | 12/08 a 18/08 | 100 | 6 | 94% | 3 |

As 5 maiores sessões do autoplay desde a v0.2.75 somam 459 dos 806 eventos (a maior, no S24, tem 150). Na station, as 5 maiores somam 161 de 186: sem elas sobram 25 eventos em 3 sessões, o que não serve para nada. A station tem pouca base; leia os números dela como pista.

## Tabela das hipóteses: autoplay desde a v0.2.75

Três recortes: todos os eventos; sem as 5 maiores sessões; sem os pulos de até 5 s.

| Hipótese | Todos (n=806) | Sem as 5 maiores sessões (n=347) | Sem pulos até 5 s (n=240) |
|---|---|---|---|
| 1. Diferença de energia semente->faixa (AUC) | 0,49 [0,40; 0,57] | 0,48 [0,38; 0,61] | 0,56 [0,46; 0,66] |
| 1. Diferença de valência semente->faixa (AUC) | 0,54 [0,44; 0,63] | 0,53 [0,40; 0,67] | 0,51 [0,42; 0,57] |
| 2. Mesmo artista da semente (aceite sim x não) | 23% x 8% (n sim=44), dif +0,14 [-0,05; +0,29] | +0,02 cruza o zero (n sim=12) | +0,16 [-0,16; +0,35] |
| 3. Mesma playlist da semente | 11,6% x 3,8%, dif +0,08 [+0,02; +0,13] | +0,07 [-0,01; +0,16] | 32% x 17%, dif +0,15 [-0,01; +0,30] |
| 4. Faixa nunca tocada antes | 10,8% x 8,3% (n sim=37), dif +0,03 [-0,10; +0,17] | -0,04 [-0,14; +0,14] | +0,30 [-0,30; +0,69] (n sim=7) |
| 4. Nº de plays anteriores, qualquer desfecho (AUC) | 0,64 [0,53; 0,74] | 0,71 [0,59; 0,81] | 0,64 [0,49; 0,76] |
| 4. Nº de vezes ouvida até o fim antes (AUC, extra) | **0,72 [0,62; 0,82]** | **0,79 [0,69; 0,87]** | **0,69 [0,56; 0,81]** |
| 5. Faixa curtida antes | **27,7% x 5,9%, dif +0,22 [+0,12; +0,35]** | **40% x 6,7%, dif +0,33 [+0,20; +0,50]** | **52% x 22%, dif +0,30 [+0,13; +0,48]** |
| 6. Vezes servida nos 7 dias anteriores (AUC) | 0,55 [0,50; 0,62] | 0,59 [0,54; 0,67] | 0,55 [0,50; 0,62] |
| 6. Vezes servida nos 30 dias anteriores (AUC) | 0,58 [0,52; 0,65] | 0,56 [0,47; 0,69] | 0,60 [0,50; 0,70] |
| 7. Duração da faixa (AUC) | 0,44 [0,37; 0,53] | 0,49 [0,33; 0,63] | 0,40 [0,31; 0,48] |
| 8. Posição na sessão (AUC) | 0,45 [0,34; 0,55] | 0,45 [0,32; 0,59] | 0,46 [0,36; 0,56] |
| 8. Duração da sessão (AUC) | 0,47 [0,33; 0,58] | 0,56 [0,37; 0,73] | 0,48 [0,34; 0,58] |
| 9. Noite, 18h-24h (aceite sim x não) | 6,7% x 17,7%, dif -0,11 [-0,21; -0,04] | -0,12 [-0,34; +0,00] | 24% x 42%, dif -0,18 [-0,27; -0,07] |
| 9. Madrugada, 0h-6h | +0,06 [-0,01; +0,19] | +0,10 [-0,07; +0,35] | +0,14 [-0,01; +0,27] |
| 9. Sábado e domingo | +0,00 [-0,11; +0,13] | -0,09 [-0,17; +0,01] | -0,02 [-0,25; +0,11] |
| 10. Celular (S24) x desktop | 8,3% x 8,9%, dif -0,01 [-0,05; +0,08] | +0,00 | -0,06 [-0,17; +0,13] |

Em negrito: o que separa nos três recortes, com intervalo longe do acaso.

Aceite por número de vezes que a faixa já tinha sido ouvida até o fim (autoplay desde a v0.2.75):

| Ouvida até o fim antes | Escolhas do motor | Aceite | Pulo |
|---|---|---|---|
| 0 vezes | 273 (34%) | 3,7% | 96% |
| 1 a 2 vezes | 307 (38%) | 5,9% | 94% |
| 3 a 9 vezes | 170 (21%) | 11,8% | 88% |
| 10 vezes ou mais | 56 (7%) | 35,7% | 64% |

## Station desde a v0.2.75 (n=186, 44 aceites, 8 sessões)

| Hipótese | Efeito |
|---|---|
| 1. Diferença de energia (AUC) | 0,38 [0,22; 0,42]: energia parecida com a da semente, mais aceite (29% x 18%) |
| 1. Diferença de valência (AUC) | 0,40 [0,28; 0,48]: mesmo sentido |
| 2. Mesmo artista | só 3 casos |
| 3. Mesma playlist | -0,02 [-0,17; +0,10] |
| 4. Nunca tocada | -0,07 [-0,23; +0,23] |
| 4. Vezes ouvida até o fim antes (AUC) | 0,63 [0,47; 0,74] |
| 5. Curtida | 42% x 22%, dif +0,21 [+0,05; +0,44] |
| 6. Servida em 7 / 30 dias (AUC) | 0,54 / 0,54, cruzam 0,5 |
| 7. Duração (AUC) | 0,45 [0,28; 0,54] |
| 8. Posição na sessão (AUC) | 0,61 [0,54; 0,72]: aceita mais no meio da sessão |
| 9. Fim de semana | +0,17 [-0,03; +0,23] |
| 10. S24 x desktop | 15% x 28%, dif -0,13 [-0,25; +0,03] |

Na station, ao contrário do autoplay, a energia e a valência parecidas com a semente ajudam. Lembrete: a semente aqui é a última faixa aceita, não a definição da station que o motor usa.

## Tempo de escuta antes do pulo

| | Autoplay desde a v0.2.75 | Station desde a v0.2.75 | Autoplay 12/08 a 18/08 |
|---|---|---|---|
| Pulos | 738 | 142 | 437 |
| Metade dos pulos acontece até | 1,3 s | 2,0 s | 0,6 s |
| Pulos até 1 s | 44% | 19% | 68% |
| Pulos até 5 s | 77% | 69% | 87% |
| Pulos em rajada de 3 ou mais seguidos, até 5 s cada | 474 (64%) | 81 (57%) | 364 (83%) |
| Pulos em rajada de 10 ou mais | 205 (28%) | 10 (7%) | 286 (65%) |
| Pulo com todos os eventos | 92% | 76% | 56% |
| Pulo sem os pulos até 5 s | 72% | 50% | 14% |

Leitura: um pulo em 1 s não é um julgamento da faixa; é você procurando algo. Num trecho real da maior sessão (S24, noite de 28/08), 20 faixas foram puladas em 33 segundos. Essas rajadas inflam o pulo, mas não explicam tudo: sem elas o autoplay de hoje ainda pula 72%. No período anterior à v0.2.75 a história era outra: quase todo pulo era rajada (sem elas, 14%).

Tirar os pulos de até 5 s não muda o retrato: curtida e "já ouvida até o fim" continuam no topo, a mesma playlist continua ajudando, e energia, valência e artista continuam sem efeito claro.

## As três que mais separam aceite de pulo (autoplay de hoje)

1. **Quantas vezes você já ouviu a faixa até o fim.** Quando o rádio põe uma faixa que você nunca ouviu até o fim, você pula 96%. Quando põe uma que você já ouviu inteira 10 vezes ou mais, pula 64%. E 72% das escolhas do motor são faixas que você ouviu inteiras no máximo 2 vezes.
2. **Faixa curtida.** Numa faixa que você curtiu, você pula 72%; numa não curtida, 94%. Sem as 5 maiores sessões a diferença fica maior (60% x 93%). Só 12% das escolhas do motor são faixas curtidas.
3. **Mesma playlist da faixa anterior.** Quando a faixa vem da mesma playlist da última que você ouviu até o fim, você pula 88%; quando vem de outra, 96%. Efeito menor que os dois primeiros, e no limite do acaso sem as 5 maiores sessões.

Fora do motor, o horário também separa: das 18h à meia-noite você pula 93%, no resto do dia 82%. Isso é contexto de uso (85% do autoplay acontece nesse horário), não uma característica da faixa.

O que NÃO separa: faixa nunca tocada (o motor quase não serve faixa inédita: 37 em 806), energia e valência parecidas com a anterior, mesmo artista, duração da faixa, posição e duração da sessão, aparelho. Repetição também não é o problema hoje: faixa já servida nos últimos 7 ou 30 dias é aceita um pouco MAIS, não menos (antes da v0.2.75 era o contrário).

## O que isso sugere para o motor (hipóteses, nada implementado)

- Hipótese A: o motor escolhe por "parecido com a anterior" e com o seu gosto em vetor, mas o que você aceita é "conhecida e querida". Dar peso direto a quantas vezes você já ouviu a faixa até o fim e ao like, no re-rank, pode baixar o pulo. Pelo que se lê em `library-indexer/src/rerank.rs`, o re-rank combina a posição no vetor de som com a vibe; o like entra só como semente do gosto e o número de escutas não entra (conferir no código antes de decidir).
- Hipótese B: misturar exploração e conforto. Uma regra simples para testar: a cada N faixas, uma "descoberta" (pouco ouvida); as outras, do grupo que você já ouviu até o fim várias vezes ou curtiu. A régua mediria se o pulo cai.
- Hipótese C: preferir a mesma playlist da última faixa aceita. Efeito pequeno, mas no mesmo sentido em todos os recortes.
- Hipótese D (medição, não motor): a régua deveria mostrar também o pulo sem as rajadas de até 5 s. Hoje um minuto de "próxima, próxima" pesa tanto quanto uma hora de escuta.
- Cuidado: tocar só o conhecido pode esgotar o conhecido (enjoar). Por isso B é mais seguro que A puro. Decisão do CEO.

## Limitações

- Poucas sessões: 21 no autoplay e 8 na station desde a v0.2.75. Os intervalos são largos.
- O teste só vê o que o motor escolheu. Não dá para saber como você reagiria ao que ele não escolheu.
- "Curtida antes" usa a data do like atual (`liked_at`). Like desfeito depois some do banco, e um like dado, desfeito e refeito conta pela data mais nova.
- "Já ouvida" conta só o que está em `play_events` (desde 03/05/2026, desktop e S24). Faixas ouvidas antes disso, ou ouvidas com um id antigo que não foi reapontado (mudanças de nome anteriores ao "Mover para playlist"), parecem menos conhecidas do que são.
- Energia e valência são anotações feitas por lote (inclusive em 12/10), aplicadas a eventos antigos. Faixa sem anotação fica fora dessa hipótese.
- Semente inferida (sem campo próprio no evento): 160 eventos sem semente ficam fora das hipóteses 1 a 3.
- Hora e dia na hora de São Paulo.
- Conhecida e curtida andam juntas (você curte o que ouve muito). As duas medidas não são independentes.
- O S24 tem motor próprio (no aparelho), diferente do desktop. Os eventos dele entram junto pela regra de versão; separados, as taxas do autoplay são iguais (8,3% x 8,9% de aceite).

## Anomalias nos dados

- 42 pulos do autoplay (e 7 da station) aconteceram depois de 50% da faixa, 11 depois de 90%. A régua conta como pulo. Pode ser "próxima" perto do fim.
- No autoplay desde a v0.2.75, 80 pulos no S24 com posição 0 ms (a faixa nem começou), espalhados em 62 faixas; a mais frequente ("Tribe") 5 vezes. No desktop isso ocorreu 1 vez. Pode ser só navegação rápida, ou faixa que não toca no celular. Vale conferir essas 62 no aparelho.
- Nenhum evento posterior a 12/10 (06:24 UTC): o histórico ainda não tem uso depois da reorganização das playlists.
- Antes da v0.2.75, no autoplay, o S24 (versão 0.2.74) aceitou 96% (138 eventos) e o desktop 32%: as poucas sessões daquele período são muito diferentes entre si, por isso esse recorte só serve como contraste.

## Rodar de novo

```bash
ssh -f -N -o ExitOnForwardFailure=yes -L 16333:localhost:6333 cmr-auto@100.102.249.9   # se o túnel não estiver de pé
uv run --with numpy python3 scripts/metrics/autoplay_forense.py --report /tmp/forense.json
uv run --with numpy python3 scripts/metrics/test_autoplay_forense.py
```
