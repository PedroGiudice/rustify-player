/* ============================================================
   gl/mat4.ts — o mínimo de matriz 4x4 que as câmeras precisam.

   Coluna-maior (o layout que gl.uniformMatrix4fv espera com
   transpose=false), mesmas convenções do three: câmera olhando
   para -z, projeção OpenGL com z de clip em [-1, 1]. As funções
   escrevem em `out` e devolvem `out` — nada aloca por quadro.
   ============================================================ */

export type Mat4 = Float32Array;
export type V3 = readonly [number, number, number] | Float32Array;

export function mat4(): Mat4 {
  const m = new Float32Array(16);
  m[0] = m[5] = m[10] = m[15] = 1;
  return m;
}

/** Projeção perspectiva. `fovyDeg` é o campo vertical em GRAUS, como no
    PerspectiveCamera do three. */
export function perspective(out: Mat4, fovyDeg: number, aspect: number, near: number, far: number): Mat4 {
  const f = 1 / Math.tan((fovyDeg * Math.PI) / 360);
  const nf = 1 / (near - far);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) * nf;
  out[11] = -1;
  out[14] = 2 * far * near * nf;
  return out;
}

const UP: V3 = [0, 1, 0];

/** Matriz de VISTA de uma câmera em `eye` olhando para `target`
    (o inverso do Object3D.lookAt do three aplicado à câmera). */
export function lookAt(out: Mat4, eye: V3, target: V3, up: V3 = UP): Mat4 {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2];
  let len = Math.hypot(zx, zy, zz);
  if (len === 0) { zz = 1; len = 1; }
  zx /= len; zy /= len; zz /= len;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz);
  if (len === 0) {
    // up paralelo à direção: desvia z um fio, como o three faz.
    if (Math.abs(up[2]) === 1) zx += 0.0001;
    else zz += 0.0001;
    const zl = Math.hypot(zx, zy, zz);
    zx /= zl; zy /= zl; zz /= zl;
    xx = up[1] * zz - up[2] * zy;
    xy = up[2] * zx - up[0] * zz;
    xz = up[0] * zy - up[1] * zx;
    len = Math.hypot(xx, xy, xz) || 1;
  }
  xx /= len; xy /= len; xz /= len;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

/** Vista de uma câmera SEM rotação em `eye` (translação por -eye). */
export function translation(out: Mat4, x: number, y: number, z: number): Mat4 {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  out[12] = x;
  out[13] = y;
  out[14] = z;
  return out;
}

/** out = a * b (pode ser o mesmo array que a ou b). */
export function multiply(out: Mat4, a: Mat4, b: Mat4): Mat4 {
  const r = new Array<number>(16);
  for (let c = 0; c < 4; c++) {
    for (let rI = 0; rI < 4; rI++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + rI] * b[c * 4 + k];
      r[c * 4 + rI] = s;
    }
  }
  for (let i = 0; i < 16; i++) out[i] = r[i];
  return out;
}

/** Aplica a matriz a um ponto (w = 1) e devolve [x, y, z, w]. */
export function transformPoint(m: Mat4, p: V3): [number, number, number, number] {
  const x = p[0], y = p[1], z = p[2];
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}
