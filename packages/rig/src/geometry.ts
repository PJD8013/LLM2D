export type Pt = [number, number];

export function signedArea(poly: Pt[]): number {
  let a = 0;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += poly[j][0] * poly[i][1] - poly[i][0] * poly[j][1];
  return a / 2;
}

export function pointInPolygon(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** Distance from p to segment ab, plus the closest point's parameter t in 0..1. */
export function distToSegment(px: number, py: number, ax: number, ay: number, bx: number, by: number): { d: number; t: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 > 0 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2)) : 0;
  return { d: Math.hypot(px - (ax + dx * t), py - (ay + dy * t)), t };
}

export function distToPolygon(x: number, y: number, poly: Pt[]): number {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++)
    best = Math.min(best, distToSegment(x, y, poly[j][0], poly[j][1], poly[i][0], poly[i][1]).d);
  return best;
}

/** Douglas-Peucker simplification of a closed polygon. */
export function simplifyClosed(poly: Pt[], tolerance: number): Pt[] {
  if (poly.length < 4) return poly.slice();
  // Split at the vertex farthest from the first one so both halves are open polylines.
  let far = 0;
  let farD = -1;
  for (let i = 1; i < poly.length; i++) {
    const d = Math.hypot(poly[i][0] - poly[0][0], poly[i][1] - poly[0][1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const a = simplifyOpen(poly.slice(0, far + 1), tolerance);
  const b = simplifyOpen([...poly.slice(far), poly[0]], tolerance);
  return [...a.slice(0, -1), ...b.slice(0, -1)];
}

function simplifyOpen(pts: Pt[], tolerance: number): Pt[] {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack: [number, number][] = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop()!;
    let idx = -1;
    let maxD = tolerance;
    for (let i = s + 1; i < e; i++) {
      const d = distToSegment(pts[i][0], pts[i][1], pts[s][0], pts[s][1], pts[e][0], pts[e][1]).d;
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (idx >= 0) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return pts.filter((_, i) => keep[i]);
}

/** Splits polygon edges longer than maxEdge into equal parts. */
export function subdivideClosed(poly: Pt[], maxEdge: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / maxEdge));
    for (let k = 0; k < n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
  }
  return out;
}

/** Resamples a polyline to `count + 1` points evenly spaced by arc length. */
export function resamplePolyline(pts: Pt[], count: number): Pt[] {
  const len: number[] = [0];
  for (let i = 1; i < pts.length; i++) len.push(len[i - 1] + Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]));
  const total = len[len.length - 1];
  const out: Pt[] = [];
  let j = 0;
  for (let k = 0; k <= count; k++) {
    const target = (total * k) / count;
    while (j < pts.length - 2 && len[j + 1] < target) j++;
    const seg = len[j + 1] - len[j] || 1;
    const t = Math.min(1, Math.max(0, (target - len[j]) / seg));
    out.push([pts[j][0] + (pts[j + 1][0] - pts[j][0]) * t, pts[j][1] + (pts[j + 1][1] - pts[j][1]) * t]);
  }
  return out;
}
