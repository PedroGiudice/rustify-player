# gl-bench — custo por cena do motor WebGL2, no WebKitGTK real

Mede cada cena registrada em `src/gl/registry.ts` sozinha, num canvas
fora do DOM (1366x768 por padrão; `w=`/`h=` mudam), com o motor do app (`src/gl/engine.ts`): 20
quadros de aquecimento e 5 lotes de 24 quadros, com `readPixels` de 1
pixel no fim de cada lote para esperar a GPU. O número soma CPU e GPU.
É o método do lab v2 (`docs/design-refs/fundo-lab-v2`), agora sobre o
código do app. Também acusa shader que não compila (por cena) e
`gl.getError()`, e mostra a fração de pixels acesos (0% = a cena não
desenhou nada).

Não substitui o **Medir cenas** do Tweaks: aquele mede fps no app
aberto, com o resto da tela junto, e é o critério de aceite (60 fps).
Este isola a GPU e serve para comparar cenas e alavancas (`maxRows`).

## Rodar na cmr-auto

Na VM, gere o build e copie (o diretório em `/tmp` da cmr-auto é
descartável; apague no fim):

```bash
npx vite build --config scripts/gl-bench/vite.config.ts --outDir /tmp/gl-bench-build
ssh cmr-auto@100.102.249.9 'mkdir -p /tmp/gl-bench'
scp -r /tmp/gl-bench-build scripts/gl-bench/run_bench.py cmr-auto@100.102.249.9:/tmp/gl-bench/
```

Na cmr-auto (via `ssh`), com a sessão gráfica do usuário. O backend
Wayland do GTK aborta sem contexto GL, por isso `GDK_BACKEND=x11` no
Xwayland; a janela é offscreen, nada aparece na tela:

```bash
cd /tmp/gl-bench
export XDG_RUNTIME_DIR=/run/user/1000 \
  DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
  DISPLAY=:0 XAUTHORITY=$(ls /run/user/1000/.mutter-Xwaylandauth.* | head -1) \
  GDK_BACKEND=x11
python3 run_bench.py gl-bench-build                 # todas as cenas
python3 run_bench.py gl-bench-build --query full    # + cada cena reduzida em resolução cheia
python3 run_bench.py gl-bench-build --query 'scenes=nebula&shots' --shots-dir ./shots
# resolução real do CEO (monitor 1920x1080 com zoom 1,15 no Tweaks):
python3 run_bench.py gl-bench-build --query 'w=1857&h=1048'
# Relevo: todas as 15 variantes numa rodada, com um PNG de cada
python3 run_bench.py gl-bench-build --query 'w=1857&h=1048&scenes=relief&relief=all&shots' --shots-dir ./shots
# Relevo: uma variante só (linhas,forma,superfície)
python3 run_bench.py gl-bench-build --query 'scenes=relief&relief=ridges,smooth,solid'
# Relevo no sinal REAL gravado no app, nos 2 piores instantes da reação antiga
python3 run_bench.py gl-bench-build --query 'w=1857&h=1048&scenes=relief&replay=fft-real-2609&shots' --shots-dir ./shots-replay
rm -rf /tmp/gl-bench                                # no fim
```

`--json` imprime só o JSON; `--nogpuproc` desliga o processo de GPU do
WebGL (`UseGPUProcessForWebGL`) para comparar.

Parâmetros da página (`--query`):

| Parâmetro | Efeito |
|---|---|
| `scenes=a,b` | só essas cenas |
| `w=1857&h=1048` | tamanho do canvas (padrão 1366x768, limite 64..4096) |
| `full` | mede também cada cena reduzida em resolução cheia |
| `relief=L,F,S` | força o estilo do Relevo: linhas (`original`, `mesh`, `ridges`, `contours`, `weave`), forma (`detailed`, `smooth`), superfície (`open`, `solid`); campo inválido cai no padrão, como no app |
| `relief=all` | o Relevo em todas as variantes: original, mesh x 2 formas, ridges/contours/weave x 2 formas x 2 superfícies (15) |
| `shots` | um PNG por cena/variante: `<cena>.png`, `relief-<linhas>-<forma>-<superfície>.png` |
| `replay=fft-real-2609` | troca o `sim.ts` pelo sinal real gravado no app (`src/gl/__fixtures__/fft-real-2609.json`, decodificado por `src/gl/fftReplay.ts`), um evento por quadro com o dt gravado. Com `shots`, fotografa os 2 piores instantes da reação ANTIGA do Relevo (ver abaixo) |
| `pal=RRGGBB,RRGGBB` | paleta (ink,ink2) no lugar do Copper: a cena com a cor de uma capa real (ex.: `pal=9af425,9af920`, a capa verde-limão de 11/10) |
| `xfade` | mede cada cena com a dissolução de troca de cena ativa no quadro inteiro (retrato da cena anterior por cima, `gl/engine.ts`): a diferença para a rodada sem `xfade` é o custo da transição, que no app só existe durante 1,4 s depois de trocar de cena (1,8 s ao ligar o motor) |
| `ambient=1` | mede cada cena no modo ambient (o fundo fora do Now Playing): a cena desenha num buffer de tela cheia e o motor reduz a 1/4, desfoca (gaussiana separável, 2 passagens) e compõe com saturação 0,9 e ganho 0,8 (`gl/ambient.ts`). A diferença para `ambient=0` (ou sem o parâmetro) é o custo do passe, que no app vale em toda vista que não é o Now Playing. Com `shots`, o PNG sai desfocado |
| `sync` | lê 1 pixel depois de cada quadro (não só no fim do lote). Obrigatório para comparar na VM: o llvmpipe descarta os quadros pendentes do lote quando o seguinte limpa a tela, e sem `sync` a cena direto na tela mede só uma fração do trabalho (Tinta: 4,3 ms sem `sync`, 21,1 ms com, em 28/10) |
| `cfg=ceo` / `cfg=default` | cfg do sinal no replay: `ceo` (padrão; Bass 0,30, Mid 0,15, Treble 0,10, smoothing 1,0, pulse, depth 1,0) ou os defaults do app. Sem replay, sempre os defaults |

O shot (e a fração de pixels acesos) sai de UM quadro num instante
fixo do sinal simulado, `SHOT_T` = 15,75 s em `bench.ts`: pico de
energia do ciclo de 32 s do `sim.ts`, logo depois de um bumbo — terreno
com relevo bem visível, e o mesmo instante para todas as variantes, que
ficam comparáveis lado a lado. O resultado chega ao runner por POST
`/result` (o título da página trunca em ~1000 caracteres e a rodada
`relief=all` passa disso).

## Modo ambient (B6, 28/10)

Até a 0.2.98 o ambient era `filter: blur(8px) saturate(0.9)` + `opacity:
0.8` no `.app-bg`, refeito em tela cheia a cada quadro do canvas: no app
real (26/10, 1866x1048, Tinta, sem áudio) a Home ficava em 46,9 fps com
69 % dos quadros acima de 20 ms, e o Now Playing (sem filter) em 60. O
passe que o substitui se mede assim, na mesma rodada:

```bash
python3 run_bench.py gl-bench-build --query 'w=1857&h=1048&scenes=paint,relief&sync'
python3 run_bench.py gl-bench-build --query 'w=1857&h=1048&scenes=paint,relief&ambient=1&sync'
```

Na VM (renderização por software, sem GPU) o número absoluto não vale;
só a diferença entre as duas rodadas, e só com `sync` (ver a tabela
acima: sem ele o llvmpipe rasteriza um quadro por lote quando a cena vai
direto para a tela, e o ambient parece 20 ms mais caro do que é). Medido
na VM em 28/10, 1857x1048, com `sync`:

| cena | focused | ambient | passe |
|---|---|---|---|
| Tinta | 21,1 ms | 25,1-25,2 ms | +4 ms |
| Relevo | 19,7-20,5 ms | 26,6-30,6 ms | +6 a +10 ms (3 de 4 rodadas em ~30 ms) |

O Relevo paga mais que a Tinta pelo mesmo passe porque, no llvmpipe,
cada troca de framebuffer é um ponto de sincronia entre a CPU e as
threads de rasterização, e o Relevo é a cena mais pesada de vértices.
Em GPU de verdade isso não tem o mesmo peso; o número que decide é o
do cmr-auto.

Paridade com o CSS antigo (mesma rodada, `shots`): o PNG do ambient
contra a foto do focused passada por gaussiana de 8 px, saturação 0,9
e ganho 0,8 (ffmpeg `gblur=sigma=8:steps=6` + `colorchannelmixer`)
dá PSNR de 54,5 dB no Relevo e 52,0 dB na Tinta; contra a mesma foto
sem o desfoque, 30,5 e 40,4 dB.

Na GPU da cmr-auto (UHD 620, WebKitGTK 2.52, 1857x1048, app aberto,
CPU a 97-99 °C, 28/10), sem `sync` (com `sync` o readPixels por quadro
serializa CPU e GPU e soma ~10 ms ao focused). Antes: a cena em buffer
de tela cheia + redução em toda cena; depois: ambient PARADO com
`SceneDef.ambientDirect` desenha direto a 1/4 (Tinta) e cena com
`maxRows` desfoca a partir do próprio buffer (Nébula):

| cena | focused | ambient antes | ambient depois |
|---|---|---|---|
| Tinta | 10,3-10,8 ms | 18,4-19,1 ms | 5,4-5,8 ms |
| Nébula | 9,7-10,7 ms | 12,0-12,9 ms | 9,2-9,8 ms |
| Lorem | 8,0-8,3 ms | 16,8-17,1 ms | 16,4-16,8 ms |
| Riso | 3,8-4,0 ms | 12,1-12,6 ms | 11,6-12,0 ms |
| Mandala | 3,5-3,7 ms | 10,9-11,8 ms | 11,2-11,7 ms |
| Relevo | 2,3-2,8 ms | 6,6-6,8 ms | 6,6-6,9 ms |
| Poeira / Órbitas | 2,2 / 0,5-0,7 ms | 6,2-6,4 / 4,4 ms | 6,5-6,8 / 4,4-4,5 ms |

Na GPU real, o passe no caminho cheio custa ~4 ms numa cena que quase
não pinta (Órbitas) e ~8 ms numa que pinta a tela inteira (Tinta,
Lorem, Riso, Mandala). O mesmo buffer sem nada lendo dele custa o
mesmo que a tela; o custo aparece quando um passe seguinte o amostra.
Paridade do caminho novo com o antigo (fotos `ambient=1&shots`, mesma
rodada): Tinta 49,7 dB, Nébula 52,9 dB. Lorem a 1/4 daria 5,4 ms, mas
os glifos engrossam (média de brilho +50 %, 33,6 dB): fica no caminho
cheio até o CEO julgar.

Do passe, a redução e o desfoque a 1/4 custam ~2,2 ms no llvmpipe (a
1/3, ~3-4 ms, sem ganho visível: a gaussiana de 8 px já zera o que passa
do Nyquist de 1/4); o resto é a composição de tela cheia e as trocas de
framebuffer. O aceite continua sendo o fps medido no app real em todas
as vistas.

## Replay do sinal real (calibração do Relevo, 26/09)

Com `replay=fft-real-2609&shots`, o bench roda a cadeia do app
(`stepGlSignal`) sobre a gravação inteira e escolhe os 2 instantes de
maior F da reação antiga, F = (5,5 + 5·uLow + 3·uBeat) / 5,5, a pelo
menos 5 s um do outro (`worstInstants` em `fftReplay.ts`, com teste).
Em cada instante sai um PNG por variante, `replay<n>-relief-<variante>.png`.
Sem `relief=`, as variantes são `original` (reação antiga, a referência
intacta), `ridges,smooth,solid` e `mesh,detailed,open` (reação nova,
`gl/reliefReaction.ts`). O log e o JSON (`replay.instants`) trazem faixa,
tempo, F antigo e F novo de cada instante. Medido em 26/09 a 1857x1048:

| cfg | instante | F antigo | F novo |
|---|---|---|---|
| ceo | Crazy People (Captain Hook Remix) @ 78,6 s | 1,74 | 1,30 |
| ceo | Antidote @ 655,6 s | 1,74 | 1,15 |
| default | Crazy People (Captain Hook Remix) @ 77,8 s | 2,25 | 1,38 |
| default | Skin do Kof (Remix) @ 515,0 s | 2,25 | 1,28 |

As metas da calibração ficam travadas por faixa em
`src/gl/reliefReaction.test.ts` (o mesmo replay, no vitest).

## Ler o resultado

- Meça com a máquina ociosa e anote a carga (`cat /proc/loadavg`) e a
  temperatura (`/sys/class/thermal/thermal_zone*/temp`). Com o app
  aberto e a CPU perto de 100 °C os tempos chegam a multiplicar por 6;
  a ordem entre as cenas se mantém, mas o absoluto não vale.
- Para julgar uma mudança, compare A/B na MESMA rodada, nunca com um
  número de outro dia.
- O quadro de 60 fps tem 16,7 ms e o fundo precisa deixar folga para o
  resto do app.
