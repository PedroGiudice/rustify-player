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
| `cfg=ceo` / `cfg=default` | cfg do sinal no replay: `ceo` (padrão; Bass 0,30, Mid 0,15, Treble 0,10, smoothing 1,0, pulse, depth 1,0) ou os defaults do app. Sem replay, sempre os defaults |

O shot (e a fração de pixels acesos) sai de UM quadro num instante
fixo do sinal simulado, `SHOT_T` = 15,75 s em `bench.ts`: pico de
energia do ciclo de 32 s do `sim.ts`, logo depois de um bumbo — terreno
com relevo bem visível, e o mesmo instante para todas as variantes, que
ficam comparáveis lado a lado. O resultado chega ao runner por POST
`/result` (o título da página trunca em ~1000 caracteres e a rodada
`relief=all` passa disso).

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
