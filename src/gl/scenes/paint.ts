/* ============================================================
   scenes/paint.ts — Tinta: camadas de tinta grossa se misturando.

   Nasceu no Fizzle (11/10): esboço "Papel" (camadas recortadas com
   sombra) que o CEO pediu como "tinta bem grossa se misturando", e
   depois com menos relevo e menos reflexo. Os números aprovados lá
   estão nas constantes do shader (CAMADAS, MISTURA, ESPESSURA, BORDA,
   BRILHO, FLUXO); o esboço original fica em
   docs/design-refs/fundo-fizzle/tinta.fizzle.js.

   Como se lê como tinta:
     - mistura: o campo de cor é arrastado por uma deformação em duas
       etapas que gira devagar; as cores escorrem em veios na fronteira;
     - relevo: degrau entre camadas, tinta acumulada na borda e marca
       de cerda, iluminados por luz rasante; o reflexo molhado só
       aparece nos relevos. A normal sai de dFdx/dFdy da altura.
   Sem textura fina repetida (o CEO reprovou moiré e retícula).

   Reação (relativa à faixa, como o Relevo — ver gl/signal.ts): graves
   (swell) mexem e incham as camadas, o kick (pulse) levanta o relevo,
   os médios (midLift) engrossam os veios. Tudo amplitude: o relógio
   não é multiplicado por sinal (CMR-267).

   Custo: 12 ruídos de valor por pixel em resolução cheia, sem buffer
   reduzido (borrar a tinta seria o defeito da Nébula de 256 linhas).
   gl-bench na cmr-auto (WebKitGTK, 1857x1048, 11/10): 8,4 ms por
   quadro. Era 10,1 ms com a oitava fina no campo de arrasto (fbm3 em
   a e b; hoje fbm2, visual igual). Se não sustentar 60 fps no app, a
   próxima alavanca é calcular a e b (suaves) num buffer menor e só o
   resto em resolução cheia — as bordas continuam nítidas.
   ============================================================ */

import { FS_COMMON, HEAD, VS_TRI } from "../glsl";
import { makeProgram, type Program } from "../glkit";
import type { GlScene, SceneCtx, SceneDef, ScenePalette } from "../scene";
import type { GlSignal } from "../signal";

const FS = HEAD + FS_COMMON + `
uniform float uStir, uSwell, uLift, uVein;

const float CAMADAS = 6.0;     // camadas de tinta
const float MISTURA = 1.0;     // quanto as tintas se arrastam
const float ESPESSURA = 0.5;   // altura do relevo
const float BORDA = 0.5;       // relevo na fronteira entre camadas
const float BRILHO = 0.4;      // reflexo molhado
const float FLUXO = 0.05;      // velocidade da mistura

// sorteio por seno: na UHD 620 da cmr-auto, a versão por inteiros (pcg2d)
// custou 18 ms contra 10 (multiplicação de 32 bits é cara nessa GPU)
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vn(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
}
float fbm3(vec2 p) { return vn(p) * 0.55 + vn(p * 2.1 + 5.3) * 0.3 + vn(p * 4.3 + 9.1) * 0.15; }
// o campo que arrasta a tinta é suave: a oitava fina (15%) não aparece nele
float fbm2(vec2 p) { return (vn(p) * 0.55 + vn(p * 2.1 + 5.3) * 0.3) / 0.85; }
vec3 paleta(float x) {
  x = clamp(x, 0.0, 1.0);
  vec3 escuro = uCanvas * 1.6 + 0.015;
  vec3 claro = mix(uInk2, vec3(1.0), 0.25);
  return x < 0.5 ? mix(escuro, uInk, x * 2.0) : mix(uInk, claro, x * 2.0 - 1.0);
}

void main() {
  vec2 q = (gl_FragCoord.xy / uRes - 0.5) * vec2(uRes.x / uRes.y, 1.0);
  float t = uTime * FLUXO;

  // mistura: deformação em duas etapas que gira devagar
  float mexe = MISTURA * uStir;
  vec2 a = vec2(fbm2(q * 1.3 + vec2(t, 0.0)), fbm2(q * 1.3 + vec2(5.2, 1.3 - t)));
  vec2 b = vec2(fbm2(q * 1.7 + a * 2.0 + vec2(1.7, 9.2) + t * 0.5), fbm2(q * 1.7 + a * 2.0 + vec2(8.3, 2.8)));
  vec2 pw = q * 1.1 + (b - 0.5) * mexe + vec2(t * 0.3, 0.0);
  float n = clamp((fbm3(pw) - 0.25) / 0.5, 0.0, 1.0) + uSwell;

  // marca de cerda, arrastada e curvada pela própria mistura
  float pincel = vn(pw * vec2(4.0, 26.0) + 3.0);

  float nl = n * CAMADAS + (pincel - 0.5) * 0.06 * uVein;
  float k = floor(nl), fr = fract(nl);

  // cor: cada camada uma tinta; perto da borda, a de cima escorre em veios
  float veio = smoothstep(0.7, 1.0, fr + (pincel - 0.5) * 0.3);
  vec3 tinta = mix(paleta(k / (CAMADAS - 1.0)), paleta((k + 1.0) / (CAMADAS - 1.0)), veio * 0.6);

  // relevo: degrau entre camadas, tinta acumulada na borda, marca da cerda
  float degrau = k + smoothstep(0.72, 1.0, fr);
  float labio = exp(-min(fr, 1.0 - fr) * 8.0) * 0.3;
  float h = ((degrau * 0.35 + labio) * BORDA + (pincel - 0.5) * 0.12) * ESPESSURA * uLift;

  // luz rasante de cima à esquerda; reflexo molhado só nos relevos
  vec2 g = vec2(dFdx(h), dFdy(h)) * uRes.y * 0.008;
  vec3 N = normalize(vec3(-g, 1.0));
  vec3 Ld = normalize(vec3(-0.45, 0.55, 0.7));
  float dif = clamp(dot(N, Ld), 0.0, 1.0);
  float spec = pow(max(dot(N, normalize(Ld + vec3(0.0, 0.0, 1.0))), 0.0), 48.0) * BRILHO;

  vec3 col = tinta * (0.35 + 0.75 * dif) + vec3(1.0, 0.96, 0.9) * spec * 0.55;
  col += (h21(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) * 0.02;
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

export interface PaintReaction {
  /** Multiplica a força da mistura (1 = repouso). */
  stir: number;
  /** Soma na altura do campo: as camadas incham. */
  swell: number;
  /** Multiplica o relevo (1 = repouso). */
  lift: number;
  /** Multiplica a aspereza dos veios (1 = repouso). */
  vein: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Números que o shader usa, calculados uma vez por quadro. Só lê a
    reação relativa à faixa: grave alto e parado não move nada. */
export function paintReaction(sig: GlSignal): PaintReaction {
  const swell = clamp01(sig.swell);
  const pulse = clamp01(sig.pulse);
  const mid = clamp01(sig.midLift);
  return {
    stir: 1 + 0.3 * swell,
    swell: 0.04 * swell + 0.05 * pulse,
    lift: 1 + 0.8 * pulse,
    vein: 1 + mid,
  };
}

class Paint implements GlScene {
  private readonly prog: Program;

  constructor(private readonly ctx: SceneCtx) {
    this.prog = makeProgram(ctx.gl, VS_TRI, FS, { label: "paint" });
  }

  resize(): void {}

  frame(sig: GlSignal, pal: ScenePalette, _dt: number, w: number, h: number): void {
    const r = paintReaction(sig);
    this.prog.use();
    this.prog.common(sig, pal, w, h);
    this.prog.f("uStir", r.stir);
    this.prog.f("uSwell", r.swell);
    this.prog.f("uLift", r.lift);
    this.prog.f("uVein", r.vein);
    this.ctx.fullscreen();
  }

  dispose(): void {
    this.prog.dispose();
  }
}

export const paint: SceneDef = {
  key: "paint",
  create: (ctx) => new Paint(ctx),
};
