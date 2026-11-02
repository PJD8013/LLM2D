/**
 * Splitting a flat picture into regions that Claude (or a person) can group into body parts.
 *
 * 1. removeBackground: a solid background connected to the border becomes transparent, with
 *    soft, colour-corrected edges.
 * 2. segmentArt: graph-based segmentation (Felzenszwalb & Huttenlocher 2004) on the colours,
 *    then thin dark regions are classed as outline strokes. Outlines are not offered as regions:
 *    when the picture is split they go to the part in front (see split.ts). Regions are numbered
 *    top to bottom and carry a label point, colour, size and neighbours.
 */
import { dilateDisk, distanceTransform, erodeDisk, growLabels, type RGBAImage } from './image.ts';

export type RGB = [number, number, number];

export interface BackgroundOptions {
  /** 'auto' (default): remove a uniform border colour if there is one; 'none'; or a colour to remove. */
  background?: 'auto' | 'none' | RGB;
  /** Colour distance (0..441) still counted as background. Default 28. */
  tolerance?: number;
  /** Enclosed background-coloured areas at least this fraction of the figure are removed too. Default 0.01. */
  minHole?: number;
}

export interface BackgroundResult {
  image: RGBAImage;
  /** The removed colour, or null if nothing was removed. */
  color: RGB | null;
  note: string;
}

const dist3 = (r1: number, g1: number, b1: number, r2: number, g2: number, b2: number) => Math.hypot(r1 - r2, g1 - g2, b1 - b2);

/**
 * Makes a solid background transparent. Only background connected to the image border is
 * removed (white eye highlights inside an outline stay). Edge pixels get partial alpha and
 * their colour is un-mixed from the background so they do not keep a light fringe.
 */
export function removeBackground(src: RGBAImage, options: BackgroundOptions = {}): BackgroundResult {
  const { width: w, height: h, data } = src;
  const out: RGBAImage = { width: w, height: h, data: data.slice() };
  const mode = options.background ?? 'auto';
  if (mode === 'none') return { image: out, color: null, note: 'background kept' };
  const tol = options.tolerance ?? 28;

  const border: number[] = [];
  for (let x = 0; x < w; x++) border.push(x, (h - 1) * w + x);
  for (let y = 1; y < h - 1; y++) border.push(y * w, y * w + w - 1);
  const transparent = border.filter((i) => data[i * 4 + 3] < 250).length;
  if (mode === 'auto' && transparent > border.length * 0.5) return { image: out, color: null, note: 'already transparent' };

  let bg: RGB;
  if (mode === 'auto') {
    const med = (c: number) => {
      const v = border.map((i) => data[i * 4 + c]).sort((a, b) => a - b);
      return v[v.length >> 1];
    };
    bg = [med(0), med(1), med(2)];
    const near = border.filter((i) => dist3(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], ...bg) <= tol).length;
    if (near < border.length * 0.7) return { image: out, color: null, note: 'no uniform background found; kept as is' };
  } else bg = mode;

  // Flood fill from the border through background-coloured pixels.
  const isBg = new Uint8Array(w * h);
  const close = (i: number) => data[i * 4 + 3] < 8 || dist3(data[i * 4], data[i * 4 + 1], data[i * 4 + 2], ...bg) <= tol;
  const flood = (starts: number[], mark: Uint8Array): number[] => {
    const filled: number[] = [];
    const stack = starts.filter((i) => !mark[i] && close(i));
    for (const i of stack) mark[i] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      filled.push(i);
      const x = i % w;
      const y = (i - x) / w;
      for (const j of [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, y > 0 ? i - w : -1, y < h - 1 ? i + w : -1])
        if (j >= 0 && !mark[j] && close(j)) {
          mark[j] = 1;
          stack.push(j);
        }
    }
    return filled;
  };
  const outer = flood(border, isBg).length;

  // Background enclosed by the figure (e.g. between legs whose feet touch) is removed too when
  // it is big; small enclosed areas (eye highlights) stay. split_art's "remove" handles the rest.
  const minHole = options.minHole ?? 0.01;
  const objPixels = w * h - outer;
  const seen = isBg.slice();
  const holes: { x: number; y: number; area: number }[] = [];
  for (let i = 0; i < w * h; i++) {
    if (seen[i] || !close(i)) continue;
    const filled = flood([i], seen);
    if (filled.length < objPixels * minHole) continue;
    for (const j of filled) isBg[j] = 1;
    holes.push({ x: filled[0] % w, y: Math.floor(filled[0] / w), area: filled.length });
  }

  // Edge band: object pixels within 2 px of the background. Their true colour is taken from the
  // nearest pixel further inside; alpha is how far the pixel sits from the background towards it.
  const obj = new Uint8Array(w * h);
  for (let i = 0; i < obj.length; i++) obj[i] = isBg[i] ? 0 : 1;
  const inside = distanceTransform(obj, w, h);
  const seeds = new Int32Array(w * h).fill(-1);
  const passable = new Uint8Array(w * h);
  for (let i = 0; i < obj.length; i++) {
    if (!obj[i]) continue;
    if (inside[i] > 2.5) seeds[i] = i;
    else passable[i] = 1;
  }
  const nearest = growLabels(seeds, passable, w, h, 6).label;
  const o = out.data;
  for (let i = 0; i < obj.length; i++) {
    const p = i * 4;
    if (isBg[i]) {
      o[p] = o[p + 1] = o[p + 2] = o[p + 3] = 0;
      continue;
    }
    if (inside[i] > 2.5) continue;
    const s = nearest[i];
    if (s < 0) continue;
    const f: RGB = [data[s * 4], data[s * 4 + 1], data[s * 4 + 2]];
    const fx = f[0] - bg[0];
    const fy = f[1] - bg[1];
    const fz = f[2] - bg[2];
    const len2 = fx * fx + fy * fy + fz * fz;
    if (len2 < tol * tol) continue; // object colour too close to the background to un-mix
    const a = Math.max(0, Math.min(1, ((data[p] - bg[0]) * fx + (data[p + 1] - bg[1]) * fy + (data[p + 2] - bg[2]) * fz) / len2));
    if (a >= 0.98) continue;
    o[p + 3] = Math.round(a * (data[p + 3] / 255) * 255);
    if (a < 0.5) {
      o[p] = f[0];
      o[p + 1] = f[1];
      o[p + 2] = f[2];
    } else
      for (let c = 0; c < 3; c++) o[p + c] = Math.max(0, Math.min(255, Math.round((data[p + c] - (1 - a) * bg[c]) / a)));
  }
  const hex = bg.map((v) => v.toString(16).padStart(2, '0')).join('');
  const holeNote = holes.length
    ? `; also removed ${holes.length} enclosed area${holes.length > 1 ? 's' : ''} of that colour (${holes.map((h) => `${h.area} px at ${h.x},${h.y}`).join('; ')})`
    : '';
  return { image: out, color: bg, note: `removed background #${hex}${holeNote}` };
}

export interface SegmentOptions {
  /** More or fewer regions: 2 = finer, 0.5 = coarser. Default 1. */
  detail?: number;
  /** Widest stroke (art pixels) counted as an outline. Default: measured from the picture. */
  maxLineWidth?: number;
  /** Turn off outline detection (every region is offered). */
  lines?: boolean;
  /** 3x3 median before segmenting, against JPEG noise. Default true. */
  denoise?: boolean;
  /** Weight of hue against brightness when comparing colours (1 = equal). Default 0.6. */
  hueWeight?: number;
}

export interface Region {
  id: number;
  area: number;
  box: { x: number; y: number; width: number; height: number };
  /** Mean colour as #rrggbb. */
  color: string;
  /** A point well inside the region (for labels and for "points" in a split spec). */
  point: [number, number];
  /** Region ids next to this one (across outlines too). */
  neighbors: number[];
  /** Contact with each neighbour (same order as `neighbors`): border pixels, counted at 30% across an outline. */
  shared: number[];
  /** Touches the transparent outside. */
  outside: boolean;
}

export interface Segmentation {
  width: number;
  height: number;
  /** Per pixel: region id (1..n), -1 = outline stroke, -2 = soft edge pixel, 0 = transparent. */
  labels: Int32Array;
  /** Per pixel: the nearest region id (outline and soft edge pixels included), 0 = transparent. */
  owner: Int32Array;
  regions: Region[];
  /** Typical outline width in pixels and its colour, or null when no outlines were found. */
  outline: { width: number; color: RGB } | null;
}

/** Splits an image with alpha into numbered colour regions and outline strokes. */
export function segmentArt(img: RGBAImage, options: SegmentOptions = {}): Segmentation {
  const { width: w, height: h, data } = img;
  const n = w * h;
  const solid = new Uint8Array(n);
  let objCount = 0;
  let minX = w;
  let minY = h;
  let maxX = 0;
  let maxY = 0;
  for (let i = 0; i < n; i++)
    if (data[i * 4 + 3] >= 128) {
      solid[i] = 1;
      objCount++;
      const x = i % w;
      const y = (i - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  if (!objCount) throw new Error('The picture is empty (no opaque pixels).');
  const size = Math.max(maxX - minX + 1, maxY - minY + 1);

  // Median filter (removes compression ringing and noise but keeps edges), then a light blur,
  // both over opaque pixels only. Only region shapes use this; colours come from the picture.
  const med = options.denoise === false ? data : medianColors(data, solid, w, h);
  const col = blurColors(med, solid, w, h);

  // ---- Felzenszwalb-Huttenlocher on an 8-connected grid ----
  // Colour difference with hue weighted below brightness: compressed pictures (JPEG) store hue
  // at half resolution, so hue bleeds a few pixels across strong edges while brightness does not.
  const hueWeight = options.hueWeight ?? 0.6;
  const colorDiff = (c: Float32Array, i: number, j: number) => {
    const dr = c[i * 3] - c[j * 3];
    const dg = c[i * 3 + 1] - c[j * 3 + 1];
    const db = c[i * 3 + 2] - c[j * 3 + 2];
    const dy = 0.299 * dr + 0.587 * dg + 0.114 * db;
    const du = (db - dy) * 0.564;
    const dv = (dr - dy) * 0.713;
    // Scaled so that grey steps measure the same as in RGB distance.
    return Math.sqrt(3 * dy * dy + hueWeight * hueWeight * 2 * (du * du + dv * dv));
  };
  const detail = options.detail ?? 1;
  const k = (1.2 * Math.sqrt(objCount)) / detail;
  const minSize = Math.max(12, Math.round(objCount / 6000 / detail));
  const ea = new Uint32Array(objCount * 4);
  const eb = new Uint32Array(objCount * 4);
  const ew = new Uint16Array(objCount * 4);
  let m = 0;
  const addEdge = (i: number, j: number) => {
    if (!solid[j]) return;
    ea[m] = i;
    eb[m] = j;
    ew[m++] = Math.min(2047, Math.round(colorDiff(col, i, j) * 4));
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!solid[i]) continue;
      if (x + 1 < w) addEdge(i, i + 1);
      if (y + 1 < h) {
        addEdge(i, i + w);
        if (x + 1 < w) addEdge(i, i + w + 1);
        if (x > 0) addEdge(i, i + w - 1);
      }
    }
  // Counting sort by weight.
  const counts = new Uint32Array(2049);
  for (let e = 0; e < m; e++) counts[ew[e] + 1]++;
  for (let v = 1; v < counts.length; v++) counts[v] += counts[v - 1];
  const order = new Uint32Array(m);
  for (let e = 0; e < m; e++) order[counts[ew[e]]++] = e;

  const parent = new Int32Array(n);
  const sizes = new Int32Array(n).fill(1);
  const thresh = new Float32Array(n).fill(k);
  for (let i = 0; i < n; i++) parent[i] = i;
  const find = (i: number) => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const join = (a: number, b: number) => {
    if (sizes[a] < sizes[b]) [a, b] = [b, a];
    parent[b] = a;
    sizes[a] += sizes[b];
    return a;
  };
  for (let t = 0; t < m; t++) {
    const e = order[t];
    const a = find(ea[e]);
    const b = find(eb[e]);
    if (a === b) continue;
    const wgt = ew[e] / 4;
    if (wgt <= thresh[a] && wgt <= thresh[b]) {
      const r = join(a, b);
      thresh[r] = wgt + k / sizes[r];
    }
  }
  for (let t = 0; t < m; t++) {
    const e = order[t];
    const a = find(ea[e]);
    const b = find(eb[e]);
    if (a !== b && (sizes[a] < minSize || sizes[b] < minSize)) join(a, b);
  }

  // ---- Component statistics ----
  const comp = new Int32Array(n).fill(0);
  const compOf = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    if (!solid[i]) continue;
    const r = find(i);
    let c = compOf.get(r);
    if (c === undefined) {
      c = compOf.size + 1;
      compOf.set(r, c);
    }
    comp[i] = c;
  }
  const C = compOf.size;
  const area = new Float64Array(C + 1);
  const sum = new Float64Array((C + 1) * 3);
  const perim = new Float64Array(C + 1);
  // Shared border lengths between touching components, for line classification.
  const touch = new Map<number, number>();
  const key = (a: number, b: number) => (a < b ? a * (C + 1) + b : b * (C + 1) + a);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = comp[i];
      if (!c) continue;
      area[c]++;
      sum[c * 3] += data[i * 4];
      sum[c * 3 + 1] += data[i * 4 + 1];
      sum[c * 3 + 2] += data[i * 4 + 2];
      for (const j of [x + 1 < w ? i + 1 : -1, x > 0 ? i - 1 : -1, y + 1 < h ? i + w : -1, y > 0 ? i - w : -1]) {
        const d = j >= 0 ? comp[j] : 0;
        if (d === c) continue;
        perim[c]++;
        if (d > c) touch.set(key(c, d), (touch.get(key(c, d)) ?? 0) + 1);
      }
    }
  const luma = (c: number) => (0.299 * sum[c * 3] + 0.587 * sum[c * 3 + 1] + 0.114 * sum[c * 3 + 2]) / area[c];

  // ---- Outline strokes: thin and darker than what they touch ----
  const isLine = new Uint8Array(C + 1);
  let maxLine = options.maxLineWidth ?? Math.max(3, size * 0.012);
  if (options.lines !== false) {
    const around = new Float64Array(C + 1);
    const aroundW = new Float64Array(C + 1);
    for (const [kk, len] of touch) {
      const a = Math.floor(kk / (C + 1));
      const b = kk % (C + 1);
      around[a] += luma(b) * len;
      aroundW[a] += len;
      around[b] += luma(a) * len;
      aroundW[b] += len;
    }
    // Stroke thickness: 90th percentile of the distance to the component's edge, doubled. Long
    // strokes stay thin everywhere; dark blobs (eyes, a nose) are thick in the middle.
    const core = new Uint8Array(n);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const c = comp[i];
        if (!c) continue;
        if (x > 0 && comp[i - 1] !== c) continue;
        if (x < w - 1 && comp[i + 1] !== c) continue;
        if (y > 0 && comp[i - w] !== c) continue;
        if (y < h - 1 && comp[i + w] !== c) continue;
        core[i] = 1;
      }
    const depth = distanceTransform(core, w, h);
    const BINS = 64;
    const hist = new Uint32Array((C + 1) * BINS);
    for (let i = 0; i < n; i++) if (comp[i]) hist[comp[i] * BINS + Math.min(BINS - 1, Math.round(depth[i]))]++;
    const thick = (c: number) => {
      let acc = 0;
      for (let v = 0; v < BINS; v++) {
        acc += hist[c * BINS + v];
        if (acc >= area[c] * 0.9) return (v + 0.5) * 2;
      }
      return BINS * 2;
    };
    // Candidates: darker than what they touch. The outline network dominates their area, so the
    // area-weighted median thickness is the stroke width; dark blobs (eyes) are much thicker.
    const candidates: number[] = [];
    for (let c = 1; c <= C; c++) {
      const l = luma(c);
      const env = aroundW[c] ? around[c] / aroundW[c] : 255;
      if (l < env * 0.8 && l < 150 && thick(c) <= size * 0.05) candidates.push(c);
    }
    if (options.maxLineWidth === undefined && candidates.length) {
      const sorted = candidates.map((c) => ({ t: thick(c), a: area[c] })).sort((p, q) => p.t - q.t);
      const half = sorted.reduce((sum, x) => sum + x.a, 0) / 2;
      let acc = 0;
      for (const x of sorted) {
        acc += x.a;
        if (acc >= half) {
          maxLine = Math.max(3, x.t * 1.6);
          break;
        }
      }
    }
    for (const c of candidates) {
      const width = area[c] / Math.max(1, perim[c] / 2);
      if (width <= maxLine && thick(c) <= maxLine) isLine[c] = 1;
    }
    // Anti-aliasing bands (a pixel or two wide, between two colours or along an outline) are
    // edges, not regions: when splitting they go to the part in front like outline pixels.
    // JPEG ringing makes halos 3-4 px wide whatever the stroke width.
    const sliver = Math.max(4, maxLine * 0.35);
    for (let c = 1; c <= C; c++)
      if (!isLine[c] && area[c] / Math.max(1, perim[c] / 2) <= sliver && thick(c) <= sliver * 2) isLine[c] = 2;
  }

  // ---- Strokes inside other regions: outline-coloured pixels that are thinner than a stroke ----
  // A dark shape drawn in the outline colour (ear tip, eye) can merge with the outline touching
  // it. Pixels of the outline colour that vanish under an opening of stroke size are strokes.
  const stroke = new Uint8Array(n);
  {
    let lr = 0;
    let lg = 0;
    let lb = 0;
    let ln = 0;
    for (let i = 0; i < n; i++)
      if (comp[i] && isLine[comp[i]] === 1) {
        lr += med[i * 4];
        lg += med[i * 4 + 1];
        lb += med[i * 4 + 2];
        ln++;
      }
    if (ln > objCount * 0.005) {
      const ink: RGB = [lr / ln, lg / ln, lb / ln];
      const dark = new Uint8Array(n);
      for (let i = 0; i < n; i++)
        if (solid[i] && dist3(med[i * 4], med[i * 4 + 1], med[i * 4 + 2], ...ink) <= 32) dark[i] = 1;
      const r = Math.max(2, maxLine / 2);
      const thick = dilateDisk(erodeDisk(dark, w, h, r), w, h, r);
      for (let i = 0; i < n; i++) if (dark[i] && !thick[i]) stroke[i] = 1;
    }
  }

  // ---- Labels: regions keep ids, outlines -1, soft edge pixels -2 ----
  const labels = new Int32Array(n);
  const seeds = new Int32Array(n).fill(-1);
  const passable = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3];
    const c = comp[i];
    if (c && !isLine[c] && !stroke[i]) {
      labels[i] = c;
      seeds[i] = c;
    } else if (c) {
      labels[i] = -1;
      passable[i] = 1;
    } else if (a > 0) {
      labels[i] = -2;
      passable[i] = 1;
    }
  }
  const owner = new Int32Array(n);
  const gap = new Float32Array(n);

  // ---- Merge regions with nearly the same colour that touch directly (gradient bands, slivers) ----
  const keep: number[] = [];
  for (let c = 1; c <= C; c++) if (!isLine[c] && area[c] > 0) keep.push(c);
  const mergeTo = new Int32Array(C + 1);
  for (let c = 0; c <= C; c++) mergeTo[c] = c;
  const root = (c: number) => {
    while (mergeTo[c] !== c) c = mergeTo[c] = mergeTo[mergeTo[c]];
    return c;
  };
  const pairs = [...touch]
    .map(([kk, len]) => ({ a: Math.floor(kk / (C + 1)), b: kk % (C + 1), len }))
    .filter((p) => !isLine[p.a] && !isLine[p.b]);
  const meanOf = (c: number): RGB => [sum[c * 3] / area[c], sum[c * 3 + 1] / area[c], sum[c * 3 + 2] / area[c]];
  for (let pass = 0; pass < 4; pass++) {
    let merged = 0;
    pairs.sort((p, q) => colorGap(p) - colorGap(q));
    for (const p of pairs) {
      const a = root(p.a);
      const b = root(p.b);
      if (a === b) continue;
      const gap = dist3(...meanOf(a), ...meanOf(b));
      // Small slivers merge more easily than big areas.
      const small = Math.min(area[a], area[b]) < objCount * 0.002;
      if (gap > (small ? 40 : 14)) continue;
      const [big, sml] = area[a] >= area[b] ? [a, b] : [b, a];
      mergeTo[sml] = big;
      area[big] += area[sml];
      for (let ch = 0; ch < 3; ch++) sum[big * 3 + ch] += sum[sml * 3 + ch];
      merged++;
    }
    if (!merged) break;
  }
  function colorGap(p: { a: number; b: number }) {
    return dist3(...meanOf(root(p.a)), ...meanOf(root(p.b)));
  }

  for (let i = 0; i < n; i++) if (labels[i] > 0) labels[i] = root(labels[i]);

  // ---- Split regions joined only by thin necks (colour bleeding through a gap in an outline) ----
  {
    const inner = interiorOf(labels, w, h);
    const depth0 = distanceTransform(inner, w, h);
    const coreId = new Int32Array(n);
    const pieces = new Map<number, { id: number; size: number; start: number }[]>();
    let next = 0;
    for (let i = 0; i < n; i++) {
      if (depth0[i] <= 2 || coreId[i]) continue;
      const l = labels[i];
      const id = ++next;
      let size = 0;
      const stack = [i];
      coreId[i] = id;
      while (stack.length) {
        const k = stack.pop()!;
        size++;
        const x = k % w;
        const y = (k - x) / w;
        for (const j of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1])
          if (j >= 0 && !coreId[j] && labels[j] === l && depth0[j] > 2) {
            coreId[j] = id;
            stack.push(j);
          }
      }
      (pieces.get(l) ?? pieces.set(l, []).get(l)!).push({ id, size, start: i });
    }
    const minPiece = Math.max(minSize, objCount * 0.0008);
    let fresh = C;
    for (const [l, list] of pieces) {
      const big = list.filter((p) => p.size >= minPiece);
      if (big.length < 2) continue;
      const newLabel = new Map<number, number>();
      big.forEach((p, k) => newLabel.set(p.id, k === 0 ? l : ++fresh));
      const seeds = new Int32Array(n).fill(-1);
      const pass = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        if (labels[i] !== l) continue;
        const nl = newLabel.get(coreId[i]);
        if (nl !== undefined) seeds[i] = nl;
        else pass[i] = 1;
      }
      const got = growLabels(seeds, pass, w, h).label;
      for (let i = 0; i < n; i++) if (labels[i] === l && got[i] > 0) labels[i] = got[i];
    }
  }

  // Owner map (nearest region for every stroke / edge pixel) and how wide the gap to it is.
  for (let i = 0; i < n; i++) seeds[i] = labels[i] > 0 ? labels[i] : -1;
  const grownFinal = growLabels(seeds, passable, w, h);
  for (let i = 0; i < n; i++) {
    owner[i] = grownFinal.label[i] > 0 ? grownFinal.label[i] : 0;
    gap[i] = grownFinal.dist[i];
  }

  // ---- Final regions: renumber top to bottom, left to right by label point ----
  const interior = interiorOf(labels, w, h);
  const depth = distanceTransform(interior, w, h);
  const best = new Map<number, { d: number; i: number }>();
  const stats = new Map<number, { area: number; r: number; g: number; b: number; x0: number; y0: number; x1: number; y1: number }>();
  for (let i = 0; i < n; i++) {
    const c = labels[i];
    if (c <= 0) continue;
    const x = i % w;
    const y = (i - x) / w;
    const s = stats.get(c) ?? { area: 0, r: 0, g: 0, b: 0, x0: x, y0: y, x1: x, y1: y };
    s.area++;
    s.r += data[i * 4];
    s.g += data[i * 4 + 1];
    s.b += data[i * 4 + 2];
    s.x0 = Math.min(s.x0, x);
    s.y0 = Math.min(s.y0, y);
    s.x1 = Math.max(s.x1, x);
    s.y1 = Math.max(s.y1, y);
    stats.set(c, s);
    const b = best.get(c);
    if (!b || depth[i] > b.d) best.set(c, { d: depth[i], i });
  }
  const ids = [...stats.keys()].sort((a, b) => {
    const pa = best.get(a)!.i;
    const pb = best.get(b)!.i;
    const ya = Math.floor(pa / w);
    const yb = Math.floor(pb / w);
    // Rows of ~3% of the art, then left to right, so neighbouring numbers sit close together.
    const band = Math.max(8, size * 0.03);
    return Math.floor(ya / band) - Math.floor(yb / band) || (pa % w) - (pb % w);
  });
  const newId = new Map<number, number>();
  ids.forEach((c, k) => newId.set(c, k + 1));
  for (let i = 0; i < n; i++) {
    if (labels[i] > 0) labels[i] = newId.get(labels[i])!;
    if (owner[i] > 0) owner[i] = newId.get(owner[i])!;
  }

  // Neighbours across outlines (from the owner map) and contact with the outside.
  const nb = new Map<number, Map<number, number>>();
  const outside = new Set<number>();
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const a = owner[i];
      if (!a) continue;
      for (const j of [x + 1 < w ? i + 1 : -1, y + 1 < h ? i + w : -1, x > 0 ? i - 1 : -1, y > 0 ? i - w : -1]) {
        const b = j >= 0 ? owner[j] : 0;
        if (b === a) continue;
        if (!b) {
          outside.add(a);
          continue;
        }
        // Direct contact (or across a thin anti-aliased edge) counts fully; contact across an
        // outline stroke only weakly, so details join the part they sit in, not the one over the line.
        const m = nb.get(a) ?? nb.set(a, new Map()).get(a)!;
        m.set(b, (m.get(b) ?? 0) + (gap[i] + gap[j] <= 3 ? 1 : 0.3));
      }
    }
  const regions: Region[] = ids.map((c, k) => {
    const s = stats.get(c)!;
    const p = best.get(c)!.i;
    const id = k + 1;
    const hex = [s.r, s.g, s.b].map((v) => Math.round(v / s.area).toString(16).padStart(2, '0')).join('');
    return {
      id,
      area: s.area,
      box: { x: s.x0, y: s.y0, width: s.x1 - s.x0 + 1, height: s.y1 - s.y0 + 1 },
      color: `#${hex}`,
      point: [p % w, Math.floor(p / w)],
      neighbors: [...(nb.get(id)?.keys() ?? [])].sort((a, b) => a - b),
      shared: [...(nb.get(id)?.entries() ?? [])].sort((a, b) => a[0] - b[0]).map(([, len]) => Math.round(len)),
      outside: outside.has(id),
    };
  });

  // Typical outline: width from the distance transform of the stroke pixels (95th percentile of
  // the half-widths), colour from the stroke cores (not their anti-aliased edges).
  let outline: Segmentation['outline'] = null;
  const lineMask = new Uint8Array(n);
  let lineCount = 0;
  const core: RGB = [0, 0, 0];
  let coreCount = 0;
  for (let i = 0; i < n; i++) {
    const c = comp[i];
    if (!c || !((isLine[c] === 1 && labels[i] === -1) || stroke[i])) continue;
    lineMask[i] = 1;
    lineCount++;
    for (let ch = 0; ch < 3; ch++) core[ch] += data[i * 4 + ch];
    coreCount++;
  }
  if (lineCount > objCount * 0.01 && coreCount) {
    const half = distanceTransform(lineMask, w, h);
    const hist = new Uint32Array(256);
    for (let i = 0; i < n; i++) if (lineMask[i]) hist[Math.min(255, Math.round(half[i] * 4))]++;
    let acc = 0;
    let p95 = 0;
    for (let v = 0; v < 256; v++) {
      acc += hist[v];
      if (acc >= lineCount * 0.95) {
        p95 = v / 4;
        break;
      }
    }
    outline = { width: Math.max(1, p95 * 2), color: core.map((v) => Math.round(v / coreCount)) as RGB };
  }

  return { width: w, height: h, labels, owner, regions, outline };
}

/** 3x3 binomial blur of RGB over the masked pixels (Float32 RGB triples). */
function blurColors(data: Uint8Array, mask: Uint8Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h * 3);
  const K = [1, 2, 1];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let r = 0;
      let g = 0;
      let b = 0;
      let wt = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (!mask[j]) continue;
          const k = K[dy + 1] * K[dx + 1];
          r += data[j * 4] * k;
          g += data[j * 4 + 1] * k;
          b += data[j * 4 + 2] * k;
          wt += k;
        }
      }
      out[i * 3] = r / wt;
      out[i * 3 + 1] = g / wt;
      out[i * 3 + 2] = b / wt;
    }
  return out;
}

/** 3x3 per-channel median over the masked pixels (unmasked pixels are left out of each window). */
function medianColors(data: Uint8Array, mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = data.slice();
  const v = new Uint8Array(9);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      for (let c = 0; c < 3; c++) {
        let k = 0;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w || !mask[yy * w + xx]) continue;
            v[k++] = data[(yy * w + xx) * 4 + c];
          }
        }
        // Insertion sort of at most 9 values.
        for (let a = 1; a < k; a++) {
          const t = v[a];
          let b = a - 1;
          while (b >= 0 && v[b] > t) {
            v[b + 1] = v[b];
            b--;
          }
          v[b + 1] = t;
        }
        out[i * 4 + c] = v[k >> 1];
      }
    }
  return out;
}

/** Pixels whose four neighbours carry the same (positive) label. */
function interiorOf(labels: Int32Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const c = labels[i];
      if (c <= 0) continue;
      if (x > 0 && labels[i - 1] !== c) continue;
      if (x < w - 1 && labels[i + 1] !== c) continue;
      if (y > 0 && labels[i - w] !== c) continue;
      if (y < h - 1 && labels[i + w] !== c) continue;
      out[i] = 1;
    }
  return out;
}

/** One line per region: id, colour, size, a point inside it and its neighbours. */
export function regionTable(seg: Segmentation): string {
  return seg.regions
    .map((r) => `  ${String(r.id).padStart(3)}  ${r.color}  ${String(r.area).padStart(7)} px  at ${r.point.join(',')}  next to ${r.neighbors.join(' ') || '-'}`)
    .join('\n');
}
