// tinta — esboço do Rustify para o Fizzle (evolução do Papel)
// Mude os números abaixo e aperte ctrl+enter para rodar de novo.
// O desenho inteiro fica no shader (o bloco glsl lá embaixo): é ele que
// depois vai para o app, por isso nada de efeitos prontos do Fizzle aqui.

const CAMADAS   = 6     // quantas camadas de tinta
const MISTURA   = 1.0   // quanto as tintas são arrastadas uma para dentro da outra (0 recorte limpo)
const ESPESSURA = 0.5   // altura do relevo da tinta (0 chapada, 2 muito grossa)
const BORDA     = 0.5   // relevo na borda entre camadas (0 lisa, 1 degrau alto)
const BRILHO    = 0.4   // reflexo molhado da tinta (0 fosca)
const FLUXO     = 0.05  // velocidade da mistura
const REACAO    = 1.0   // força da reação ao som (0 desliga)

const FUNDO  = '#0d0d12'
const TINTA1 = '#ff4d5e'
const TINTA2 = '#f2d0a4'

// De onde vem o som (deixe só uma linha valendo):
//   audio()            entrada padrão do computador (microfone)
//   audio('monitor')   o que está tocando no computador, se aparecer na lista
//   audiofile()        abre um arquivo de música (dá para arrastar o arquivo na tela)
const SOM = audio()
const KICK = SOM.lowpass(150).kicks()

bg(FUNDO)

glsl(`
  float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float vn(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y);
  }
  float fbm3(vec2 p) { return vn(p) * 0.55 + vn(p * 2.1 + 5.3) * 0.3 + vn(p * 4.3 + 9.1) * 0.15; }
  vec3 paleta(float x) {
    x = clamp(x, 0.0, 1.0);
    vec3 escuro = uFundo * 1.6 + 0.015;
    return x < 0.5 ? mix(escuro, uTinta1, x * 2.0) : mix(uTinta1, uTinta2, x * 2.0 - 1.0);
  }

  void main() {
    vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
    float t = uTime * uFluxo;
    float L = uCamadas;

    // mistura: a tinta é arrastada por um campo que gira devagar (deformação em duas etapas)
    float mexe = uMistura * (1.0 + uGrave * uReacao * 0.3);
    vec2 a = vec2(fbm3(q * 1.3 + vec2(t, 0.0)), fbm3(q * 1.3 + vec2(5.2, 1.3 - t)));
    vec2 b = vec2(fbm3(q * 1.7 + a * 2.0 + vec2(1.7, 9.2) + t * 0.5), fbm3(q * 1.7 + a * 2.0 + vec2(8.3, 2.8)));
    vec2 pw = q * 1.1 + (b - 0.5) * mexe + vec2(t * 0.3, 0.0);
    float n = clamp((fbm3(pw) - 0.25) / 0.5, 0.0, 1.0) + uGrave * uReacao * 0.04 + uKick * uReacao * 0.05;

    // pincelada: marcas de cerda que a própria mistura arrasta e curva
    float pincel = vn(pw * vec2(4.0, 26.0) + 3.0);

    float nl = n * L + (pincel - 0.5) * 0.06 * (1.0 + uMedio * uReacao);
    float k = floor(nl), fr = fract(nl);

    // cor: cada camada uma tinta; perto da borda, a de cima escorre em veios sobre a de baixo
    float veio = smoothstep(0.7, 1.0, fr + (pincel - 0.5) * 0.3);
    vec3 tinta = mix(paleta(k / (L - 1.0)), paleta((k + 1.0) / (L - 1.0)), veio * 0.6);

    // relevo: camadas empilhadas, tinta acumulada na borda, marca da cerda
    float degrau = k + smoothstep(0.72, 1.0, fr);
    float labio = exp(-min(fr, 1.0 - fr) * 8.0) * 0.3;
    float h = ((degrau * 0.35 + labio) * uBorda + (pincel - 0.5) * 0.12) * uEspessura * (1.0 + uKick * uReacao * 0.8);

    // luz rasante de cima à esquerda; o reflexo molhado só aparece nos relevos
    vec2 g = vec2(dFdx(h), dFdy(h)) / uTexel.y * 0.008;
    vec3 N = normalize(vec3(-g, 1.0));
    vec3 Ld = normalize(vec3(-0.45, 0.55, 0.7));
    float dif = clamp(dot(N, Ld), 0.0, 1.0);
    float spec = pow(max(dot(N, normalize(Ld + vec3(0.0, 0.0, 1.0))), 0.0), 48.0) * uBrilho;

    vec3 col = tinta * (0.35 + 0.75 * dif) + vec3(1.0, 0.96, 0.9) * spec * 0.55;
    col += (h21(vUv / uTexel + fract(uTime) * 91.0) - 0.5) * 0.02;
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`, {
  uCamadas: CAMADAS,
  uMistura: MISTURA,
  uEspessura: ESPESSURA,
  uBorda: BORDA,
  uBrilho: BRILHO,
  uFluxo: FLUXO,
  uReacao: REACAO,
  uFundo: FUNDO,
  uTinta1: TINTA1,
  uTinta2: TINTA2,
  uGrave: SOM.lowpass(150).smooth(0.04, 0.35),
  uMedio: SOM.bandpass(300, 2500).smooth(0.1, 0.5),
  uAgudo: SOM.highpass(5000).smooth(0.03, 0.2),
  uKick: KICK,
  uKickN: KICK.counter(1000),
}).out()
