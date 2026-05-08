# Spectrum Visualizer: Estéticas Orgânicas Avançadas

Este documento detalha os paradigmas arquiteturais de **Creative Coding** propostos pelo agente `generative-viz-dev` para transformar o visualizador de espectro do rustify-player de um "wireframe geométrico" para estéticas orgânicas fluidas (pó, chama, líquido).

## A Fundação Essencial (O Height Map)
Nenhuma dessas estéticas funciona sem uma fundação matemática sólida para o mapa de deslocamento (Displacement Map). A função base de `loadShape` deve garantir:

1. **Gravidade Contínua (SDF Aproximado):** Substituir o filtro CSS \`contrast()\` por múltiplos passes de \`blur()\` aditivo. Isso transforma bordas duras em ladeiras gravitacionais, fazendo a malha se curvar suavemente em direção à imagem.
2. **Ruído Procedural (Jitter):** Adicionar micro-variações na luminosidade antes de rodar o filtro de Sobel para que as normais (direções) tenham angulações caóticas, quebrando o aspecto CGI/plástico.
3. **Fluxo Tangencial:** Inverter a leitura do Sobel para \`(-gy, gx)\` faz a energia contornar (orbitar) a forma, em vez de bater de frente e gerar "espinhos".

---

## Os 3 Caminhos Visuais

### 1. "Pó Explosivo" (Partículas Magnéticas)
A mudança mais imediata e dramática, alterando a primitiva de renderização para milhares de pontos luminosos isolados.

*   **A Mecânica WebGL:** Trocar a primitiva no \`drawArrays\` de \`gl.LINE_STRIP\` para \`gl.POINTS\`. 
*   **O Fragment Shader:** Aplicar um gradiente radial \`distance(gl_PointCoord, vec2(0.5))\` para descartar as quinas duras dos pontos, transformando-os em esferas esfumaçadas translúcidas. O \`gl_PointSize\` é ajustado conforme a resolução e proximidade.
*   **A Física:** No silêncio, o array de partículas repousa formando o desenho exato da máscara (ex: Rosto, Nebulosa). Quando o FFT emite o pico de grave, a energia atira as partículas pelas tangentes do mapa. O ruído procedural garante que as partículas se dispersem de forma estocástica (caótica), imitando brasas, areia ou um enxame de nanobots, e então retornem suavemente via decaimento exponencial (gravity).

### 2. "Chama" (Turbulência e Dissolução)
Uma abordagem focada em fluxo contínuo onde o áudio não atua como força mecânica, mas sim como "calor".

*   **A Mecânica WebGL:** O tempo (\`u_time\`) força o deslocamento constante de vértices (ou coordenadas de textura) para cima/fora.
*   **A Física:** Injeta-se uma função de **Curl Noise** 2D ou 3D no Vertex Shader. A energia do áudio (\`v_energy\`) multiplica a magnitude e a velocidade desse ruído. A imagem se contorce, rasga e escorre nas bordas simulando as labaredas de uma chama onde há atividade frequencial alta, mantendo as partes silenciosas apenas com uma distorção de ar quente sutil.

### 3. "Líquido" (Lente de Refração)
O visual mais pesado computacionalmente, focado em interagir com uma textura de background realista em vez de gerar emissão de luz própria.

*   **A Mecânica WebGL:** As posições não são desenhadas como linhas ou pontos, mas como malha sólida usando índices (\`gl.TRIANGLES\`), cobrindo toda a tela.
*   **A Física:** No Fragment Shader, o cálculo da normal derivativa local (usando \`dFdx\` e \`dFdy\` das coordenadas do vértice deslocado pelo áudio) resulta no ângulo exato da onda em relação à tela. Esse ângulo deforma os \`UVs\` que leem a textura da imagem de fundo. O áudio se torna fisicamente gotas, ondas e impactos d'água deformando a percepção da imagem atrás do vidro líquido.

---

## Implementando o "Pó" a partir do V2

Para testar a estética de partículas a partir da malha base `SpectrumBackground_V2.tsx`:

1. No Loop de Render, troque:
\`\`\`javascript
gl.drawArrays(gl.LINE_STRIP, j * curPoints, curPoints);
\`\`\`
Para:
\`\`\`javascript
gl.drawArrays(gl.POINTS, j * curPoints, curPoints);
\`\`\`

2. No Vertex Shader, declare o tamanho do ponto:
\`\`\`glsl
gl_PointSize = 2.0 + (compressed * 4.0); // Pontos crescem quando vibram
\`\`\`

3. No Fragment Shader, esculpa a poeira:
\`\`\`glsl
// Corta as pontas do quadrado para fazer um círculo suave
float dist = distance(gl_PointCoord, vec2(0.5));
if (dist > 0.5) discard;

// Opcional: Fade out nas bordas do círculo
float pointAlpha = smoothstep(0.5, 0.0, dist);
fragColor = vec4(color, alpha * pointAlpha);
\`\`\`
