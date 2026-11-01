import type { Pt } from './geometry.ts';

export interface Component {
  /** Pixel count. */
  size: number;
  /** Label value in the label map. */
  label: number;
  /** Topmost-leftmost pixel index, used to start contour tracing. */
  start: number;
}

/** 8-connected component labelling. Returns labels (0 = background) and components by size. */
export function components(mask: Uint8Array, w: number, h: number): { labels: Int32Array; list: Component[] } {
  const labels = new Int32Array(w * h);
  const list: Component[] = [];
  const stack: number[] = [];
  let next = 1;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i] || labels[i]) continue;
    const label = next++;
    let size = 0;
    labels[i] = label;
    stack.push(i);
    while (stack.length) {
      const p = stack.pop()!;
      size++;
      const x = p % w;
      const y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
          const n = ny * w + nx;
          if (mask[n] && !labels[n]) {
            labels[n] = label;
            stack.push(n);
          }
        }
    }
    list.push({ size, label, start: i });
  }
  list.sort((a, b) => b.size - a.size);
  return { labels, list };
}

// Clockwise on screen (y down): E, SE, S, SW, W, NW, N, NE.
const DX = [1, 1, 0, -1, -1, -1, 0, 1];
const DY = [0, 1, 1, 1, 0, -1, -1, -1];

/**
 * Moore-neighbour tracing of the outer boundary of one labelled component. Returns pixel
 * centres in order (clockwise on screen).
 */
export function traceBoundary(labels: Int32Array, w: number, h: number, comp: Component): Pt[] {
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && labels[y * w + x] === comp.label;
  const sx = comp.start % w;
  const sy = (comp.start - sx) / w;
  const out: Pt[] = [[sx, sy]];
  let cx = sx;
  let cy = sy;
  // The pixel to the west of the raster-first pixel is background.
  let back = 4;
  let first: [number, number] | null = null;
  for (let guard = 0; guard < w * h * 4; guard++) {
    let found = -1;
    for (let k = 1; k <= 8; k++) {
      const d = (back + k) % 8;
      if (inside(cx + DX[d], cy + DY[d])) {
        found = d;
        break;
      }
    }
    if (found < 0) return out; // isolated pixel
    const nx = cx + DX[found];
    const ny = cy + DY[found];
    // New backtrack: the background neighbour checked just before `found`, seen from the new pixel.
    const pd = (found + 7) % 8;
    const bx = cx + DX[pd] - nx;
    const by = cy + DY[pd] - ny;
    back = dirIndex(bx, by);
    if (cx === sx && cy === sy) {
      if (first && first[0] === nx && first[1] === ny) break;
      if (!first) first = [nx, ny];
    }
    cx = nx;
    cy = ny;
    if (cx === sx && cy === sy) continue;
    out.push([cx, cy]);
  }
  return out;
}

function dirIndex(dx: number, dy: number): number {
  for (let i = 0; i < 8; i++) if (DX[i] === dx && DY[i] === dy) return i;
  return 4;
}
