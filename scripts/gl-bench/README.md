# gl-bench — custo por cena do motor WebGL2, no WebKitGTK real

Mede cada cena registrada em `src/gl/registry.ts` sozinha, num canvas
1366x768 fora do DOM, com o motor do app (`src/gl/engine.ts`): 20
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
rm -rf /tmp/gl-bench                                # no fim
```

`--json` imprime só o JSON; `--nogpuproc` desliga o processo de GPU do
WebGL (`UseGPUProcessForWebGL`) para comparar.

## Ler o resultado

- Meça com a máquina ociosa e anote a carga (`cat /proc/loadavg`) e a
  temperatura (`/sys/class/thermal/thermal_zone*/temp`). Com o app
  aberto e a CPU perto de 100 °C os tempos chegam a multiplicar por 6;
  a ordem entre as cenas se mantém, mas o absoluto não vale.
- Para julgar uma mudança, compare A/B na MESMA rodada, nunca com um
  número de outro dia.
- O quadro de 60 fps tem 16,7 ms e o fundo precisa deixar folga para o
  resto do app.
