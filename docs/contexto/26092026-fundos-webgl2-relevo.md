# Contexto: fundos WebGL (lab v2, motor WebGL2, Relevo) + auditoria de UI e Fase 0

**Data:** 2026-09-25 a 2026-09-26
**Sessão:** `main` (v0.2.81) + branch `feat/gl-webgl2-engine` (não mesclada)
**Duração:** ~2 dias de relógio, várias rodadas de workflow

---

## O que foi feito

### 1. Reavaliação dos fundos e defeito da Poeira (CMR-267)
- A Poeira acelerava com o tempo de sessão: o shader fazia `p.z = mod(p.z + uTime*(3+4*uMid) ...)`. A velocidade aparente é `speed + t·d(speed)/dt`: 4 u/s projetados contra 279 u/s aos 5 min. Corrigido em `src/gl/motion.ts` (`advanceDustTravel`, integração na CPU). A regra dura está no CLAUDE.md.
- Crítica estética: três das quatro cenas eram "câmera avançando", e movimento em direção à tela captura a atenção de forma involuntária (Franconeri & Simons 2003). Foram propostas cinco cenas novas: Cimática, Marmorizado, Palco, Sulco e Poeira na luz.

### 2. Fundo Lab v2 (artifact)
- https://claude.ai/artifact/8eTjn2j7rCLHhaDEfffZ5X. É WebGL2 puro, sem three, com seis cenas (as cinco novas mais a Nébula refinada), canvas preto (GL_CANVAS, decisão de 20/09) e bench interno. Fonte versionada: `docs/design-refs/fundo-lab-v2/fundo-lab-v2.html`.
- A medição foi feita no WebKitGTK real da cmr-auto, sem abrir janela: `wk_bench.py` / `wk_shot.py` (Python gi + `Gtk.OffscreenWindow`, `GDK_BACKEND=x11 DISPLAY=:0 XAUTHORITY=/run/user/1000/.mutter-Xwaylandauth.*`; o backend Wayland aborta sem GL).
- Otimizações que saíram do bench:
  - **Cimática:** a física foi para a GPU por transform feedback (8,3 ms → 1,3 ms).
  - **Marmorizado:** a gravura passou para resolução cheia, reamostrada com Catmull-Rom limitado aos vizinhos, e só a cada gota ou a cada 1,5 s.
  - **Sulco:** o comprimento de onda da ondulação ficou fixo em pixels.

### 3. Pesquisa de motor (dois agentes)
- WebGPU está fora hoje: o WebKitGTK do Ubuntu é compilado sem ele, e o Xclipse do S24 depende do Chrome 154.
- Sair do three.js: sim. WebGL2 direto é suficiente (twgl.js seria a alternativa).
- O WebKitGTK 2.52 roda o WebGL num processo de GPU próprio (PR #73154, cerca de 18% mais lento em animação contínua). Na medição offscreen, ligar ou desligar não fez diferença.
- O renderer vem mascarado como "Apple GPU" e não há timer de GPU. O fps é o único sinal confiável.

### 4. Auditoria de UI e Fase 0 (v0.2.81, publicada)
- Workflow de 20 agentes: 248 achados, 3 direções, e o juiz recomendou a **Afinação**. Artifact: https://claude.ai/artifact/7zD6wu1pfHU57n5eZFBuzQ. Dados em `docs/ui-revamp/`.
- Fase 0: 7 frentes em worktrees, revisão adversarial e crítico em loop. 107 correções mais os fechamentos, mais o CMR-268 (o EQ voltava o tipo do filtro para Bell). Merge `9efe98f`, bump `390b889`, desktop e APK 0.2.81 publicados. Guia de revisão: `docs/ui-revamp/2026-09-25-fase0-entrega.md`. CMR-267/268/269 estão "In Review" no Linear.

### 5. Ambiente de build da VM reconstruído (lacuna da migração CMR-256)
- Instalado: `libgstreamer-plugins-bad1.0-dev`, `cargo tauri` 2.11.5, JDK 17, Android SDK 36 + NDK 27.0.12077973, o target `aarch64-linux-android` e a keystore restaurada do backup da cmr-auto. O certificado bate com a 0.2.80.
- Documentado no CLAUDE.md, seção "Ambiente de build da VM".

### 6. Motor WebGL2 no app (pedido do CEO: "todas" as cenas) — INTERROMPIDO no pickup
- Frente do motor completa, na branch `feat/gl-webgl2-engine` @ `a5743ec` (enviada ao GitHub):
  - `src/gl/engine.ts`: um contexto só, liberação completa na troca de cena, resolução reduzida genérica por cena.
  - `src/gl/glkit.ts`: ajudante mínimo, com suporte a transform feedback.
  - `src/gl/scene.ts`: o contrato de cena.
  - `src/gl/registry.ts`, `src/gl/host.ts` e `src/gl/scenes/{dust,relief,orbits,nebula}.ts`.
  - three removido (o motor ficou num chunk de ~22 KB, contra 543 KB antes).
  - "Medir cenas" no Tweaks (`src/gl/bench.ts`, `src/gl/benchStats.ts`; evento `rustify:gl-bench`; resultado em `window.__rustifyGlBench` e `kv-gl-bench`).
  - Bench offscreen em `scripts/gl-bench/`.
- **Paridade:** Relevo e Nébula saíram idênticas pixel a pixel ao three.js. Poeira e Órbitas diferem em 0,06% e 0,03% dos pixels, pontos isolados.
- 834 testes passando na branch.
- As cinco cenas novas ficaram parciais em branches WIP, sem verificação (tabela abaixo).

### 7. Medições no app real (ponte MCP) e reprovações do CEO
- A tela real é 1920×1080 (monitor externo) com zoom 1,15, e o canvas do fundo tem **1857×1048**. Isso invalida a suposição de 1366×768.
- A Nébula de 256 linhas foi reprovada pelo CEO ("péssimo, resolução baixa"). Ela estica 4 vezes na tela real.
- O CEO achou a **Cimática excelente** e o **Relevo o melhor**. A próxima sessão é para melhorar o Relevo.

## Estado dos arquivos e branches

| Item | Estado | Detalhe |
|---|---|---|
| `main` @ `7ccced6` + commit do pickup | Publicado (0.2.81) | Fase 0, docs, lab, medições, CLAUDE.md atualizado |
| `feat/gl-webgl2-engine` @ `a5743ec` | Completa, não mesclada, enviada | Motor WebGL2, 4 cenas portadas, bench no app e offscreen, 834 testes |
| `feat/gl-scene-bokeh` @ `743b639` | WIP, sem verificação | Palco quase completo (cena, teste, registro) |
| `feat/gl-scene-chladni` @ `1f9fd61` | WIP, sem verificação | Só `chladni.test.ts` |
| `feat/gl-scene-motes` @ `24a6814` | WIP, sem verificação | Só `motes.test.ts` |
| Marmorizado e Sulco | Não iniciados | Branches apagadas (estavam idênticas ao motor) |
| `docs/design-refs/fundo-lab-v2/` | Criado | Lab v2, `wk_bench.py`, `wk_shot.py`, `nebula-bench.html` e as rodadas |
| `docs/ui-revamp/` | Criado | Auditoria (md + json) e guia da Fase 0 |
| Worktree `rustify-player-volnorm` e branches `fix/themes-and-contrast`, `fix/tier0-zombie-controls` | Antigas, não são desta sessão | Não mexidas |

## Commits desta sessão (`main`, first-parent)

```
7ccced6 docs(ui): guia de revisao da Fase 0 entregue na v0.2.81 (CMR-269)
390b889 chore: bump 0.2.81
9efe98f merge: Fase 0 da auditoria de UI (CMR-269, CMR-267, CMR-268)   <- 107 commits
5a8544a docs: ambiente de build da VM reconstruido apos a migracao (CMR-256)
5118de0 docs(bg): lab v2 sobre canvas preto (GL_CANVAS, decisao de 20/09)
357511d docs: auditoria de UI, lab de fundos v2 e custo medido dos fundos WebGL
```
Branch `feat/gl-webgl2-engine`: `12bacf9` motor, `06c72b6` medir cenas no Tweaks, `a07cb9e` bench offscreen, `a5743ec` ajuste do resultado.

## Decisões tomadas

- **Motor WebGL2 direto, three removido.** A Cimática precisa de transform feedback, que o three não expõe, e o lab provou que um ajudante mínimo basta. Descartados: OGL (parado desde 01/2025), regl (API WebGL1) e WebGPU (ausente nos dois alvos). *Está na branch; o merge espera o bench no app.*
- **As 4 cenas atuais ficam.** Aposentar Relevo e Órbitas foi recomendação do CTO, mas a decisão é do CEO, e o CEO escolheu o Relevo como favorito.
- **Critério de aceite dos fundos (CEO, 26/09):** 60 fps medidos no app, com média de pelo menos 58 e no máximo 2% dos quadros acima de 20 ms. O lab não vale como aceite.
- **Nébula de 256 linhas reprovada.** Alternativa com ruído de textura ainda sem veredito visual.
- **Canvas GL preto (20/09) é base**, e o lab foi ajustado para ele.
- **Revamp de UI:** a recomendação é a Afinação com enxertos. Pendentes do CEO: Fraunces nos títulos ≥ 28 px, clique simples que seleciona, e card de letras encaixado.

## Métricas

**No app (ponte MCP, cena Relevo, Now Playing, 8 s de rAF):**

| Momento | fps médio | Quadros > 20 ms | p50 / p99 |
|---|---|---|---|
| Binário antigo (pid de 24/09) | 59,5 | 5,9% | 17 / 26 ms |
| 0.2.81 (pid de 25/09 23:58), canvas 1857×1048 | 57,6 | **23%** | 17 / 29 ms |

**Custo de render isolado (bench offscreen do motor novo, 1366×768, cmr-auto com app aberto e CPU a 97-98 °C):**

| Cena | ms por quadro |
|---|---|
| Órbitas | 0,25 |
| Poeira | 1,25 |
| **Relevo** | **1,75** |
| Nébula (256 linhas) / cheia | 5,92 / 25,29 |

→ **O Relevo custa ~1,75 ms de GPU, mas engasga em 23% dos quadros no app. A causa do engasgo NÃO é o render da cena.** Candidatas, não verificadas: throttling térmico (CPU a 97-98 °C), composição de 1857×1048, processo de GPU do WebKitGTK, main thread (IPC de FFT a 62 Hz, Solid), GC.

**Nébula a 1857×1048 (três rodadas, carga ~3,5):**

| Variante | ms |
|---|---|
| Original simplex 5/5, cheia | 46-48 |
| 256 linhas + bilinear (0.2.81, reprovada) | 6,4-7,6 |
| Simplex ½ + bicúbica 5/5 / 3/5 | 20 / 16 |
| Textura cheia 5/5 / **3/5** | 10 / **~7** |
| Textura 0,75 + bicúbica 3/5 | 10,4 (a bicúbica custa ~4 ms a 1080p) |

**Lab v2 (1366×768):** Marmorizado 0,58; Poeira na luz 0,83; Palco 1,0; Cimática 1,29; Sulco 2,04; Nébula ⅓ 3,63 ms (ociosa). Com a máquina em uso, cerca de 1,5 a 2 vezes esses valores, na mesma ordem.

## Pendências identificadas

1. **Melhorar o Relevo** (alta, pedido do CEO). Definir com ele o que é "melhorar": fluidez (o engasgo de 23%) e/ou visual (1px sem antialias, diagonais do wireframe). Base técnica: `src/gl/scenes/relief.ts` na branch do motor.
2. **Diagnosticar o engasgo no app** (alta). O custo da cena não o explica. Fazer A/B pela ponte: motor desligado, 2D, Relevo e Órbitas (a mais barata); temperatura e frequência da CPU; `UseGPUProcessForWebGL` desligado via `with_webview`.
3. **Mesclar o motor WebGL2** (alta). Release de teste e "Medir cenas" no app; merge se passar.
4. **Cenas novas** (média). A Cimática vem primeiro, porque o CEO aprovou. O Palco está quase pronto. Marmorizado, Sulco e Poeira na luz vêm depois.
5. **Nébula** (média). Comparação visual da variante com ruído de textura; as imagens de comparação não foram vistas.
6. **Revisão da v0.2.81 e decisões de gosto do revamp** (média, com o CEO).
7. **Mobile: "Medir cenas" no S24** (baixa). O `GlBg` precisa ler o override de cena.
8. **CLAUDE.md "Motor WebGL do bg"** (baixa, ao mesclar a branch). Hoje ainda cita three e `gl/scenes.ts`.
9. **`.so` do APK passou de 29,9 para 34,5 MB** (baixa), provavelmente por causa do rustc novo. Não investigado.
10. **Ponte MCP:** quando o app reinicia com o processo antigo vivo, ela sobe na **9224** em vez da 9223. Conferir com `ss -tlnp | grep 922` na cmr-auto.

**Linear:** CMR-274 (engasgo do Relevo), CMR-275 (motor WebGL2 + cenas do lab); CMR-267/268/269 em In Review (Fase 0).
