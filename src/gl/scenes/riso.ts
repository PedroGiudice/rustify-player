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

   Pele (31/10, pedido do CEO): quando um pedaço se solta, o par ganha
   uma pele que sobe em 2 s, fica 6 s e some até 12 s; enquanto existe,
   o par não faz ponte de fusão e, se reencostar, aparece uma costura
   fina. A lógica fica na CPU (risoSkin.ts, testada no replay real); o
   shader recebe centros e pele por uniform. Câmera 2 % mais longe.

   Custo: gl-bench na cmr-auto (WebKitGTK, 1857x1048, 31/10, app aberto
   em paralelo): 3,5 ms por quadro sem pele ativa (84 % do tempo no
   replay real; antes da pele, 3,3 ms) e 6,6-6,8 ms com pele.
   ============================================================ */

import { FS_COMMON, HEAD, VS_TRI } from "../glsl";
import { makeProgram, type Program } from "../glkit";
import type { GlScene, SceneCtx, SceneDef, ScenePalette } from "../scene";
import type { GlSignal } from "../signal";
import { drive } from "../react";
import { createRisoSkin, risoBalls, stepRisoSkin, RISO_FLUXO, RISO_ZOOM, SKIN_STEP_S, type RisoSkin } from "./risoSkin";

/* O shader é gerado desenrolado: 5 manchas e 10 pares em variáveis
   escalares, índices constantes. Com laço e vetor local (float f[5]) a
   GPU Intel da cmr-auto jogava o vetor para a memória e o quadro foi de
   3,3 para 15,5 ms (gl-bench, 31/10). */
const BALLS = [0, 1, 2, 3, 4];
const PAIRS: [number, number][] = [];
for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) PAIRS.push([i, j]);

/** Campos das 5 manchas no ponto `p` com raio * `esc`: declara v0..v4. */
const fields = (v: string, p: string, esc: string) =>
  BALLS.map((i) => `vec2 ${v}d${i} = ${p} - uBall[${i}].xy;
  float ${v}${i} = uBall[${i}].z * uBall[${i}].z * ${esc} / max(dot(${v}d${i}, ${v}d${i}), 1e-4);`).join("\n  ");

/** Menor e maior de cada par: declara vm0..vm9 / vM0..vM9. */
const pairMinMax = (v: string) =>
  PAIRS.map(([i, j], k) => `float ${v}m${k} = min(${v}${i}, ${v}${j}), ${v}M${k} = max(${v}${i}, ${v}${j});`).join("\n    ");

/** Campo com pele (a conta de skinnedField em risoSkin.ts), sobre `out`
    que já tem a soma: menos, por par, pele·min·(min/max)²; nunca abaixo da
    maior mancha. */
const skinned = (v: string, out: string) =>
  `${out} = max(${out}
      - ${PAIRS.map((_, k) => `uSkin[${k}] * ${v}m${k} * ${v}m${k} * ${v}m${k} / (${v}M${k} * ${v}M${k})`).join("\n      - ")},
      max(max(max(${v}0, ${v}1), max(${v}2, ${v}3)), ${v}4));`;

const sum = (v: string) => BALLS.map((i) => `${v}${i}`).join(" + ");

const FS = HEAD + FS_COMMON + `
uniform float uShift, uKickN, uCore;
uniform vec3 uBall[5];     // centro (xy) e raio (z) de cada mancha, da CPU
uniform float uSkin[10];   // pele de cada par (0..1), da CPU (risoSkin.ts)
uniform float uSkinOn;     // 1 se algum par tem pele (senão pula a costura)

const float ZOOM = ${RISO_ZOOM.toFixed(4)};
const float COSTURA_PX = 1.6;  // meia largura da costura, em pixels

float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

void main() {
  float asp = uRes.x / uRes.y;
  vec2 q = (gl_FragCoord.xy / uRes - 0.5) * vec2(asp, 1.0) * ZOOM;

  // grão de impressão: a borda "ferve" 4 vezes por segundo
  float quadro = floor(uTime * 4.0);
  float g1 = h21(gl_FragCoord.xy + quadro);
  float g2 = h21(gl_FragCoord.xy * 1.3 + 7.0 + quadro);

  ${fields("a", "q", "1.0")}
  float f1 = ${sum("a")};

  // A pele só custa quando existe (84 % do tempo no replay real não há):
  // o if é de uniform, igual em todos os pixels. Dentro, sem desvio.
  float seam = 0.0;
  if (uSkinOn > 0.5) {
    ${pairMinMax("a")}
    ${skinned("a", "f1")}
    // A costura: onde dois pedaços com pele se encostam, uma linha fina de
    // papel onde as duas manchas que mandam ali pesam igual (a mesma
    // fronteira que a CPU usa para separar os pedaços). A segunda maior
    // mancha é o maior dos mínimos de par; a pele é a do par que o dá.
    float fa = max(max(max(a0, a1), max(a2, a3)), a4);
    float fb = max(max(max(max(am0, am1), max(am2, am3)), max(max(am4, am5), max(am6, am7))), max(am8, am9));
    float sk = max(max(max(max(uSkin[0] * step(fb, am0), uSkin[1] * step(fb, am1)),
                           max(uSkin[2] * step(fb, am2), uSkin[3] * step(fb, am3))),
                       max(max(uSkin[4] * step(fb, am4), uSkin[5] * step(fb, am5)),
                           max(uSkin[6] * step(fb, am6), uSkin[7] * step(fb, am7)))),
                   max(uSkin[8] * step(fb, am8), uSkin[9] * step(fb, am9)));
    float d = fa - fb;
    float px = d / max(fwidth(d), 1e-6);
    seam = sk * (1.0 - smoothstep(COSTURA_PX * 0.5, COSTURA_PX, px)) * (0.75 + 0.25 * g2);
  }
  float m1 = smoothstep(0.96, 1.04, f1 + (g1 - 0.5) * 0.12) * (1.0 - seam);

  // segunda cor: só o miolo, fora de registro; o kick a desalinha
  vec2 desl = vec2(0.012, -0.008) + vec2(cos(uKickN * 2.4), sin(uKickN * 2.4)) * uShift;
  vec2 q2 = q + desl;
  ${fields("b", "q2", "0.7225")}
  float f2 = ${sum("b")};
  if (uSkinOn > 0.5) {
    ${pairMinMax("b")}
    ${skinned("b", "f2")}
  }
  float m2 = smoothstep(1.55, 1.65, f2 + (g2 - 0.5) * 0.15 + uCore) * (1.0 - seam);

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
    scale: 1 + 0.15 * drive(sig.swell),
    shift: 0.035 * clamp01(sig.pulse),
    core: 0.3 * drive(sig.midLift),
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
  private readonly skin: RisoSkin = createRisoSkin();
  private readonly balls = new Float32Array(15);
  private skinAcc = 0;

  constructor(private readonly ctx: SceneCtx) {
    this.prog = makeProgram(ctx.gl, VS_TRI, FS, { label: "riso" });
  }

  resize(): void {}

  frame(sig: GlSignal, pal: ScenePalette, dt: number, w: number, h: number): void {
    this.kick = stepKickCount(this.kick, sig.onset);
    const r = risoReaction(sig);
    const asp = w / Math.max(1, h);
    risoBalls(sig.clock * RISO_FLUXO, asp, r.scale, this.balls);
    this.skinAcc += dt;
    if (this.skinAcc >= SKIN_STEP_S) {
      stepRisoSkin(this.skin, this.balls, asp, this.skinAcc);
      this.skinAcc = 0;
    }
    const gl = this.ctx.gl;
    this.prog.use();
    this.prog.common(sig, pal, w, h);
    gl.uniform3fv(this.prog.loc("uBall"), this.balls);
    gl.uniform1fv(this.prog.loc("uSkin"), this.skin.skin);
    let on = 0;
    for (let k = 0; k < this.skin.skin.length; k++) if (this.skin.skin[k] > 0) on = 1;
    this.prog.f("uSkinOn", on);
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
