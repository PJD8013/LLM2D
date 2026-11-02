import Constrainautor from '@kninnug/constrainautor';
import Delaunator from 'delaunator';
import { components, traceBoundary } from './contour.ts';
import {
  distToPolygon,
  pointInPolygon,
  signedArea,
  simplifyClosed,
  subdivideClosed,
  type Pt,
} from './geometry.ts';
import { alphaMask, dilate, distanceTransform, type RGBAImage } from './image.ts';

export interface MeshOptions {
  /** Target distance between vertices, in image pixels. Default: from the part's thickness. */
  spacing?: number;
  /** Outline simplification tolerance in pixels. Default 2. */
  tolerance?: number;
  /** Pixels added around the art so antialiased edges are not cut. Default 3. */
  margin?: number;
  /** Alpha threshold 0..255. Default 8. */
  threshold?: number;
}

export interface MeshResult {
  /** Image-local pixel coordinates, outline points first. */
  points: Pt[];
  triangles: number[];
  /** Number of outline points at the start of `points` (all pieces). */
  hull: number;
  spacing: number;
  /** One outline polygon per separate piece of the art, largest first (image pixels). */
  outlines: Pt[][];
  warnings: string[];
}

/** Thickness of the art: twice the largest inscribed radius, in pixels. */
export function thickness(img: RGBAImage, threshold = 8): number {
  const dt = distanceTransform(alphaMask(img, threshold), img.width, img.height);
  let max = 0;
  for (const v of dt) if (v > max) max = v;
  return max * 2;
}

/**
 * Builds a triangle mesh covering the opaque area of an image: traced outline, interior
 * points on a staggered grid, optional extra points (e.g. along bones), constrained
 * Delaunay triangulation clipped to the outline.
 */
export function buildMesh(img: RGBAImage, options: MeshOptions = {}, extra: Pt[] = []): MeshResult {
  const warnings: string[] = [];
  const { width: w, height: h } = img;
  const threshold = options.threshold ?? 8;
  const margin = options.margin ?? 3;
  const spacing = options.spacing ?? Math.min(64, Math.max(16, thickness(img, threshold) / 3));
  const tolerance = options.tolerance ?? 2;

  const mask = dilate(alphaMask(img, threshold), w, h, margin);
  const { labels, list } = components(mask, w, h);
  if (!list.length) throw new Error('the layer has no visible pixels');
  // Every piece gets its own outline, so a detached dot or a second strand stays in the mesh
  // (and pieces are not joined across the gap between them).
  const loops: Pt[][] = [];
  let lost = 0;
  for (const c of list) {
    const raw = traceBoundary(labels, w, h, c);
    let loop = simplifyClosed(raw, tolerance);
    if (loop.length < 3) loop = raw;
    if (loop.length < 3 || Math.abs(signedArea(loop)) < 1) {
      lost += c.size;
      continue;
    }
    if (signedArea(loop) < 0) loop.reverse();
    // Keep UVs inside the image.
    loops.push(subdivideClosed(loop, spacing).map(([x, y]) => [Math.min(w, Math.max(0, x)), Math.min(h, Math.max(0, y))] as Pt));
  }
  if (!loops.length) throw new Error('the layer has no visible pixels');
  if (lost) warnings.push(`${lost} px of specks too small for the mesh were left out`);
  const inside = (x: number, y: number) => loops.some((l) => pointInPolygon(x, y, l));
  const edgeDist = (x: number, y: number) => Math.min(...loops.map((l) => distToPolygon(x, y, l)));

  const points: Pt[] = loops.flat().map((p) => [p[0], p[1]]);
  const hull = points.length;
  const minGap = spacing * 0.45;
  const farFromAll = (x: number, y: number) => points.every((p) => (p[0] - x) ** 2 + (p[1] - y) ** 2 >= minGap * minGap);
  const tryAdd = (x: number, y: number, edgeGap: number) => {
    if (x < 0 || y < 0 || x > w || y > h) return;
    if (!inside(x, y)) return;
    if (edgeDist(x, y) < edgeGap) return;
    if (!farFromAll(x, y)) return;
    points.push([x, y]);
  };
  // Extra points first so they win over grid points (they matter for bending).
  for (const [x, y] of extra) tryAdd(x, y, spacing * 0.3);
  const rowH = (spacing * Math.sqrt(3)) / 2;
  for (let row = 0, y = rowH / 2; y < h; row++, y += rowH)
    for (let x = (row % 2 ? spacing / 2 : 0) + spacing / 2; x < w; x += spacing) tryAdd(x, y, spacing * 0.5);

  const del = Delaunator.from(points);
  const edges: [number, number][] = [];
  let offset = 0;
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) edges.push([offset + i, offset + ((i + 1) % loop.length)]);
    offset += loop.length;
  }
  try {
    new Constrainautor(del, edges);
  } catch (e) {
    warnings.push(`outline constraint failed (${(e as Error).message}); triangles were clipped by centroid only`);
  }
  const triangles: number[] = [];
  const t = del.triangles;
  for (let i = 0; i < t.length; i += 3) {
    const [a, b, c] = [t[i], t[i + 1], t[i + 2]];
    const cx = (points[a][0] + points[b][0] + points[c][0]) / 3;
    const cy = (points[a][1] + points[b][1] + points[c][1]) / 3;
    if (!inside(cx, cy)) continue;
    const area = (points[b][0] - points[a][0]) * (points[c][1] - points[a][1]) - (points[c][0] - points[a][0]) * (points[b][1] - points[a][1]);
    if (Math.abs(area) < 1e-6) continue;
    triangles.push(a, b, c);
  }

  // Drop unused points (keeping hull order) and reindex.
  const used = new Uint8Array(points.length);
  for (const i of triangles) used[i] = 1;
  for (let i = 0; i < hull; i++) used[i] = 1;
  const remap = new Int32Array(points.length).fill(-1);
  const kept: Pt[] = [];
  points.forEach((p, i) => {
    if (used[i]) {
      remap[i] = kept.length;
      kept.push(p);
    }
  });
  return {
    points: kept,
    triangles: triangles.map((i) => remap[i]),
    hull,
    spacing,
    outlines: loops,
    warnings,
  };
}
