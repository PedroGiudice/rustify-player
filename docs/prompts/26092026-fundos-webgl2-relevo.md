# Retomada: melhorar o Relevo (fundo WebGL) sobre o motor WebGL2 novo

## Contexto rápido

Rustify Player (Tauri 2 + SolidJS). O fundo animado do Now Playing tem dois motores: o 2D e o WebGL. Na sessão de 25-26/09 aconteceram quatro coisas:

- Nasceu o Fundo Lab v2, com cinco cenas novas. O CEO achou a Cimática "excelente".
- A Fase 0 da auditoria de UI foi publicada na **v0.2.81**.
- O ambiente de build da VM foi reconstruído.
- O motor WebGL foi migrado de three.js para **WebGL2 direto** na branch `feat/gl-webgl2-engine` (completa, não mesclada). O **Relevo** foi portado idêntico pixel a pixel.

O CEO disse: **"Relevo é o melhor. Vamos continuar, melhorando Relevo."**

Critério de aceite do CEO: 60 fps **medidos no app** (média de pelo menos 58 e no máximo 2% dos quadros acima de 20 ms). A tela real é 1920×1080 com zoom 1,15, então o canvas tem **1857×1048**, e não 1366×768. O Relevo custa cerca de 1,75 ms de GPU isolado, mas no app engasga em **23% dos quadros**. A causa do engasgo ainda não é conhecida e não é o render da cena.

<session_metadata>
branch_base: main @ 7ccced6 (v0.2.81) + commit do pickup
branch_motor: feat/gl-webgl2-engine @ a5743ec (enviada ao GitHub)
branches_wip: feat/gl-scene-bokeh 743b639, feat/gl-scene-chladni 1f9fd61, feat/gl-scene-motes 24a6814 (sem verificação)
testes: main 766 vitest / branch do motor 834 vitest
ponte_mcp: 9223, ou 9224 se o app reiniciou com o processo antigo vivo
</session_metadata>

## Arquivos principais

- `docs/contexto/26092026-fundos-webgl2-relevo.md`: contexto detalhado, métricas e decisões. **Ler primeiro.**
- `src/gl/scene.ts` (na branch do motor): contrato de cena. O comentário do topo é a especificação.
- `src/gl/scenes/relief.ts` (na branch do motor): o Relevo em WebGL2. `main:src/gl/scenes.ts` tem a versão three.
- `src/gl/engine.ts`, `src/gl/host.ts`, `src/gl/glkit.ts`, `src/gl/registry.ts`, `src/gl/meta.ts` (na branch do motor).
- `src/gl/bench.ts` + `src/gl/benchStats.ts` (na branch do motor): o "Medir cenas" do Tweaks, com o evento `rustify:gl-bench` e o resultado em `window.__rustifyGlBench`.
- `scripts/gl-bench/README.md` (na branch do motor): bench offscreen no WebKitGTK real da cmr-auto.
- `docs/design-refs/fundo-lab-v2/`: lab v2, `wk_bench.py`/`wk_shot.py` e o bench das variantes da Nébula.
- CLAUDE.md, seções "Motor WebGL do bg" e "Ambiente de build da VM".

## Próximos passos (por prioridade)

### 1. Alinhar com o CEO o que é "melhorar o Relevo"
**Onde:** conversa, com o skill `superpowers:brainstorming` (caminho bounded).
**O que:** apresentar dois eixos com evidência e ouvir o que ele quer. (a) **Fluidez:** engasgo de 23% no app. (b) **Visual:** linhas de 1px sem antialias que cintilam, as diagonais do wireframe herdadas do three, névoa, cor, reação ao som. Para o visual, propor variantes num lab do Relevo, com recortes 1:1 a 1857×1048 medidos no WebKitGTK da cmr-auto. Ele gosta de decidir vendo.
**Por que:** "melhorar" é ambíguo, e o CEO gosta do Relevo como está. Não mudar a identidade sem ele ver.
**Verificar:** decisão explícita do CEO antes de codar.

### 2. Diagnosticar o engasgo do Relevo no app (independe do passo 1)
**Onde:** app aberto na cmr-auto, via ponte MCP (`webview_execute_js`); na cmr-auto, `sensors` e `/sys/class/drm/card*/gt_cur_freq_mhz`.
**O que:** amostrar 8 s de intervalos de rAF (disparar em segundo plano e ler `window.__fpsProbe` depois; a ponte estoura o tempo com script async longo). Fazer A/B de: motor 2D, WebGL com Relevo, WebGL com Órbitas (0,25 ms) e o fundo desligado, se houver. Registrar a temperatura e a frequência da CPU e da GPU a cada rodada. Se o engasgo persistir com a cena barata, a causa é o pipeline: composição a 1857×1048, processo de GPU do WebKit (testar `UseGPUProcessForWebGL` desligado com `webkit_settings_set_feature_enabled` no `with_webview` do Tauri), main thread (IPC de FFT a 62 Hz) ou térmica.
**Por que:** o Relevo custa 1,75 ms e o engasgo é de 23%. Otimizar a cena sem achar a causa não resolve.
**Verificar:** a mesma amostragem antes e depois, com carga e temperatura anotadas.

### 3. Mesclar o motor WebGL2 depois do bench no app
**Onde:** `feat/gl-webgl2-engine`.
**O que:** rebase em `main`, gates, bump, `./scripts/release.sh` (e `release_android.sh`), o CEO faz o `dpkg -i` e **reinicia o app**. Depois, "Medir cenas" pelo Tweaks ou `window.dispatchEvent(new CustomEvent("rustify:gl-bench"))` pela ponte, e ler `window.__rustifyGlBench`. Merge em `main` se as quatro cenas passarem ou empatarem com o three. Em seguida, atualizar o CLAUDE.md "Motor WebGL do bg" (hoje ainda cita three e `gl/scenes.ts`).
**Por que:** as melhorias do Relevo e as cenas novas partem desse motor.
**Verificar:** `npm run -s typecheck && npx vitest run` (834 na branch) e a tabela do "Medir cenas" com veredito por cena.

### 4. Cenas novas (depois do Relevo, salvo pedido contrário)
**O que:** Cimática primeiro (aprovada), a partir de `feat/gl-scene-chladni`, com a física por transform feedback e fidelidade total ao lab. Depois o Palco (`feat/gl-scene-bokeh`, quase pronto). Marmorizado, Sulco (persistir o histórico em `kv-groove-history`) e Poeira na luz vêm por último. Contrato em `src/gl/scene.ts`.
**Verificar:** `npx vitest run src/gl` (o teste de vazamento percorre todas as cenas), o bench offscreen e o "Medir cenas" no app.

### 5. Nébula
**O que:** a variante com ruído de textura em resolução cheia e 3/5 oitavas custa ~7 ms a 1857×1048. Falta a comparação visual com a original: rodar `docs/design-refs/fundo-lab-v2/nebula-bench.html` sem hash, via `wk_shot.py` com janela de 1900×1100, e recortar 1:1. A de 256 linhas foi reprovada.

### 6. Pendências do CEO (não bloqueiam o Relevo)
Revisar a v0.2.81 (guia em `docs/ui-revamp/2026-09-25-fase0-entrega.md`). Três decisões de gosto do revamp: Fraunces, clique simples em linha e card de letras encaixado.

## Restrições

- Critério de aceite dos fundos = fps no app, não no lab nem no bench offscreen. Medir na resolução real (1857×1048).
- Não aposentar cena sem decisão do CEO. O canvas GL é preto fixo (GL_CANVAS).
- Nunca multiplicar o relógio por um sinal que oscila; integrar a velocidade na CPU (`src/gl/motion.ts`).
- `pkill -f` via ssh ou no mesmo comando que contém o padrão mata a própria shell: chamadas separadas e o truque do colchete.
- Release: bump manual antes do `release.sh`; o CEO faz o `dpkg -i` e **precisa reiniciar o app** (na sessão anterior, o 0.2.81 ficou instalado sem carregar).

## Como verificar

```bash
cd /home/opc/rustify-player && git fetch -q origin && git status -sb | head -1
git branch --list 'feat/gl*' -v
git switch feat/gl-webgl2-engine && npm run -s typecheck && npx vitest run 2>&1 | tail -2   # 834
git switch main
# ponte MCP do app (porta 9223 ou 9224):
ssh cmr-auto@100.102.249.9 'ss -tlnp | grep -E ":922[0-9]"; pgrep -a rustify-player; uptime'
ssh -f -N -o ExitOnForwardFailure=yes -L 9224:localhost:9224 cmr-auto@100.102.249.9   # ajuste a porta
```
