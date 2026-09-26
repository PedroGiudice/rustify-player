/* ============================================================
   gl/scene.ts — CONTRATO de uma cena do fundo WebGL2.

   Toda cena mora num arquivo próprio (src/gl/scenes/<chave>.ts),
   exporta um SceneDef e entra em DOIS registros:
     1. gl/meta.ts, SCENE_META: chave, rótulo e dica (o store e os
        painéis leem daqui, sem importar código de GL);
     2. gl/registry.ts, SCENES: chave -> SceneDef (o motor lê daqui).
   O tipo de SCENES é Record<SceneKey, SceneDef>: esquecer um dos
   dois registros não compila.

   Ciclo de vida (quem chama é o motor, gl/engine.ts):
     create(ctx)  uma vez por troca de cena. Compile os programas
                  PRIMEIRO (makeProgram lança com a mensagem do
                  driver) e só depois aloque buffers e texturas: se
                  o shader falhar, nada fica vazando.
     resize(w,h)  logo depois do create e a cada resize do canvas.
                  w,h são o tamanho da SAÍDA da cena, que é o buffer
                  reduzido quando o SceneDef pede maxRows.
     onPalette?   quando a paleta muda (ver abaixo).
     frame(...)   uma vez por quadro de rAF.
     dispose()    na troca de cena e no desmonte. Apague TUDO que
                  criou (programas, buffers, VAOs, texturas,
                  framebuffers, transform feedbacks). O contexto é
                  um só e sobrevive às trocas: vazamento aqui se
                  acumula a cada troca.

   Estado GL garantido na entrada de frame():
     - framebuffer de saída ligado (a tela ou o buffer reduzido)
       e viewport do tamanho dele (= w,h do frame);
     - BLEND, DEPTH_TEST, CULL_FACE, SCISSOR_TEST e
       RASTERIZER_DISCARD desligados; nenhum VAO ligado;
       TEXTURE0 ativa. Programa em uso: indefinido.
   O contexto NÃO tem depth nem stencil buffer (as cenas são
   aditivas/translúcidas, sem oclusão) e NÃO tem antialias.

   Regras que a cena cumpre:
     - Quem usa buffers intermediários (ping-pong, gravura, etc.)
       devolve a saída com ctx.bindOutput() antes do desenho final.
       NUNCA bindFramebuffer(null): com resolução reduzida a saída
       não é a tela.
     - O fundo é preto fixo (pal.canvas = GL_CANVAS). Cena que não
       pinta todos os pixels limpa a saída (clearTo em glkit.ts).
     - O sinal muda VELOCIDADE; a posição é integrada na CPU e entra
       como uniform (gl/motion.ts). Nunca `uTime*(a+b*sinal)`: com o
       sinal oscilando, a velocidade aparente cresce com o tempo de
       sessão (CMR-267). sig.clock já é o relógio virtual (bgSpeed e
       beat-sync), pode multiplicar por constante.
     - Nada de alocação por quadro no caminho quente (Float32Array
       nova, objetos): reutilize.
     - DPR é sempre 1; o canvas é do motor, a cena não mexe nele.

   Paleta: RGB em float 0..1 (Float32Array de 3), já pronta para
   gl.uniform3fv. Os arrays são do motor e mudam NO LUGAR a cada
   quadro (o morph de cor da capa é um lerp local de ~1 s): leia em
   frame(), não guarde cópia achando que é constante. onPalette é
   chamado quando algum canal muda pelo menos meio degrau de 8 bits
   desde a última chamada — durante um morph isso é quase todo
   quadro, então nada caro ali (debounce por conta da cena).

   Resolução reduzida (SceneDef.maxRows): o motor desenha a cena num
   buffer RGBA8 de no máximo maxRows linhas (mesma proporção da tela)
   e compõe na tela com filtro linear + dither IGN. É a alavanca
   quando a cena não sustenta 60 fps: custo de fragment cai com o
   quadrado da escala. Serve bem a desenho de baixa frequência
   (névoa, fbm); linha fina e ponto pequeno ficam borrados.
   ============================================================ */

import type { GlSignal } from "./signal";
import type { SceneKey } from "./meta";

/** RGB 0..1. Sempre length 3. */
export type Vec3 = Float32Array;

export interface ScenePalette {
  /** Fundo: preto fixo (decisão do CEO de 20/09). */
  readonly canvas: Vec3;
  /** --bg-ink-rgb no desktop (tema > capa > knob). */
  readonly ink: Vec3;
  /** Accent (--primary / --accent). */
  readonly ink2: Vec3;
  /** Tom neutro dos realces de agudo (--fg-5 / --accent-dim). */
  readonly soft: Vec3;
}

export interface GlCaps {
  /** EXT_color_buffer_float: render target RGBA16F disponível. */
  readonly colorBufferFloat: boolean;
  /** Maior gl_PointSize que o driver aceita. */
  readonly maxPointSize: number;
}

export interface SceneCtx {
  readonly gl: WebGL2RenderingContext;
  readonly caps: GlCaps;
  /** Religa o framebuffer de saída (tela ou buffer reduzido) e ajusta
      o viewport ao tamanho dele. */
  bindOutput(): void;
  /** Desenha o triângulo de tela cheia (VS_TRI) com o VAO vazio do
      motor. O programa e as texturas são da cena. */
  fullscreen(): void;
}

export interface GlScene {
  resize(w: number, h: number): void;
  frame(sig: GlSignal, pal: ScenePalette, dt: number, w: number, h: number): void;
  onPalette?(pal: ScenePalette): void;
  dispose(): void;
}

export interface SceneDef {
  readonly key: SceneKey;
  /** Teto de linhas do buffer interno. Ausente = resolução cheia. */
  readonly maxRows?: number;
  create(ctx: SceneCtx): GlScene;
}
