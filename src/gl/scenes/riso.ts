/* ============================================================
   scenes/riso.ts — Riso: manchas de tinta impressas em duas cores.

   Nasceu no Fizzle (11/10), esboço aprovado pelo CEO junto com a
   Tinta; o original fica em docs/design-refs/fundo-fizzle/
   riso.fizzle.js. Cinco metaballs que se fundem e se separam
   devagar, impressas como na risografia: a primeira cor (ink) é a
   mancha inteira, a segunda (ink2 clareado) só o miolo, um pouco
   fora de registro. As bordas são granuladas e "fervem" 4 vezes por
   segundo, como animação feita à mão. Sem textura fina repetida.

   Reação (relativa à faixa, como o Relevo — ver gl/signal.ts): graves
   (swell) crescem as manchas, cada kick (pulse) tira a segunda cor
   do lugar numa direção nova, os médios (midLift) engordam o miolo.
   O contador de kicks é integrado na CPU (stepKickCount).

   Custo: gl-bench na cmr-auto (WebKitGTK, 1857x1048, 11/10): 2,9 ms
   por quadro, em resolução cheia.
   ============================================================ */

import { FS_COMMON, HEAD, VS_TRI } from "../glsl";
import { makeProgram, type Program } from "../glkit";
import type { GlScene, SceneCtx, SceneDef, ScenePalette } from "../scene";
import type { GlSignal } from "../signal";

const FS = HEAD + FS_COMMON + `
uniform float uScale, uShift, uKickN, uCore;

const float FLUXO = 0.35;   // velocidade das manchas

float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float campo(vec2 p, float t, float esc, float asp) {
  float s = 0.0;
  for (int k = 0; k < 5; k++) {
    float i = float(k);
    vec2 c = vec2(sin(t * (0.31 + 0.07 * i) + i * 2.1) * 0.4 * asp,
                  cos(t * (0.23 + 0.05 * i) + i * 1.3) * 0.26);
    float r = (0.17 + 0.05 * mod(i, 3.0)) * esc;
    s += r * r / max(dot(p - c, p - c), 1e-4);
  }
  return s;
}

void main() {
  float asp = uRes.x / uRes.y;
  vec2 q = (gl_FragCoord.xy / uRes - 0.5) * vec2(asp, 1.0);
  float t = uTime * FLUXO;

  // grão de impressão: a borda "ferve" 4 vezes por segundo
  float quadro = floor(uTime * 4.0);
  float g1 = h21(gl_FragCoord.xy + quadro);
  float g2 = h21(gl_FragCoord.xy * 1.3 + 7.0 + quadro);

  float f1 = campo(q, t, uScale, asp);
  float m1 = smoothstep(0.96, 1.04, f1 + (g1 - 0.5) * 0.12);

  // segunda cor: só o miolo, fora de registro; o kick a desalinha
  vec2 desl = vec2(0.012, -0.008) + vec2(cos(uKickN * 2.4), sin(uKickN * 2.4)) * uShift;
  float f2 = campo(q + desl, t, uScale * 0.85, asp);
  float m2 = smoothstep(1.55, 1.65, f2 + (g2 - 0.5) * 0.15 + uCore);

  vec3 tinta2 = mix(uInk2, vec3(1.0), 0.5);
  vec3 col = 1.0 - (1.0 - uCanvas) * (1.0 - uInk * m1 * (0.82 + 0.18 * g2));
  col = 1.0 - (1.0 - col) * (1.0 - tinta2 * m2 * (0.78 + 0.22 * g1));
  col += (h21(gl_FragCoord.xy + fract(uTime) * 91.0) - 0.5) * 0.04;
  outColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

export interface RisoReaction {
  /** Escala das manchas (1 = repouso). */
  scale: number;
  /** Quanto a segunda cor sai do registro no kick. */
  shift: number;
  /** Soma no campo do miolo: a segunda cor engorda. */
  core: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Só lê a reação relativa à faixa: grave alto e parado não move nada. */
export function risoReaction(sig: GlSignal): RisoReaction {
  return {
    scale: 1 + 0.15 * clamp01(sig.swell),
    shift: 0.035 * clamp01(sig.pulse),
    core: 0.3 * clamp01(sig.midLift),
  };
}

export interface KickCount {
  n: number;
  armed: boolean;
}

/** Sobe acima disto: conta um kick. */
export const KICK_ON = 0.5;
/** Desce abaixo disto: pode contar o próximo. */
export const KICK_REARM = 0.2;
/** O contador dá a volta aqui (o shader só usa o ângulo n·2,4). */
export const KICK_WRAP = 1000;

/** Borda de subida do pulso com histerese: um kick longo, ou que
    oscila perto do limiar, conta uma vez só. */
export function stepKickCount(k: KickCount, pulse: number): KickCount {
  if (k.armed && pulse > KICK_ON) return { n: (k.n + 1) % KICK_WRAP, armed: false };
  if (!k.armed && pulse < KICK_REARM) return { n: k.n, armed: true };
  return k;
}

class Riso implements GlScene {
  private readonly prog: Program;
  private kick: KickCount = { n: 0, armed: true };

  constructor(private readonly ctx: SceneCtx) {
    this.prog = makeProgram(ctx.gl, VS_TRI, FS, { label: "riso" });
  }

  resize(): void {}

  frame(sig: GlSignal, pal: ScenePalette, _dt: number, w: number, h: number): void {
    this.kick = stepKickCount(this.kick, sig.pulse);
    const r = risoReaction(sig);
    this.prog.use();
    this.prog.common(sig, pal, w, h);
    this.prog.f("uScale", r.scale);
    this.prog.f("uShift", r.shift);
    this.prog.f("uKickN", this.kick.n);
    this.prog.f("uCore", r.core);
    this.ctx.fullscreen();
  }

  dispose(): void {
    this.prog.dispose();
  }
}

export const riso: SceneDef = {
  key: "riso",
  create: (ctx) => new Riso(ctx),
};
