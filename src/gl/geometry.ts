/* ============================================================
   gl/geometry.ts — geometria das cenas, puro e testável.

   Reproduz o que o three montava para a Relevo e a Órbitas, na
   mesma ordem de vértices e de índices, para a aparência não mudar
   na troca de motor.
   ============================================================ */

/**
 * Vértices de um PlaneGeometry(width, height, gx, gy) do three já
 * girado com rotateX(-π/2): plano XZ em y = 0, linha 0 em z = -height/2.
 * Mesma ordem de vértices do three (linha a linha, x crescendo).
 */
export function planeGridXZ(width: number, height: number, gx: number, gy: number): Float32Array {
  const halfW = width / 2, halfH = height / 2;
  const segW = width / gx, segH = height / gy;
  const out = new Float32Array((gx + 1) * (gy + 1) * 3);
  let o = 0;
  for (let iy = 0; iy <= gy; iy++) {
    // three: y = iy*segH - halfH; guarda (x, -y, 0); rotateX(-π/2) leva
    // (x, y', 0) a (x, 0, -y'), ou seja z = iy*segH - halfH.
    const z = iy * segH - halfH;
    for (let ix = 0; ix <= gx; ix++) {
      out[o++] = ix * segW - halfW;
      out[o++] = 0;
      out[o++] = z;
    }
  }
  return out;
}

/**
 * Índices do wireframe que o three desenhava para esse plano: cada
 * triângulo (a,b,d) e (b,c,d) de cada célula vira as arestas
 * a-b, b-c, c-a — diagonal incluída, e aresta interna repetida (uma
 * vez por triângulo que a usa). A repetição importa: com blending
 * alfa, desenhar a mesma linha duas vezes a deixa mais opaca, e é
 * assim que a Relevo sempre apareceu.
 */
export function wireframeIndices(gx: number, gy: number): Uint16Array | Uint32Array {
  const verts = (gx + 1) * (gy + 1);
  const n = gx * gy * 2 * 6;
  const out = verts > 65535 ? new Uint32Array(n) : new Uint16Array(n);
  const row = gx + 1;
  let o = 0;
  const tri = (a: number, b: number, c: number) => {
    out[o++] = a; out[o++] = b;
    out[o++] = b; out[o++] = c;
    out[o++] = c; out[o++] = a;
  };
  for (let iy = 0; iy < gy; iy++) {
    for (let ix = 0; ix < gx; ix++) {
      const a = ix + row * iy;
      const b = ix + row * (iy + 1);
      const c = ix + 1 + row * (iy + 1);
      const d = ix + 1 + row * iy;
      tri(a, b, d);
      tri(b, c, d);
    }
  }
  return out;
}

/** Círculo unitário no plano XY como line strip fechado: seg+1 pontos
    (o último repete o primeiro). */
export function circleStrip(seg: number): Float32Array {
  const out = new Float32Array((seg + 1) * 3);
  for (let i = 0; i <= seg; i++) {
    const a = (i / seg) * Math.PI * 2;
    out[i * 3] = Math.cos(a);
    out[i * 3 + 1] = Math.sin(a);
    out[i * 3 + 2] = 0;
  }
  return out;
}
