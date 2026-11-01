import { resamplePolyline, type Pt } from './geometry.ts';
import { alphaMask, distanceTransform, type RGBAImage } from './image.ts';
import { components } from './contour.ts';

/** Zhang-Suen thinning. Returns a 1-pixel-wide skeleton of the mask. */
export function thin(mask: Uint8Array, w: number, h: number): Uint8Array {
  const m = mask.slice();
  const del: number[] = [];
  const at = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : m[y * w + x]);
  let changed = true;
  while (changed) {
    changed = false;
    for (let step = 0; step < 2; step++) {
      del.length = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          if (!m[y * w + x]) continue;
          const p2 = at(x, y - 1);
          const p3 = at(x + 1, y - 1);
          const p4 = at(x + 1, y);
          const p5 = at(x + 1, y + 1);
          const p6 = at(x, y + 1);
          const p7 = at(x - 1, y + 1);
          const p8 = at(x - 1, y);
          const p9 = at(x - 1, y - 1);
          const b = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (b < 2 || b > 6) continue;
          const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
          let a = 0;
          for (let i = 0; i < 8; i++) if (!seq[i] && seq[i + 1]) a++;
          if (a !== 1) continue;
          if (step === 0 ? p2 * p4 * p6 || p4 * p6 * p8 : p2 * p4 * p8 || p2 * p6 * p8) continue;
          del.push(y * w + x);
        }
      for (const i of del) m[i] = 0;
      if (del.length) changed = true;
    }
  }
  return m;
}

/**
 * Places a chain of joints along the middle of a shape (its medial axis), for tails, hair,
 * ears and scarves. `start` is where the chain is rooted (e.g. where a tail meets the body);
 * `end` optionally picks which branch to follow, otherwise the farthest point is used.
 * Returns count + 1 points (joints, then the tip), in image pixels.
 */
export function chainJoints(img: RGBAImage, count: number, start: Pt, end?: Pt, threshold = 8): Pt[] {
  const { width: w, height: h } = img;
  const mask = alphaMask(img, threshold);
  // Keep the largest piece only.
  const { labels, list } = components(mask, w, h);
  if (!list.length) throw new Error('Image is empty');
  for (let i = 0; i < mask.length; i++) mask[i] = labels[i] === list[0].label ? 1 : 0;
  const dt = distanceTransform(mask, w, h);
  const skel = thin(mask, w, h);

  const nodes: number[] = [];
  for (let i = 0; i < skel.length; i++) if (skel[i]) nodes.push(i);
  if (!nodes.length) throw new Error('Could not find the middle line of the shape');
  const nearest = (p: Pt) => {
    let best = nodes[0];
    let bd = Infinity;
    for (const i of nodes) {
      const d = (i % w - p[0]) ** 2 + (Math.floor(i / w) - p[1]) ** 2;
      if (d < bd) {
        bd = d;
        best = i;
      }
    }
    return best;
  };

  // Dijkstra over skeleton pixels (8-connected, Euclidean steps).
  const src = nearest(start);
  const dist = new Float64Array(w * h).fill(Infinity);
  const prev = new Int32Array(w * h).fill(-1);
  dist[src] = 0;
  const heap: [number, number][] = [[0, src]];
  const push = (d: number, i: number) => {
    heap.push([d, i]);
    let c = heap.length - 1;
    while (c > 0) {
      const p = (c - 1) >> 1;
      if (heap[p][0] <= heap[c][0]) break;
      [heap[p], heap[c]] = [heap[c], heap[p]];
      c = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let c = 0;
      for (;;) {
        const l = c * 2 + 1;
        const r = l + 1;
        let m = c;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === c) break;
        [heap[m], heap[c]] = [heap[c], heap[m]];
        c = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const n = ny * w + nx;
        if (!skel[n]) continue;
        const nd = d + (dx && dy ? Math.SQRT2 : 1);
        if (nd < dist[n]) {
          dist[n] = nd;
          prev[n] = i;
          push(nd, n);
        }
      }
  }

  let target = -1;
  if (end) target = nearest(end);
  else {
    let far = -1;
    for (const i of nodes)
      if (dist[i] < Infinity && dist[i] > far) {
        far = dist[i];
        target = i;
      }
  }
  if (target < 0 || dist[target] === Infinity) throw new Error('Start and end are not connected through the shape');

  const path: Pt[] = [];
  for (let i = target; i >= 0; i = prev[i]) path.push([i % w, Math.floor(i / w)]);
  path.reverse();
  // Root the chain exactly at `start`; end exactly at `end`, or extend to the edge of the shape.
  path.unshift([start[0], start[1]]);
  if (end) {
    path.push([end[0], end[1]]);
    return resamplePolyline(path, count);
  }
  const tip = path[path.length - 1];
  const back = path[Math.max(0, path.length - 1 - 8)];
  const dx = tip[0] - back[0];
  const dy = tip[1] - back[1];
  const l = Math.hypot(dx, dy) || 1;
  const r = dt[target];
  path.push([tip[0] + (dx / l) * r, tip[1] + (dy / l) * r]);
  return resamplePolyline(path, count);
}
