import Constrainautor from '@kninnug/constrainautor';
import Delaunator from 'delaunator';
import { components, traceBoundary } from './contour.ts';
import {
  convexHull,
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
  /** Image-local pixel coordinates, hull first. */
  points: Pt[];
  triangles: number[];
  hull: number;
  spacing: number;
  /** Outline polygon used (image pixels). */
  outline: Pt[];
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
  if (!list.length) throw new Error('Image is empty');
  const total = list.reduce((s, c) => s + c.size, 0);
  let outline: Pt[];
  if (list.length > 1 && list.slice(1).some((c) => c.size > total * 0.02)) {
    warnings.push(`art has ${list.length} separate pieces; using their convex hull as the mesh outline`);
    const pts: Pt[] = [];
    for (let i = 0; i < mask.length; i++) if (mask[i]) pts.push([i % w, Math.floor(i / w)]);
    outline = convexHull(pts);
  } else {
    outline = traceBoundary(labels, w, h, list[0]);
  }
  outline = simplifyClosed(outline, tolerance);
  if (signedArea(outline) < 0) outline.reverse();
  outline = subdivideClosed(outline, spacing);
  // Keep UVs inside the image.
  outline = outline.map(([x, y]) => [Math.min(w, Math.max(0, x)), Math.min(h, Math.max(0, y))]);

  const points: Pt[] = outline.map((p) => [p[0], p[1]]);
  const hull = points.length;
  const minGap = spacing * 0.45;
  const farFromAll = (x: number, y: number) => points.every((p) => (p[0] - x) ** 2 + (p[1] - y) ** 2 >= minGap * minGap);
  const tryAdd = (x: number, y: number, edgeGap: number) => {
    if (x < 0 || y < 0 || x > w || y > h) return;
    if (!pointInPolygon(x, y, outline)) return;
    if (distToPolygon(x, y, outline) < edgeGap) return;
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
  for (let i = 0; i < hull; i++) edges.push([i, (i + 1) % hull]);
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
    if (!pointInPolygon(cx, cy, outline)) continue;
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
    outline,
    warnings,
  };
}
