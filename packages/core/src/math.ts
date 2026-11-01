/**
 * 2D affine matrix stored as [a, b, c, d, tx, ty]:
 *   x' = a * x + c * y + tx
 *   y' = b * x + d * y + ty
 * Same layout as PixiJS Matrix.
 */
export type Mat2D = Float64Array;

export const DEG = Math.PI / 180;

export function mat(): Mat2D {
  const m = new Float64Array(6);
  m[0] = 1;
  m[3] = 1;
  return m;
}

export function setIdentity(out: Mat2D): Mat2D {
  out[0] = 1;
  out[1] = 0;
  out[2] = 0;
  out[3] = 1;
  out[4] = 0;
  out[5] = 0;
  return out;
}

/** out = translate(x, y) * rotate(deg) * scale(sx, sy) */
export function compose(out: Mat2D, x: number, y: number, deg: number, sx: number, sy: number): Mat2D {
  const r = deg * DEG;
  const cos = Math.cos(r);
  const sin = Math.sin(r);
  out[0] = cos * sx;
  out[1] = sin * sx;
  out[2] = -sin * sy;
  out[3] = cos * sy;
  out[4] = x;
  out[5] = y;
  return out;
}

/** out = p * q (apply q first, then p). `out` may alias p or q. */
export function multiply(out: Mat2D, p: Mat2D, q: Mat2D): Mat2D {
  const a = p[0] * q[0] + p[2] * q[1];
  const b = p[1] * q[0] + p[3] * q[1];
  const c = p[0] * q[2] + p[2] * q[3];
  const d = p[1] * q[2] + p[3] * q[3];
  const tx = p[0] * q[4] + p[2] * q[5] + p[4];
  const ty = p[1] * q[4] + p[3] * q[5] + p[5];
  out[0] = a;
  out[1] = b;
  out[2] = c;
  out[3] = d;
  out[4] = tx;
  out[5] = ty;
  return out;
}

export function invert(out: Mat2D, m: Mat2D): Mat2D {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return setIdentity(out);
  const inv = 1 / det;
  const a = m[3] * inv;
  const b = -m[1] * inv;
  const c = -m[2] * inv;
  const d = m[0] * inv;
  const tx = -(a * m[4] + c * m[5]);
  const ty = -(b * m[4] + d * m[5]);
  out[0] = a;
  out[1] = b;
  out[2] = c;
  out[3] = d;
  out[4] = tx;
  out[5] = ty;
  return out;
}

export function copy(out: Mat2D, m: Mat2D): Mat2D {
  out.set(m);
  return out;
}

export function applyX(m: Mat2D, x: number, y: number): number {
  return m[0] * x + m[2] * y + m[4];
}

export function applyY(m: Mat2D, x: number, y: number): number {
  return m[1] * x + m[3] * y + m[5];
}

/** World rotation of the matrix x axis, in degrees. */
export function matRotation(m: Mat2D): number {
  return Math.atan2(m[1], m[0]) / DEG;
}

/** Wrap an angle in degrees to (-180, 180]. */
export function wrapDeg(deg: number): number {
  deg %= 360;
  if (deg > 180) deg -= 360;
  else if (deg <= -180) deg += 360;
  return deg;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Interpolate angles along the shortest arc. */
export function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapDeg(b - a) * t;
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
