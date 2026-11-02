import { distToSegment, type Pt } from './geometry.ts';

export interface BoneSegment {
  /** Origin and tip in the same space as the vertices. Zero-length bones are points. */
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface WeightOptions {
  /**
   * How far (in vertex units) a joint blends between bones. A vertex whose distance to bone A
   * is `softness` more than to its nearest bone gets about 37% of the nearest bone's weight
   * from A. Default 0.75 x mesh spacing.
   */
  softness?: number;
  /** Neighbour-averaging passes over the mesh. Default 2. */
  smooth?: number;
  /** Max bones per vertex. Default 4. */
  maxInfluences?: number;
  /**
   * Whether a point (vertex space) is on the art. With it, a bone takes as seeds only vertices
   * it can see in a straight line over the art, so it does not pull on art across a gap (two
   * legs drawn in one layer); the rest it reaches through the mesh.
   */
  inside?: (x: number, y: number) => boolean;
  /** Distance from a vertex not checked by `inside` (outline vertices sit a little outside the art). */
  edge?: number;
}

/**
 * Automatic skin weights. Distances are measured through the mesh (geodesic, via Dijkstra
 * along triangle edges) so a bone does not pull on art that is close in a straight line but
 * far along the shape. Each bone's weight is exp(-(d - dNearest) / softness): it depends on
 * how much farther a bone is than the nearest one, so art far from every bone still follows
 * just its nearest bone, while joints blend smoothly. Weights are then smoothed over the
 * mesh, limited to `maxInfluences` and normalised.
 *
 * Returns per-vertex flat pairs [boneIndex, weight, ...].
 */
export function computeWeights(
  points: Pt[],
  triangles: number[],
  bones: BoneSegment[],
  spacing: number,
  options: WeightOptions = {},
): number[][] {
  const n = points.length;
  const B = bones.length;
  if (B === 1) return points.map(() => [0, 1]);
  const smooth = options.smooth ?? 2;
  const maxInf = options.maxInfluences ?? 4;
  const softness = options.softness ?? spacing * 0.75;

  // Mesh adjacency with edge lengths.
  const adj: Map<number, number>[] = points.map(() => new Map());
  for (let i = 0; i < triangles.length; i += 3)
    for (let k = 0; k < 3; k++) {
      const a = triangles[i + k];
      const b = triangles[i + ((k + 1) % 3)];
      const d = Math.hypot(points[a][0] - points[b][0], points[a][1] - points[b][1]);
      adj[a].set(b, d);
      adj[b].set(a, d);
    }

  const geo = new Float64Array(n * B);
  const sight = options.inside;
  const edge = options.edge ?? 0;
  const step = Math.max(1e-3, spacing / 8);
  /** Whether the straight line from vertex v to the bone point stays on the art. */
  const sees = (v: number, px: number, py: number) => {
    if (!sight) return true;
    const [vx, vy] = points[v];
    const len = Math.hypot(px - vx, py - vy);
    for (let d = edge; d < len; d += step) {
      const f = d / len;
      if (!sight(vx + (px - vx) * f, vy + (py - vy) * f)) return false;
    }
    return true;
  };
  for (let b = 0; b < B; b++) {
    const s = bones[b];
    const near = points.map(([x, y]) => distToSegment(x, y, s.x1, s.y1, s.x2, s.y2));
    const euclid = near.map((e) => e.d);
    // Seeds: vertices close to the bone in a straight line over the art. Everything else is
    // reached through the mesh.
    const minD = Math.min(...euclid);
    const seedR = Math.max(spacing * 1.2, minD + spacing * 0.5);
    const dist = new Float64Array(n).fill(Infinity);
    let seeded = false;
    for (let v = 0; v < n; v++) {
      if (euclid[v] > seedR) continue;
      const t = near[v].t;
      if (!sees(v, s.x1 + (s.x2 - s.x1) * t, s.y1 + (s.y2 - s.y1) * t)) continue;
      dist[v] = euclid[v];
      seeded = true;
    }
    // A bone off the art sees nothing: its nearest vertices, then.
    if (!seeded) for (let v = 0; v < n; v++) if (euclid[v] <= minD + spacing * 0.5) dist[v] = euclid[v];
    dijkstra(dist, adj);
    for (let v = 0; v < n; v++) geo[v * B + b] = Number.isFinite(dist[v]) ? dist[v] : euclid[v] * 4;
  }
  const w = new Float64Array(n * B);
  for (let v = 0; v < n; v++) {
    let nearest = Infinity;
    for (let b = 0; b < B; b++) nearest = Math.min(nearest, geo[v * B + b]);
    for (let b = 0; b < B; b++) w[v * B + b] = Math.exp(-(geo[v * B + b] - nearest) / softness);
  }
  normalise(w, n, B);

  for (let pass = 0; pass < smooth; pass++) {
    const next = new Float64Array(w.length);
    for (let v = 0; v < n; v++) {
      const nb = adj[v];
      for (let b = 0; b < B; b++) {
        let sum = w[v * B + b];
        for (const u of nb.keys()) sum += w[u * B + b];
        next[v * B + b] = sum / (nb.size + 1);
      }
    }
    w.set(next);
    normalise(w, n, B);
  }

  const out: number[][] = [];
  for (let v = 0; v < n; v++) {
    const list: [number, number][] = [];
    for (let b = 0; b < B; b++) list.push([b, w[v * B + b]]);
    list.sort((a, c) => c[1] - a[1]);
    const top = list.slice(0, maxInf).filter(([, x], i) => i === 0 || x >= 0.01);
    const sum = top.reduce((s, [, x]) => s + x, 0);
    const pairs: number[] = [];
    let acc = 0;
    top.forEach(([b, x], i) => {
      // Round to 4 decimals and make the last one absorb the rounding error.
      const r = i === top.length - 1 ? Math.round((1 - acc) * 1e4) / 1e4 : Math.round((x / sum) * 1e4) / 1e4;
      acc += r;
      pairs.push(b, r);
    });
    out.push(pairs);
  }
  return out;
}

function normalise(w: Float64Array, n: number, B: number) {
  for (let v = 0; v < n; v++) {
    let s = 0;
    for (let b = 0; b < B; b++) s += w[v * B + b];
    if (s > 0) for (let b = 0; b < B; b++) w[v * B + b] /= s;
  }
}

function dijkstra(dist: Float64Array, adj: Map<number, number>[]) {
  // Small meshes (hundreds of vertices): a simple O(V^2) scan is fast enough and simple.
  const done = new Uint8Array(dist.length);
  for (;;) {
    let u = -1;
    let best = Infinity;
    for (let i = 0; i < dist.length; i++)
      if (!done[i] && dist[i] < best) {
        best = dist[i];
        u = i;
      }
    if (u < 0) return;
    done[u] = 1;
    for (const [v, d] of adj[u]) if (dist[u] + d < dist[v]) dist[v] = dist[u] + d;
  }
}
