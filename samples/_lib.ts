/**
 * Small authoring helpers used by the sample generators. They let a rig be described in
 * world (canvas) coordinates, the way an artist or an LLM thinks about it, and convert to
 * the file's parent-local bone transforms.
 */
import type { L2DMeshAttachment } from '../packages/core/src/index.ts';

export interface ArtPart {
  /** Logical size in skeleton units. */
  w: number;
  h: number;
  /** SVG markup drawn in a 0..w, 0..h box. */
  svg: string;
}

export { bonesFromWorld, round, type WorldBone } from '../packages/rig/src/bones.ts';
import { round } from '../packages/rig/src/bones.ts';

/**
 * A strip mesh covering an image placed at (cx, cy) with size w x h, split into `rows`
 * horizontal bands (for things that bend along their height, like antennae or tails).
 * Vertices are ordered as a hull loop: down the left edge, then up the right edge.
 */
export function stripMesh(
  image: string,
  cx: number,
  cy: number,
  w: number,
  h: number,
  rows: number,
): Pick<L2DMeshAttachment, 'type' | 'image' | 'vertices' | 'uvs' | 'triangles' | 'hull'> {
  const vertices: number[] = [];
  const uvs: number[] = [];
  const left: number[] = [];
  const right: number[] = [];
  for (let r = 0; r <= rows; r++) {
    left.push(vertices.length / 2);
    vertices.push(round(cx - w / 2), round(cy - h / 2 + (h * r) / rows));
    uvs.push(0, round(r / rows, 5));
  }
  for (let r = rows; r >= 0; r--) {
    right[r] = vertices.length / 2;
    vertices.push(round(cx + w / 2), round(cy - h / 2 + (h * r) / rows));
    uvs.push(1, round(r / rows, 5));
  }
  const triangles: number[] = [];
  for (let r = 0; r < rows; r++) {
    triangles.push(left[r], left[r + 1], right[r]);
    triangles.push(right[r], left[r + 1], right[r + 1]);
  }
  return { type: 'mesh', image, vertices, uvs, triangles, hull: vertices.length / 2 };
}

/**
 * Inverse-distance weights to bone segments (origin -> tip), keeping the two closest bones.
 * A simple stand-in for the automatic weighting that phase 2 will add.
 */
export function segmentWeights(vertices: number[], bones: { x1: number; y1: number; x2: number; y2: number }[]): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < vertices.length; i += 2) {
    const px = vertices[i];
    const py = vertices[i + 1];
    const scored = bones.map((b, index) => {
      const dx = b.x2 - b.x1;
      const dy = b.y2 - b.y1;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((px - b.x1) * dx + (py - b.y1) * dy) / len2));
      const d = Math.hypot(px - (b.x1 + dx * t), py - (b.y1 + dy * t));
      return { index, w: 1 / Math.pow(d + 1, 2) };
    });
    scored.sort((a, b) => b.w - a.w);
    const top = scored.slice(0, 2);
    const sum = top.reduce((s, x) => s + x.w, 0);
    const pairs: number[] = [];
    for (const t of top) {
      const w = round(t.w / sum, 4);
      if (w >= 0.01) pairs.push(t.index, w);
    }
    // Renormalise after rounding/pruning.
    let total = 0;
    for (let k = 1; k < pairs.length; k += 2) total += pairs[k];
    for (let k = 1; k < pairs.length; k += 2) pairs[k] = round(pairs[k] / total, 4);
    out.push(pairs);
  }
  return out;
}
