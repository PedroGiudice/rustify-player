// riso — esboço do Rustify para o Fizzle
// Mude os números abaixo e aperte ctrl+enter para rodar de novo.
// O desenho inteiro fica no shader (o bloco glsl lá embaixo): é ele que
// depois vai para o app, por isso nada de efeitos prontos do Fizzle aqui.

const FLUXO  = 0.35  // velocidade das manchas
const TAMANHO = 1.0  // tamanho das manchas (0.6 pequenas, 1.4 grandes)
const REACAO = 1.0   // força da reação ao som (0 desliga)

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
  float campo(vec2 p, float t, float esc) {
    float s = 0.0;
    for (int k = 0; k < 5; k++) {
      float i = float(k);
      vec2 c = vec2(sin(t * (0.31 + 0.07 * i) + i * 2.1) * 0.4 * uAspect,
                    cos(t * (0.23 + 0.05 * i) + i * 1.3) * 0.26);
      float r = (0.17 + 0.05 * mod(i, 3.0)) * esc;
      s += r * r / max(dot(p - c, p - c), 1e-4);
    }
    return s;
  }
  void main() {
    vec2 q = (vUv - 0.5) * vec2(uAspect, 1.0);
    float t = uTime * uFluxo;
    float esc = uTamanho * (1.0 + uGrave * uReacao * 0.15);
    // grão de impressão: a borda "ferve" 4 vezes por segundo, como animação feita à mão
    float quadro = floor(uTime * 4.0);
    float g1 = h21(vUv / uTexel + quadro);
    float g2 = h21(vUv / uTexel * 1.3 + 7.0 + quadro);

    float f1 = campo(q, t, esc);
    float m1 = smoothstep(0.96, 1.04, f1 + (g1 - 0.5) * 0.12);

    // segunda cor: só o miolo das manchas, fora de registro; o kick a desalinha
    vec2 desl = vec2(0.012, -0.008) + vec2(cos(uKickN * 2.4), sin(uKickN * 2.4)) * uKick * uReacao * 0.035;
    float f2 = campo(q + desl, t, esc * 0.85);
    float m2 = smoothstep(1.55, 1.65, f2 + (g2 - 0.5) * 0.15 + uMedio * uReacao * 0.3);

    vec3 col = uFundo;
    col = 1.0 - (1.0 - col) * (1.0 - uTinta1 * m1 * (0.82 + 0.18 * g2));
    col = 1.0 - (1.0 - col) * (1.0 - uTinta2 * m2 * (0.78 + 0.22 * g1));
    col += (h21(vUv / uTexel + fract(uTime) * 91.0) - 0.5) * 0.04;
    gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
  }
`, {
  uFluxo: FLUXO,
  uTamanho: TAMANHO,
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
