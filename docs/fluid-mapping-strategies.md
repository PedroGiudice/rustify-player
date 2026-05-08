# FluidBackground: Estratégias de Mapeamento Generativo

Este documento consolida as propostas do agente `generative-viz-dev` para o mapeamento da energia do áudio (FFT) nos emissores (splats) do simulador de fluidos Navier-Stokes (`FluidBackground.tsx`).

## O Desafio do Mapeamento
Um solver de fluidos preserva o *momentum* (inércia) das partículas. Se injetarmos energia em posições e direções aleatórias ou desorganizadas, os vetores de velocidade colidem caoticamente, dissipando a energia e transformando a tela numa "sopa" estática e cinzenta. A física precisa de uma **Geometria Emissora** coerente para gerar vórtices bonitos.

---

## Estratégias de Emissão (Geometrias)

### 1. O Reator (Simetria Radial) - *Recomendado*
Cria uma esfera pulsante no centro da tela. O grave age como o núcleo do reator, empurrando o fluido para fora, enquanto os agudos orbitam esse núcleo injetando detalhes e turbulência na expansão.

**Setup Lógico:**
- **Posição:** Todas as frequências nascem perto do centro `(0.5, 0.5)`. Sub-bass exatamente no meio; agudos formando um pequeno anel ao redor.
- **Direção:** Vetores radiais centrífugos (tangentes ou explodindo para fora). O ângulo depende da posição do emissor no anel.
- **Física:** Expansão contínua a partir do centro, criando uma nebulosa esférica.

### 2. O Muro de Fumaça (Linear Bottom-Up)
Uma tradução mais literal de um espectrograma tradicional, mas com física de fluidos (fumaça).

**Setup Lógico:**
- **Posição:** Alinhados na base da tela (`Y = 0.1`). Distribuídos no eixo X (ex: `X = 0.2` a `X = 0.8`).
- **Direção:** Todos os splats apontam rigorosamente para cima (`angle = Math.PI / 2`).
- **Tamanho:** Grave usa um `radius` imenso para mover massas de ar pesadas. Agudos usam um `radius` fino para fumaça rápida e nítida.
- **Física:** Cria colunas de cor que sobem e colidem no topo da tela, derretendo em vórtices lentos enquanto caem pelas laterais.

### 3. A Colisão Estéreo (Simetria Bilateral)
Foco em choque de ondas para criar padrões de interferência perfeitos (*Von Kármán vortex street*).

**Setup Lógico:**
- **Posição:** Dividido em dois pólos laterais. Exemplo: Graves profundos nas extremidades extremas esquerda (`X=0.1, Y=0.5`) e direita (`X=0.9, Y=0.5`).
- **Direção:** Os emissores da esquerda atiram para a direita, e os da direita atiram para a esquerda, mirando exatamente no centro `(0.5, 0.5)`.
- **Física:** O grave atira "tsunamis" de cor das bordas. Quando se chocam no meio da tela, a pressão lateral força a tinta para cima e para baixo em espirais perfeitamente simétricas.

---

## Color Science: Evitando a "Sopa Cinza"

**O Problema Atual:**
Mapear as 7 regiões cobrindo todo o arco-íris (`Hue + r * 0.1` ou `0 a 360`) é perigoso em fluidos. Quando cores opostas (complementares) se adveccionam e se misturam no solver, a matemática resulta em branco ou marrom-sujo.

**A Solução Generativa (Cores Análogas):**
Amasse o espectro de cor. Em vez de percorrer toda a roda de cores, use um delta pequeno a partir do `baseHue` (a cor da faixa de áudio).

**Exemplo de Ajuste no Código:**
\`\`\`javascript
// Ruim: espalha muito, mistura vira cinza
// HSVtoRGB(baseHue + r * 0.1, 1.0, 1.0) 

// Bom: Cores análogas limitadas. 
// Se baseHue é Azul, o grave é Azul Escuro, o agudo é Ciano brilhante.
function generateColor(baseHue, r) {
    const hueOffset = (r / 6.0) * 0.15; // Spread de apenas 15% do espectro
    const c = HSVtoRGB(baseHue + hueOffset, 1.0, 1.0);
    // Agudos podem ser mais saturados ou ter mais brightness
    return { r: c.r * 0.2, g: c.g * 0.2, b: c.b * 0.2 }; 
}
\`\`\`
