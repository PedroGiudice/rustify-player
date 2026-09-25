/* ============================================================
   gl/scenes.ts — os quatro fundos WebGL do Now Playing.

   Porte fiel do laboratório aprovado (artifact "Rustify Fundo
   Lab", 12/09): Poeira, Relevo, Órbitas e Nébula. O que mudou do
   lab pro app: o sinal não é simulado (vem de gl/signal.ts, que
   é o FFT real) e a paleta não é uma lista fixa (vem das CSS
   vars via gl/palette.ts, então tema/capa/knob mandam aqui).

   Um ÚNICO WebGLRenderer (GlStage) vive enquanto o fundo WebGL
   estiver ligado; trocar de cena reconstrói geometria e materiais
   mas NUNCA o contexto GL — contexto de WebGL é recurso escasso
   no WebKitGTK e recriá-lo a cada troca acaba em "too many
   contexts" com o canvas preto.

   Orçamento: DPR fixo em 1 (a cmr-auto é UHD 620 a 1366x768; o
   lab rodou assim e é o mesmo alvo). Antialias desligado, alpha
   desligado — as cenas limpam em preto puro (gl/palette.ts,
   GL_CANVAS; paridade com o fundo do 2D) e desenham por cima.
   A Nébula, que é toda fillrate, desenha num buffer de até 256
   linhas e escala para a tela (gl/budget.ts).
   ============================================================ */

import {
  AdditiveBlending,
  BufferGeometry,
  BufferAttribute,
  Color,
  Float32BufferAttribute,
  Line,
  LineBasicMaterial,
  LinearFilter,
  MathUtils,
  Mesh,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Points,
  Scene,
  ShaderMaterial,
  Vector2,
  WebGLRenderer,
  WebGLRenderTarget,
  type Camera,
  type IUniform,
} from "three";

import { advanceDustTravel } from "./motion";
import { NEBULA_MAX_ROWS, reducedBufferSize } from "./budget";
import type { GlPalette, Rgb } from "./palette";
import type { GlSignal } from "./signal";
import type { SceneKey } from "./meta";

/* ---------- GLSL compartilhado ---------- */

const NOISE = `
vec3 mod289(vec3 x){return x-floor(x*(1.0/289.0))*289.0;}
vec2 mod289(vec2 x){return x-floor(x*(1.0/289.0))*289.0;}
vec3 permute(vec3 x){return mod289(((x*34.0)+1.0)*x);}
float snoise(vec2 v){
  const vec4 C=vec4(0.211324865405187,0.366025403784439,-0.577350269189626,0.024390243902439);
  vec2 i=floor(v+dot(v,C.yy)); vec2 x0=v-i+dot(i,C.xx);
  vec2 i1=(x0.x>x0.y)?vec2(1.0,0.0):vec2(0.0,1.0);
  vec4 x12=x0.xyxy+C.xxzz; x12.xy-=i1; i=mod289(i);
  vec3 p=permute(permute(i.y+vec3(0.0,i1.y,1.0))+i.x+vec3(0.0,i1.x,1.0));
  vec3 m=max(0.5-vec3(dot(x0,x0),dot(x12.xy,x12.xy),dot(x12.zw,x12.zw)),0.0); m=m*m; m=m*m;
  vec3 x=2.0*fract(p*C.www)-1.0; vec3 h=abs(x)-0.5; vec3 ox=floor(x+0.5); vec3 a0=x-ox;
  m*=1.79284291400159-0.85373472095314*(a0*a0+h*h);
  vec3 g; g.x=a0.x*x0.x+h.x*x0.y; g.yz=a0.yz*x12.xz+h.yz*x12.yw;
  return 130.0*dot(m,g);
}
float fbm(vec2 p){float f=0.0,a=0.5;for(int i=0;i<5;i++){f+=a*snoise(p);p=p*2.02+vec2(17.3,9.1);a*=0.5;}return f;}
`;

interface BaseUniforms {
  uTime: IUniform<number>;
  uLow: IUniform<number>;
  uMid: IUniform<number>;
  uHigh: IUniform<number>;
  uBeat: IUniform<number>;
  uCanvas: IUniform<Color>;
  uInk: IUniform<Color>;
  uInk2: IUniform<Color>;
  uSoft: IUniform<Color>;
  uRes: IUniform<Vector2>;
}

function baseUniforms(): BaseUniforms {
  return {
    uTime: { value: 0 },
    uLow: { value: 0 },
    uMid: { value: 0 },
    uHigh: { value: 0 },
    uBeat: { value: 0 },
    uCanvas: { value: new Color() },
    uInk: { value: new Color() },
    uInk2: { value: new Color() },
    uSoft: { value: new Color() },
    uRes: { value: new Vector2(1, 1) },
  };
}

const toColor = (c: Rgb) => new Color(c.r / 255, c.g / 255, c.b / 255);

/* ---------- cenas ---------- */

abstract class SceneBase {
  readonly scene = new Scene();
  readonly u = baseUniforms();
  camera!: Camera;
  protected disposables: Array<{ dispose(): void }> = [];

  setPalette(p: GlPalette): void {
    this.u.uCanvas.value.copy(toColor(p.canvas));
    this.u.uInk.value.copy(toColor(p.ink));
    this.u.uInk2.value.copy(toColor(p.ink2));
    this.u.uSoft.value.copy(toColor(p.soft));
    this.onPalette?.(p);
  }

  onPalette?(p: GlPalette): void;

  resize(w: number, h: number, dpr: number): void {
    const cam = this.camera as PerspectiveCamera;
    if (cam.isPerspectiveCamera) {
      cam.aspect = w / h;
      cam.updateProjectionMatrix();
    }
    this.u.uRes.value.set(w * dpr, h * dpr);
  }

  /** Uniforms comuns + movimento próprio da cena. */
  step(sig: GlSignal, dt: number): void {
    this.u.uTime.value = sig.clock;
    this.u.uLow.value = sig.low;
    this.u.uMid.value = sig.mid;
    this.u.uHigh.value = sig.high;
    this.u.uBeat.value = sig.beat;
    this.update?.(sig, dt);
  }

  update?(sig: GlSignal, dt: number): void;

  /** Desenha o quadro. Cena que usa buffer próprio sobrescreve e deve
      devolver o renderer apontando para a tela (setRenderTarget(null)). */
  render(r: WebGLRenderer): void {
    r.render(this.scene, this.camera);
  }

  dispose(): void {
    for (const d of this.disposables) {
      try { d.dispose(); } catch { /* contexto já perdido */ }
    }
    this.disposables = [];
    this.scene.clear();
  }
}

/** Poeira: 6000 pontos em volume fluindo para a câmera, disco aditivo.
    O fluxo em z é integrado na CPU (gl/motion.ts, CMR-267): o shader só
    recebe o deslocamento pronto em uTravel. */
class Dust extends SceneBase {
  private readonly travelU: IUniform<number> = { value: 0 };
  private lastClock: number | null = null;

  constructor() {
    super();
    const cam = new PerspectiveCamera(55, 16 / 9, 0.1, 200);
    cam.position.set(0, 0, 10);
    this.camera = cam;

    const N = 6000;
    const pos = new Float32Array(N * 3);
    const seed = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      pos[i * 3] = (Math.random() - 0.5) * 70;
      pos[i * 3 + 1] = (Math.random() - 0.5) * 40;
      pos[i * 3 + 2] = -Math.random() * 90;
      seed[i] = Math.random();
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new BufferAttribute(pos, 3));
    g.setAttribute("aSeed", new BufferAttribute(seed, 1));
    const m = new ShaderMaterial({
      uniforms: { ...this.u, uTravel: this.travelU } as unknown as Record<string, IUniform>,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      vertexShader: `
        attribute float aSeed; varying float vSeed; varying float vDepth;
        uniform float uTime,uLow,uBeat,uTravel;
        void main(){
          vSeed=aSeed;
          vec3 p=position;
          p.z=mod(p.z+uTravel+aSeed*90.0,90.0)-85.0;
          p.x+=sin(uTime*0.4+aSeed*40.0)*1.6; p.y+=cos(uTime*0.33+aSeed*31.0)*1.1;
          vec4 mv=modelViewMatrix*vec4(p,1.0);
          float d=-mv.z; vDepth=clamp(1.0-d/85.0,0.0,1.0);
          float size=(1.6+2.4*aSeed)*(1.0+0.9*uLow+0.6*uBeat);
          gl_PointSize=size*(160.0/d);
          gl_Position=projectionMatrix*mv;
        }`,
      fragmentShader: `
        varying float vSeed; varying float vDepth;
        uniform vec3 uInk,uInk2,uSoft; uniform float uLow,uHigh;
        void main(){
          vec2 q=gl_PointCoord-0.5; float d=length(q);
          float a=smoothstep(0.5,0.05,d); a*=a;
          vec3 col=mix(uInk,vSeed>0.8?uSoft:uInk2,vSeed);
          float lum=0.22+0.55*uLow+0.35*uHigh;
          gl_FragColor=vec4(col*lum*(0.35+0.65*vDepth),a*(0.25+0.75*vDepth));
        }`,
    });
    this.scene.add(new Points(g, m));
    this.disposables.push(g, m);
  }

  update(sig: GlSignal): void {
    // Avanço do relógio VIRTUAL (não o dt de parede): bgSpeed e o
    // beat-sync seguem valendo para a deriva, como no uTime antigo.
    const dClock = this.lastClock === null ? 0 : sig.clock - this.lastClock;
    this.lastClock = sig.clock;
    this.travelU.value = advanceDustTravel(this.travelU.value, dClock, sig.mid);

    const c = this.camera as PerspectiveCamera;
    c.position.x = Math.sin(sig.clock * 0.11) * 1.2;
    c.position.y = Math.cos(sig.clock * 0.09) * 0.8;
    c.lookAt(0, 0, -30);
  }
}

/** Relevo: plano deslocado por ruído no vértice, wireframe com névoa. */
class Relief extends SceneBase {
  constructor() {
    super();
    const cam = new PerspectiveCamera(50, 16 / 9, 0.1, 300);
    cam.position.set(0, 13, 42);
    cam.lookAt(0, -2, -20);
    this.camera = cam;

    const g = new PlaneGeometry(150, 110, 120, 88);
    g.rotateX(-Math.PI / 2);
    const m = new ShaderMaterial({
      uniforms: this.u as unknown as Record<string, IUniform>,
      wireframe: true,
      transparent: true,
      depthWrite: false,
      vertexShader: NOISE + `
        uniform float uTime,uLow,uMid,uBeat; varying float vH; varying float vD;
        void main(){
          vec3 p=position;
          vec2 q=p.xz*0.045+vec2(0.0,uTime*0.10);
          float h=fbm(q)*(5.5+5.0*uLow+3.0*uBeat);
          float ridge=sin(p.x*0.22+uTime*0.9)*exp(-abs(p.z+15.0)*0.05)*6.0*uMid;
          p.y+=h+ridge;
          vH=clamp((h+ridge)/12.0,0.0,1.0);
          vec4 mv=modelViewMatrix*vec4(p,1.0); vD=-mv.z;
          gl_Position=projectionMatrix*mv;
        }`,
      fragmentShader: `
        uniform vec3 uCanvas,uInk,uInk2,uSoft; uniform float uHigh; varying float vH; varying float vD;
        void main(){
          float fog=smoothstep(140.0,25.0,vD);
          vec3 col=mix(uInk,uInk2,vH);
          col=mix(col,uSoft,uHigh*0.35*vH);
          gl_FragColor=vec4(col,(0.10+0.55*vH)*fog);
        }`,
    });
    this.scene.add(new Mesh(g, m));
    this.disposables.push(g, m);
  }

  update(sig: GlSignal): void {
    const c = this.camera as PerspectiveCamera;
    c.position.x = Math.sin(sig.clock * 0.07) * 4;
    c.lookAt(0, -2, -20);
  }
}

/** Órbitas: 40 anéis inclinados ao longo de z; a câmera atravessa o túnel. */
class Orbits extends SceneBase {
  private readonly N = 40;
  private rings: Array<Line<BufferGeometry, LineBasicMaterial>> = [];
  private zoff = 0;
  private ink = new Color();
  private ink2 = new Color();
  private soft = new Color();

  constructor() {
    super();
    const cam = new PerspectiveCamera(60, 16 / 9, 0.1, 200);
    cam.position.set(0, 0, 12);
    this.camera = cam;

    const SEG = 128;
    const pts: number[] = [];
    for (let i = 0; i <= SEG; i++) {
      const a = (i / SEG) * Math.PI * 2;
      pts.push(Math.cos(a), Math.sin(a), 0);
    }
    const g = new BufferGeometry();
    g.setAttribute("position", new Float32BufferAttribute(pts, 3));
    this.disposables.push(g);

    for (let i = 0; i < this.N; i++) {
      const mat = new LineBasicMaterial({
        transparent: true,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      const r = new Line(g, mat);
      r.userData = {
        i,
        base: -i * 3.2,
        tilt: 0.35 + Math.sin(i * 0.7) * 0.25,
        spin: (0.12 + (i % 5) * 0.04) * (i % 2 ? 1 : -1),
        radius: 9 + Math.sin(i * 0.45) * 3,
      };
      this.scene.add(r);
      this.rings.push(r);
      this.disposables.push(mat);
    }
  }

  onPalette(p: GlPalette): void {
    this.ink.copy(toColor(p.ink));
    this.ink2.copy(toColor(p.ink2));
    this.soft.copy(toColor(p.soft));
  }

  update(sig: GlSignal, dt: number): void {
    this.zoff += dt * (2.5 + 4 * sig.low);
    const L = this.N * 3.2;
    for (const r of this.rings) {
      const d = r.userData as {
        i: number; base: number; tilt: number; spin: number; radius: number;
      };
      const z = ((((d.base + this.zoff) % L) + L) % L) - L + 12;
      r.position.z = z;
      const s = d.radius * (1 + 0.18 * sig.low * Math.sin(sig.clock * 6 + d.i) + 0.12 * sig.beat);
      r.scale.set(s, s, 1);
      r.rotation.x = d.tilt + Math.sin(sig.clock * 0.3 + d.i * 0.2) * 0.15;
      r.rotation.z += dt * d.spin * (1 + 2 * sig.mid);
      const depth = MathUtils.clamp(1 - (12 - z) / L, 0, 1);
      const near = MathUtils.smoothstep(z, 12, 6);
      r.material.opacity = (0.08 + 0.6 * depth * depth) * (0.4 + 0.6 * sig.high) * (1 - near);
      r.material.color.copy(d.i % 3 === 0 ? this.ink2 : this.ink).lerp(this.soft, sig.high * 0.25 * depth);
    }
    const c = this.camera as PerspectiveCamera;
    c.position.x = Math.sin(sig.clock * 0.2) * 0.6;
    c.position.y = Math.cos(sig.clock * 0.17) * 0.4;
  }

  dispose(): void {
    this.rings = [];
    super.dispose();
  }
}

/** Nébula: quad fullscreen, fbm com domain warping. Sem geometria.
    O fbm roda num buffer de no máximo 256 linhas (gl/budget.ts) e um
    segundo quad escala para a tela com filtro linear e dither IGN —
    em resolução cheia a cena custava mais que um quadro de 60 fps. */
class Nebula extends SceneBase {
  private readonly rt = new WebGLRenderTarget(1, 1, {
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
    generateMipmaps: false,
  });
  /** Resolução do buffer: o gl_FragCoord da passada reduzida vive nela. */
  private readonly bufRes: IUniform<Vector2> = { value: new Vector2(1, 1) };
  private readonly composite = new Scene();

  constructor() {
    super();
    this.camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const g = new PlaneGeometry(2, 2);
    const vertexShader = `void main(){gl_Position=vec4(position.xy,0.0,1.0);}`;

    // Composite: amostra o buffer na resolução da tela (u.uRes) e soma
    // meio degrau de 8 bits de ruído IGN, que some com o banding que a
    // escala linear revelaria no gradiente escuro.
    const cm = new ShaderMaterial({
      uniforms: { uTex: { value: this.rt.texture }, uRes: this.u.uRes } as unknown as Record<string, IUniform>,
      depthTest: false,
      depthWrite: false,
      vertexShader,
      fragmentShader: `
        uniform sampler2D uTex; uniform vec2 uRes;
        float ign(vec2 p){return fract(52.9829189*fract(dot(p,vec2(0.06711056,0.00583715))));}
        void main(){
          vec3 c=texture2D(uTex,gl_FragCoord.xy/uRes).rgb;
          c+=(ign(gl_FragCoord.xy)-0.5)/255.0;
          gl_FragColor=vec4(c,1.0);
        }`,
    });
    this.composite.add(new Mesh(g, cm));
    this.disposables.push(cm, this.rt);

    const m = new ShaderMaterial({
      uniforms: { ...this.u, uRes: this.bufRes } as unknown as Record<string, IUniform>,
      vertexShader,
      fragmentShader: NOISE + `
        uniform vec2 uRes; uniform float uTime,uLow,uMid,uHigh,uBeat; uniform vec3 uCanvas,uInk,uInk2,uSoft;
        void main(){
          vec2 uv=gl_FragCoord.xy/uRes; vec2 p=(uv-0.5)*vec2(uRes.x/uRes.y,1.0)*1.6;
          float t=uTime*0.06;
          vec2 q=vec2(fbm(p+t),fbm(p+vec2(5.2,1.3)-t));
          vec2 r=vec2(fbm(p+1.7*q*(0.8+0.6*uLow)+vec2(1.7,9.2)+t*0.7),fbm(p+1.7*q+vec2(8.3,2.8)-t*0.5));
          float f=fbm(p+2.0*r);
          float body=smoothstep(0.15,0.95,f*0.5+0.5);
          vec3 col=mix(uCanvas,uInk,body*(0.35+0.5*uLow+0.2*uBeat));
          col=mix(col,uInk2,smoothstep(0.55,0.95,length(r))*uMid*0.5);
          col+=uSoft*pow(max(0.0,f),3.0)*uHigh*0.35;
          float vig=1.0-0.45*dot(uv-0.5,uv-0.5)*2.0;
          gl_FragColor=vec4(col*vig,1.0);
        }`,
    });
    this.scene.add(new Mesh(g, m));
    this.disposables.push(g, m);
  }

  resize(w: number, h: number, dpr: number): void {
    super.resize(w, h, dpr);
    const b = reducedBufferSize(w * dpr, h * dpr, NEBULA_MAX_ROWS);
    this.rt.setSize(b.w, b.h);
    this.bufRes.value.set(b.w, b.h);
  }

  render(r: WebGLRenderer): void {
    r.setRenderTarget(this.rt);
    r.render(this.scene, this.camera);
    r.setRenderTarget(null);
    r.render(this.composite, this.camera);
  }

  dispose(): void {
    super.dispose();
    this.composite.clear();
  }
}

const CTORS: Record<SceneKey, new () => SceneBase> = {
  dust: Dust,
  relief: Relief,
  orbits: Orbits,
  nebula: Nebula,
};

/* ---------- palco ---------- */

export class GlStage {
  private renderer: WebGLRenderer;
  private current: SceneBase;
  private key: SceneKey;
  private palette: GlPalette | null = null;
  private w = 1;
  private h = 1;
  private dpr = 1;

  /** @throws se o browser não der um contexto WebGL (chamador cai pro 2D). */
  constructor(canvas: HTMLCanvasElement, key: SceneKey) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(1);
    this.key = key;
    this.current = new CTORS[key]();
  }

  /** Nome do renderer GL exposto pelo driver — diagnóstico no Tweaks. */
  rendererName(): string {
    try {
      const gl = this.renderer.getContext();
      const dbg = gl.getExtension("WEBGL_debug_renderer_info");
      const name = dbg
        ? (gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) as string)
        : (gl.getParameter(gl.RENDERER) as string);
      return name || "desconhecido";
    } catch {
      return "não exposto";
    }
  }

  setScene(key: SceneKey): void {
    if (key === this.key) return;
    this.current.dispose();
    // Uma cena com buffer próprio (Nébula) nunca deixa o renderer
    // apontando para ele; isto só garante que a próxima comece da tela.
    this.renderer.setRenderTarget(null);
    this.key = key;
    this.current = new CTORS[key]();
    if (this.palette) this.current.setPalette(this.palette);
    this.current.resize(this.w, this.h, this.dpr);
  }

  setPalette(p: GlPalette): void {
    this.palette = p;
    this.current.setPalette(p);
    this.renderer.setClearColor(toColor(p.canvas), 1);
  }

  resize(w: number, h: number, dpr = 1): void {
    this.w = Math.max(1, w);
    this.h = Math.max(1, h);
    this.dpr = dpr;
    this.renderer.setPixelRatio(dpr);
    this.renderer.setSize(this.w, this.h, false);
    this.current.resize(this.w, this.h, dpr);
  }

  frame(sig: GlSignal, dt: number): void {
    this.current.step(sig, dt);
    this.current.render(this.renderer);
  }

  dispose(): void {
    this.current.dispose();
    this.renderer.dispose();
    // Solta o contexto de verdade: sem isto o WebKitGTK segura o
    // contexto até o GC e ligar/desligar o toggle várias vezes
    // esbarra no teto de contextos do processo.
    try { this.renderer.forceContextLoss(); } catch { /* ok */ }
  }
}
