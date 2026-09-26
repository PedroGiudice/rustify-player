/* ============================================================
   gl/glsl.ts — trechos de GLSL ES 3.00 compartilhados pelas cenas.

   Toda cena é WebGL2 puro: o shader começa com HEAD (a diretiva
   #version PRECISA ser a primeira linha) e usa `in`/`out`, não
   `attribute`/`varying`/`gl_FragColor`. Precisão highp em tudo,
   a mesma que o three usava por padrão — trocar para mediump
   muda o ruído das cenas em GPU móvel.
   ============================================================ */

export const HEAD = "#version 300 es\nprecision highp float;\nprecision highp int;\n";

/** Uniforms comuns que Program.common() preenche (ver gl/glkit.ts). */
export const UNI = `
uniform vec2 uRes; uniform float uTime,uLow,uMid,uHigh,uBeat;
uniform vec3 uCanvas,uInk,uInk2,uSoft;
`;

/** Ruído de gradiente intercalado (Jimenez): meio degrau de 8 bits some
    com o banding de gradiente escuro sem padrão visível. */
export const IGN = `
float ign(vec2 p){return fract(52.9829189*fract(dot(p,vec2(0.06711056,0.00583715))));}
vec3 dither(vec3 c){return c+(ign(gl_FragCoord.xy)-0.5)/255.0;}
`;

/** Cabeçalho de fragment shader com os uniforms comuns, a saída
    `outColor` e o dither IGN. */
export const FS_COMMON = UNI + `
out vec4 outColor;
` + IGN;

/** Vértice do triângulo de tela cheia sem buffer nenhum: o motor
    desenha 3 vértices com um VAO vazio (SceneCtx.fullscreen) e o
    gl_VertexID gera os cantos. */
export const VS_TRI = HEAD + `void main(){vec2 p=vec2(float((gl_VertexID<<1)&2),float(gl_VertexID&2));gl_Position=vec4(p*2.0-1.0,0.0,1.0);}`;

/** Codificação linear -> sRGB, idêntica ao sRGBTransferOETF do three.
    Os materiais embutidos do three (LineBasicMaterial) aplicavam isso
    na saída; os ShaderMaterial não. Só a Órbitas precisa, por paridade. */
export const SRGB_OETF = `
vec3 srgbOetf(vec3 v){return mix(pow(v,vec3(0.41666))*1.055-vec3(0.055),v*12.92,vec3(lessThanEqual(v,vec3(0.0031308))));}
`;

/** Simplex 2D (Ashima/McEwan) + fbm de 5 oitavas. */
export const NOISE = `
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
