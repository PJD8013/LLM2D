/**
 * Turns a flat picture into layered art (one layer per body part) using a segmentation:
 *
 * - Parts are listed back to front and pick regions by id or by a point inside them, or take
 *   everything inside a polygon. Small regions enclosed by one part (buttons, highlights, stripes)
 *   join it automatically.
 * - Outline strokes go to the part in front: where an arm's outline lies over the body, the arm
 *   keeps the whole stroke, with its round caps and its anti-aliased fringe. Parts without an
 *   outline of their own (a shine, a glow) take none. Remaining stroke pixels continue the
 *   stroke they touch, or join the nearest part.
 * - Hidden areas are rebuilt: wherever a part is covered by parts in front of it, it is extended
 *   underneath (its shape closed with a disk of radius `fill`, plus an `overlap` band at the
 *   edges it shares with them, plus any hole that front parts cover completely) and painted
 *   with its nearest own colours, with the outline continued along the new edge. So when a
 *   front part moves, there is something behind it. See-through parts (glows, shadows) are
 *   continued with their own faintness and no outline.
 *
 * Stacking the layers back gives the input picture exactly (checked: report.difference).
 */
import { alphaBounds, closeDisk, createImage, dilateDisk, distanceTransform, erodeDisk, growLabels, trimLayer, type Layer, type RGBAImage } from './image.ts';
import type { LayeredArt } from './psd.ts';
import { removeBackground, segmentArt, type Segmentation } from './segment.ts';

/** A region id, or an [x, y] art pixel inside the region. */
export type RegionRef = number | [number, number];

export interface SplitPart {
  /** Layer name (letters, digits, _ and -). */
  name: string;
  regions?: RegionRef[];
  /** Everything inside this polygon (art pixels) belongs to the part, over any region choice. */
  polygon?: [number, number][];
  /**
   * Everything inside this polygon except the colour around it (the regions forming most of the
   * polygon's edge): for features drawn on top of a surface, such as a mouth, eyebrows or whiskers.
   */
  strokes?: [number, number][];
  /** Takes every region no other part lists. */
  rest?: boolean;
  /** Rebuild radius under parts in front (px). Default from the spec. 0 turns it off. */
  fill?: number;
  /** How far the part reaches under parts in front along shared edges (px). */
  overlap?: number;
}

export interface SplitSpec {
  /** Back to front (like PSD layers bottom to top). */
  parts: SplitPart[];
  /** Regions to delete (e.g. background left inside the figure). */
  remove?: RegionRef[];
  /** Default rebuild radius in px. Default: 10% of the figure's size. */
  fill?: number;
  /** Default overlap in px. Default: a little more than the outline width (at least 1% of the figure). */
  overlap?: number;
  /** Continue outlines along rebuilt edges. Default: when the art has outlines. */
  outline?: boolean;
}

export interface SplitPartReport {
  name: string;
  /** Visible pixels taken from the picture. */
  pixels: number;
  /** Pixels rebuilt underneath parts in front. */
  filled: number;
  box: { x: number; y: number; width: number; height: number } | null;
  regions: number[];
  /** Regions that joined because this part surrounds them. */
  auto: number[];
}

export interface SplitReport {
  parts: SplitPartReport[];
  removed: number[];
  warnings: string[];
  /** Largest channel difference between the stacked layers and the input (0 = lossless). */
  difference: number;
  fill: number;
  overlap: number;
}

export interface SplitResult {
  art: LayeredArt;
  report: SplitReport;
  /** Per pixel: index of the part it was given to, -1 = transparent/removed. */
  owner: Int16Array;
  /** Per part: 1 where pixels were rebuilt. */
  fills: Uint8Array[];
}

const NAME = /^[A-Za-z0-9_-]+$/;

/** Splits `img` (the picture the segmentation was made from) into layers. */
export function splitArt(img: RGBAImage, seg: Segmentation, spec: SplitSpec): SplitResult {
  const { width: w, height: h, data } = img;
  if (w !== seg.width || h !== seg.height) throw new Error('The segmentation was made from a different picture size.');
  const n = w * h;
  const P = spec.parts.length;
  if (!P) throw new Error('No parts given.');
  const names = new Set<string>();
  for (const p of spec.parts) {
    if (!NAME.test(p.name)) throw new Error(`Part name "${p.name}": use letters, digits, _ and -.`);
    if (names.has(p.name)) throw new Error(`Part name "${p.name}" is used twice.`);
    names.add(p.name);
  }
  const warnings: string[] = [];
  const R = seg.regions.length;

  let objArea = 0;
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] > 0) objArea++;
  const box = alphaBounds(img, 0);
  const size = box ? Math.max(box.width, box.height) : Math.max(w, h);
  const defFill = spec.fill ?? Math.round(size * 0.1);
  // Enough to give a back part its own outline along edges it shares with a front part (the
  // drawn outline there belongs to the front part), without making it visibly wider.
  const defOverlap = spec.overlap ?? Math.round(Math.max((seg.outline?.width ?? 0) * 1.2, size * 0.01));

  const resolve = (ref: RegionRef, where: string): number => {
    if (typeof ref === 'number') {
      if (!Number.isInteger(ref) || ref < 1 || ref > R) throw new Error(`${where}: there is no region ${ref} (1..${R}).`);
      return ref;
    }
    const [x, y] = ref.map(Math.round);
    if (x < 0 || y < 0 || x >= w || y >= h) throw new Error(`${where}: point [${ref}] is outside the picture.`);
    const id = seg.labels[y * w + x] > 0 ? seg.labels[y * w + x] : seg.owner[y * w + x];
    if (!id) throw new Error(`${where}: point [${ref}] is on a transparent pixel.`);
    return id;
  };

  // ---- Regions -> parts ----
  const regionPart = new Int32Array(R + 1).fill(-1);
  const removed = new Set<number>();
  for (const ref of spec.remove ?? []) removed.add(resolve(ref, 'remove'));
  const listed = spec.parts.map(() => [] as number[]);
  spec.parts.forEach((p, i) => {
    for (const ref of p.regions ?? []) {
      const id = resolve(ref, `parts.${p.name}`);
      if (removed.has(id)) warnings.push(`region ${id} is both removed and in ${p.name}; removed wins`);
      else if (regionPart[id] >= 0 && regionPart[id] !== i)
        warnings.push(`region ${id} is in both ${spec.parts[regionPart[id]].name} and ${p.name}; ${p.name} (further front) wins`);
      regionPart[id] = i;
      listed[i].push(id);
    }
  });
  for (const id of removed) regionPart[id] = -1;

  // Small regions mostly surrounded by one part join it (buttons, highlights, stripes). Repeat so
  // clusters of details resolve from the outside in.
  const auto = spec.parts.map(() => [] as number[]);
  const small = objArea * 0.03;
  for (let changed = true; changed; ) {
    changed = false;
    for (const r of seg.regions) {
      if (regionPart[r.id] >= 0 || removed.has(r.id) || r.area > small) continue;
      const byPart = new Map<number, number>();
      let total = 0;
      r.neighbors.forEach((id, k) => {
        const p = regionPart[id];
        if (p < 0) return;
        byPart.set(p, (byPart.get(p) ?? 0) + r.shared[k]);
        total += r.shared[k];
      });
      if (!total) continue;
      const [p, len] = [...byPart].sort((a, b) => b[1] - a[1])[0];
      if (len < total * 0.7) continue;
      regionPart[r.id] = p;
      auto[p].push(r.id);
      changed = true;
    }
  }
  const rest = spec.parts.findIndex((p) => p.rest);
  const unassigned = seg.regions.filter((r) => regionPart[r.id] < 0 && !removed.has(r.id)).map((r) => r.id);
  if (unassigned.length) {
    if (rest < 0)
      throw new Error(
        `Regions not in any part: ${unassigned.join(', ')}. Add them to parts, list them in "remove", or mark one part with "rest": true.`,
      );
    for (const id of unassigned) {
      regionPart[id] = rest;
      auto[rest].push(id);
    }
  }

  // ---- Pixels -> parts ----
  // Region pixels follow their region. Edge pixels that look like ink (closer to the outline
  // colour than to the region beside them) are outline: they are handed out below, front parts
  // first. Lighter edge pixels (anti-aliasing, compression halos) stay with the region they touch.
  const owner = new Int16Array(n).fill(-1);
  const pending = new Uint8Array(n); // outline pixels still to place
  const ink = seg.outline?.color;
  const regionRGB = seg.regions.map((r) => [parseInt(r.color.slice(1, 3), 16), parseInt(r.color.slice(3, 5), 16), parseInt(r.color.slice(5, 7), 16)]);
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] === 0) continue;
    const l = seg.labels[i];
    if (l > 0) {
      owner[i] = regionPart[l];
      continue;
    }
    const near = seg.owner[i];
    if (!near || removed.has(near)) continue;
    if (ink) {
      const [r, g, b] = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
      const toInk = Math.hypot(r - ink[0], g - ink[1], b - ink[2]);
      const c = regionRGB[near - 1];
      const toRegion = Math.hypot(r - c[0], g - c[1], b - c[2]);
      if (toInk < toRegion) {
        pending[i] = 1;
        continue;
      }
    }
    owner[i] = regionPart[near];
  }
  spec.parts.forEach((p, i) => {
    if (p.polygon) {
      if (p.polygon.length < 3) throw new Error(`parts.${p.name}.polygon needs at least 3 points.`);
      fillPolygon(p.polygon, w, h, (idx) => {
        if (data[idx * 4 + 3] === 0) return;
        owner[idx] = i;
        pending[idx] = 0;
      });
    }
    if (p.strokes) {
      if (p.strokes.length < 3) throw new Error(`parts.${p.name}.strokes needs at least 3 points.`);
      // Everything inside the polygon except the colour(s) around it: the regions that make up
      // most of the polygon's edge are the surroundings (e.g. face fur around a mouth).
      const inPoly = new Uint8Array(n);
      fillPolygon(p.strokes, w, h, (idx) => (inPoly[idx] = 1));
      const edgeCount = new Map<number, number>();
      let edgeTotal = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          if (!inPoly[idx]) continue;
          const onEdge = x === 0 || y === 0 || x === w - 1 || y === h - 1 || !inPoly[idx - 1] || !inPoly[idx + 1] || !inPoly[idx - w] || !inPoly[idx + w];
          const l = seg.labels[idx];
          if (!onEdge || l <= 0) continue;
          edgeCount.set(l, (edgeCount.get(l) ?? 0) + 1);
          edgeTotal++;
        }
      const surround = new Set([...edgeCount].filter(([, c]) => c >= edgeTotal * 0.2).map(([id]) => id));
      for (let idx = 0; idx < n; idx++) {
        if (!inPoly[idx] || data[idx * 4 + 3] === 0) continue;
        const l = seg.labels[idx];
        if (l > 0 && (surround.has(l) || removed.has(l))) continue;
        owner[idx] = i;
        pending[idx] = 0;
      }
    }
  });

  // Outlines go to the part in front: front parts claim stroke pixels within a stroke width,
  // together with the anti-aliased fringe on the stroke's far side (left with a part behind, it
  // would stay there as a faint copy of the line). Parts drawn without an outline of their own (a
  // shine, a glow) take no strokes: a line running along them outlines something else.
  const reach = seg.outline ? seg.outline.width + 1.5 : 3;
  const capReach = seg.outline ? seg.outline.width * 1.5 : 3;
  const boxes = partBoxes(owner, P, w, h);
  const outlined = outlinedParts(owner, pending, P, w, h);
  const strokeOf = new Int16Array(n).fill(-1); // part that took each stroke pixel
  for (let i = P - 1; i >= 0; i--) {
    if (!outlined[i]) continue;
    const win = pad(boxes[i], reach + capReach + 4, w, h);
    if (!win) continue;
    const seeds = new Int32Array(win.w * win.h).fill(-1);
    const pass = new Uint8Array(win.w * win.h);
    forWin(win, w, (k, g) => {
      if (owner[g] === i) seeds[k] = i;
      else if (pending[g]) pass[k] = 1;
    });
    const got = growLabels(seeds, pass, win.w, win.h, reach).label;
    const claimed = new Uint8Array(win.w * win.h);
    forWin(win, w, (k, g) => {
      if (pass[k] && got[k] === i) {
        owner[g] = i;
        pending[g] = 0;
        claimed[k] = 1;
        strokeOf[g] = i;
      }
    });
    // Dead ends: leftover stroke pieces touching the claimed stroke that lie entirely within
    // another half stroke of it (the round caps at a star's points, the far edge of a line
    // thicker than usual) belong to it too. Lines that run on elsewhere stay.
    for (const piece of deadEnds(claimed, pass, win.w, win.h, capReach))
      for (const k of piece) {
        const g = (Math.floor(k / win.w) + win.y) * w + (k % win.w) + win.x;
        owner[g] = i;
        pending[g] = 0;
        claimed[k] = 1;
        strokeOf[g] = i;
      }
    // Fringe: edge pixels (not inside any region) of parts behind, within two pixels of the
    // claimed stroke and visibly tinted by it: at least 15% of the way from the colour behind
    // (the region's pixels close by, as regions can be gradients) to the line's colour.
    const fringe: number[] = [];
    forWin(win, w, (k, g) => {
      if (claimed[k] || seg.labels[g] > 0 || owner[g] < 0 || owner[g] >= i) return;
      const back = seg.owner[g];
      if (back <= 0) return;
      const x = k % win.w;
      const y = (k - x) / win.w;
      let line = -1;
      let best = Infinity;
      const c = [0, 0, 0];
      let count = 0;
      for (let dy = -3; dy <= 3; dy++)
        for (let dx = -3; dx <= 3; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= win.w || ny >= win.h) continue;
          const j = g + dy * w + dx;
          if (seg.labels[j] === back) {
            for (let ch = 0; ch < 3; ch++) c[ch] += data[j * 4 + ch];
            count++;
          }
          if (Math.abs(dx) <= 2 && Math.abs(dy) <= 2 && claimed[ny * win.w + nx] && dx * dx + dy * dy < best) {
            best = dx * dx + dy * dy;
            line = j;
          }
        }
      if (line < 0) return;
      if (count) for (let ch = 0; ch < 3; ch++) c[ch] /= count;
      else c.splice(0, 3, ...regionRGB[back - 1]);
      let along = 0;
      let len = 0;
      for (let ch = 0; ch < 3; ch++) {
        const s = data[line * 4 + ch] - c[ch];
        along += (data[g * 4 + ch] - c[ch]) * s;
        len += s * s;
      }
      if (len > 0 && along >= len * 0.15) fringe.push(g);
    });
    for (const g of fringe) owner[g] = i;
  }
  // Whatever is left (thick strokes, stray edge pixels) continues the stroke it touches, or else
  // joins the nearest part.
  {
    const seeds = new Int32Array(n).fill(-1);
    for (let k = 0; k < n; k++) if (strokeOf[k] >= 0) seeds[k] = strokeOf[k];
    const along = growLabels(seeds, pending, w, h).label;
    for (let k = 0; k < n; k++)
      if (pending[k] && along[k] >= 0) {
        owner[k] = along[k];
        pending[k] = 0;
      }
    seeds.fill(-1);
    for (let k = 0; k < n; k++) if (owner[k] >= 0) seeds[k] = owner[k];
    const got = growLabels(seeds, pending, w, h).label;
    for (let k = 0; k < n; k++) if (pending[k] && got[k] >= 0) owner[k] = got[k];
  }

  // ---- Layers, rebuilding what front parts hide ----
  const outlineOn = (spec.outline ?? true) && !!seg.outline;
  const line = outlineOn && seg.outline ? seg.outline : null;
  const lineWidth = seg.outline?.width ?? 2;
  const layers: Layer[] = [];
  const fills: Uint8Array[] = [];
  const reports: SplitPartReport[] = [];
  // frontAt[k]: index of the front-most part with an opaque pixel at k (-1 none). A part is
  // covered at k when that index is greater than its own.
  const frontAt = new Int16Array(n).fill(-1);
  for (let k = 0; k < n; k++) if (owner[k] >= 0 && data[k * 4 + 3] === 255) frontAt[k] = owner[k];
  const finalBoxes = partBoxes(owner, P, w, h);

  for (let i = 0; i < P; i++) {
    const part = spec.parts[i];
    const r = part.fill ?? defFill;
    const o = part.overlap ?? defOverlap;
    const fill = new Uint8Array(n);
    fills.push(fill);
    const win = pad(finalBoxes[i], Math.max(r, o, 0) + 3, w, h);
    if (!win) {
      warnings.push(`part ${part.name} is empty`);
      reports.push({ name: part.name, pixels: 0, filled: 0, box: null, regions: listed[i].sort((a, b) => a - b), auto: auto[i].sort((a, b) => a - b) });
      continue;
    }
    const m = new Uint8Array(win.w * win.h);
    let pixels = 0;
    forWin(win, w, (k, g) => {
      if (owner[g] === i) {
        m[k] = 1;
        pixels++;
      }
    });
    const f = new Uint8Array(win.w * win.h);
    let filled = 0;
    if (i < P - 1 && (r > 0 || o > 0)) {
      const grown = r > 0 ? closeDisk(m, win.w, win.h, r) : m.slice();
      if (o > 0) {
        const d = dilateDisk(m, win.w, win.h, o);
        for (let k = 0; k < d.length; k++) if (d[k]) grown[k] = 1;
      }
      // Holes that parts in front cover completely (the glow behind a coin, a body behind a
      // shield) are rebuilt whatever their size.
      if (r > 0) fillCoveredHoles(grown, m, win, w, owner, i);
      forWin(win, w, (k, g) => {
        if (grown[k] && !m[k] && frontAt[g] > i) f[k] = 1;
      });
      // Smooth the rebuilt shape: slivers along the edges of front parts (thinner than about an
      // outline) would otherwise turn into spiky outline fragments.
      const smooth = Math.max(2, Math.round(lineWidth));
      const whole = new Uint8Array(f.length);
      for (let k = 0; k < f.length; k++) whole[k] = m[k] || f[k] ? 1 : 0;
      const opened = dilateDisk(erodeDisk(whole, win.w, win.h, smooth), win.w, win.h, smooth);
      forWin(win, w, (k, g) => {
        if (!f[k]) return;
        if (!opened[k]) {
          f[k] = 0;
          return;
        }
        fill[g] = 1;
        filled++;
      });
    }
    const image = createImage(win.w, win.h);
    let opaque = 0;
    forWin(win, w, (k, g) => {
      if (!m[k]) return;
      image.data.set(data.subarray(g * 4, g * 4 + 4), k * 4);
      if (data[g * 4 + 3] === 255) opaque++;
    });
    // Mostly see-through parts (glows, shadows) are continued faintly and without an outline.
    const solidPart = opaque >= pixels * 0.5;
    if (filled) paintFill(image, data, seg, win, w, m, f, solidPart ? line : null, solidPart);
    const trimmed = trimLayer({ name: part.name, x: win.x, y: win.y, image, hidden: false, opacity: 1, blend: 'normal' });
    if (trimmed) layers.push(trimmed);
    reports.push({
      name: part.name,
      pixels,
      filled,
      box: trimmed ? { x: trimmed.x, y: trimmed.y, width: trimmed.image.width, height: trimmed.image.height } : null,
      regions: [...new Set(listed[i])].sort((a, b) => a - b),
      auto: auto[i].sort((a, b) => a - b),
    });
  }

  // Lossless check: stacking the layers must give the picture back.
  let difference = 0;
  const stacked = stack(layers, w, h);
  for (let k = 0; k < n * 4; k++) {
    if (data[k - (k % 4) + 3] === 0 && stacked[k - (k % 4) + 3] === 0) continue;
    const d = Math.abs(stacked[k] - data[k]);
    if (d > difference) difference = d;
  }

  return {
    art: { width: w, height: h, layers, warnings: [] },
    report: { parts: reports, removed: [...removed].sort((a, b) => a - b), warnings, difference, fill: defFill, overlap: defOverlap },
    owner,
    fills,
  };
}

/**
 * Paints rebuilt pixels (`f`, window coordinates) with the part's nearest own colours, continuing
 * the outline along the new edge. See-through parts (`opaqueFill` false) keep their sources' alpha.
 */
function paintFill(
  image: RGBAImage,
  data: Uint8Array,
  seg: Segmentation,
  win: Win,
  w: number,
  m: Uint8Array,
  f: Uint8Array,
  outline: { width: number; color: [number, number, number] } | null,
  opaqueFill: boolean,
) {
  const n = win.w * win.h;
  // Sources: the part's solid colour areas, a few pixels away from any colour change, so thin
  // details (fold lines, stripes) and anti-aliased edges are not smeared into the fill. (Opaque
  // ones only for solid parts; a glow has none.)
  const solid = new Uint8Array(n);
  forWin(win, w, (k, g) => {
    const l = seg.labels[g];
    if (!m[k] || l <= 0 || (opaqueFill && data[g * 4 + 3] !== 255)) return;
    const x = k % win.w;
    const y = (k - x) / win.w;
    if (x === 0 || y === 0 || x === win.w - 1 || y === win.h - 1) return;
    if (seg.labels[g - 1] !== l || seg.labels[g + 1] !== l || seg.labels[g - w] !== l || seg.labels[g + w] !== l) return;
    solid[k] = 1;
  });
  const depth = distanceTransform(solid, win.w, win.h);
  const seeds = new Int32Array(n).fill(-1);
  for (const min of [3, 1.5, 0]) {
    let count = 0;
    forWin(win, w, (k, g) => {
      if (solid[k] && depth[k] > min) {
        seeds[k] = g;
        count++;
      }
    });
    if (count) break;
  }
  if (!seeds.some((v) => v >= 0)) forWin(win, w, (k, g) => m[k] && (seeds[k] = g));
  const passable = new Uint8Array(n);
  for (let k = 0; k < n; k++) if (f[k] || (m[k] && seeds[k] < 0)) passable[k] = 1;
  const src = growLabels(seeds, passable, win.w, win.h).label;
  // Rebuilt areas cut off from the part by pixels it cannot cover (a soft edge of the part in
  // front between a glow and the hole behind that part) take the nearest colours across them.
  let cut = false;
  for (let k = 0; k < n && !cut; k++) if (f[k] && src[k] < 0) cut = true;
  if (cut) {
    const across = growLabels(seeds, new Uint8Array(n).fill(1), win.w, win.h).label;
    for (let k = 0; k < n; k++) if (f[k] && src[k] < 0) src[k] = across[k];
  }

  // Colours. Each rebuilt pixel takes the colour area of its nearest source. Areas that look
  // alike where they meet inside the rebuilt region (one surface cut in two by the part in front,
  // like a gradient on both sides of an arm) are filled together; different areas keep a sharp
  // edge between them (flat cartoon colours). Within a surface, the colours of its sources along
  // the rebuilt region's edge are interpolated smoothly, so gradients continue instead of turning
  // into flat facets, without drifting towards colours far away.
  const fillColor = new Float32Array(n * 4);
  smoothFill(f, src, seeds, data, seg, win, fillColor);

  const whole = new Uint8Array(n);
  for (let k = 0; k < n; k++) whole[k] = m[k] || f[k] ? 1 : 0;
  const edge = outline ? distanceTransform(whole, win.w, win.h) : null;
  const d = image.data;
  for (let k = 0; k < n; k++) {
    if (!f[k]) continue;
    const s = src[k];
    if (s < 0) continue;
    let r = fillColor[k * 4];
    let g = fillColor[k * 4 + 1];
    let b = fillColor[k * 4 + 2];
    if (outline && edge) {
      const cover = Math.max(0, Math.min(1, outline.width + 0.5 - edge[k]));
      r += (outline.color[0] - r) * cover;
      g += (outline.color[1] - g) * cover;
      b += (outline.color[2] - b) * cover;
    }
    d[k * 4] = Math.round(r);
    d[k * 4 + 1] = Math.round(g);
    d[k * 4 + 2] = Math.round(b);
    // Solid parts are filled opaque; a glow continues its own faintness.
    d[k * 4 + 3] = opaqueFill ? 255 : Math.round(fillColor[k * 4 + 3]);
  }
}

/** Width (px) of the band of sources along a rebuilt region's edge that its colours come from. */
const FILL_BAND = 10;
/** Areas whose sources by a rebuilt region differ less than this (RGB distance) are one surface. */
const SAME_SURFACE = 40;

/** Colours (RGBA, window pixels) for the rebuilt pixels `f`; see paintFill. */
function smoothFill(f: Uint8Array, src: Int32Array, seeds: Int32Array, data: Uint8Array, seg: Segmentation, win: Win, out: Float32Array) {
  const n = win.w * win.h;
  const areaOf = (k: number) => seg.labels[src[k]];
  // Sources near the rebuilt region and their mean colour per area.
  const notF = new Uint8Array(n);
  for (let k = 0; k < n; k++) notF[k] = f[k] ? 0 : 1;
  const toHole = distanceTransform(notF, win.w, win.h);
  const band = new Uint8Array(n);
  const mean = new Map<number, [number, number, number, number]>();
  for (let k = 0; k < n; k++) {
    const g = seeds[k];
    if (g < 0 || toHole[k] > FILL_BAND) continue;
    band[k] = 1;
    const area = seg.labels[g];
    const m = mean.get(area) ?? mean.set(area, [0, 0, 0, 0]).get(area)!;
    for (let c = 0; c < 3; c++) m[c] += data[g * 4 + c];
    m[3]++;
  }
  // Surfaces: areas meeting inside the rebuilt region with similar colours there.
  const parent = new Map<number, number>();
  const find = (a: number): number => {
    let r = a;
    while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
    parent.set(a, r);
    return r;
  };
  const similar = (a: number, b: number) => {
    const ma = mean.get(a);
    const mb = mean.get(b);
    if (!ma || !mb) return false;
    let d = 0;
    for (let c = 0; c < 3; c++) d += (ma[c] / ma[3] - mb[c] / mb[3]) ** 2;
    return Math.sqrt(d) < SAME_SURFACE;
  };
  for (let k = 0; k < n; k++) {
    if (!f[k] || src[k] < 0) continue;
    const a = areaOf(k);
    find(a);
    const x = k % win.w;
    for (const j of [x + 1 < win.w ? k + 1 : -1, k + win.w < n ? k + win.w : -1]) {
      if (j < 0 || !f[j] || src[j] < 0) continue;
      const b = areaOf(j);
      if (b !== a && find(a) !== find(b) && similar(a, b)) parent.set(find(a), find(b));
    }
  }
  const surfaces = new Map<number, number[]>();
  for (let k = 0; k < n; k++) {
    if (!f[k] || src[k] < 0) continue;
    const root = find(areaOf(k));
    (surfaces.get(root) ?? surfaces.set(root, []).get(root)!).push(k);
  }
  for (const [root, cell] of surfaces) {
    let x0 = win.w;
    let y0 = win.h;
    let x1 = -1;
    let y1 = -1;
    for (const k of cell) {
      const x = k % win.w;
      const y = (k - x) / win.w;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    const pad = FILL_BAND + 2;
    x0 = Math.max(0, x0 - pad);
    y0 = Math.max(0, y0 - pad);
    x1 = Math.min(win.w - 1, x1 + pad);
    y1 = Math.min(win.h - 1, y1 + pad);
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const vals = new Float32Array(bw * bh * 4);
    const known = new Uint8Array(bw * bh);
    let any = false;
    for (let y = 0; y < bh; y++)
      for (let x = 0; x < bw; x++) {
        const k = (y + y0) * win.w + x + x0;
        if (!band[k] || find(seg.labels[seeds[k]]) !== root) continue;
        known[y * bw + x] = 1;
        for (let c = 0; c < 4; c++) vals[(y * bw + x) * 4 + c] = data[seeds[k] * 4 + c];
        any = true;
      }
    if (!any) {
      // No source of this surface near the region: the nearest source's colour.
      for (const k of cell) for (let c = 0; c < 4; c++) out[k * 4 + c] = data[src[k] * 4 + c];
      continue;
    }
    const filled = pushPull(vals, known, bw, bh, 4);
    for (const k of cell) {
      const x = (k % win.w) - x0;
      const y = Math.floor(k / win.w) - y0;
      for (let c = 0; c < 4; c++) out[k * 4 + c] = filled[(y * bw + x) * 4 + c];
    }
  }
}

/**
 * Smooth scattered-data fill: values known at some pixels are averaged down an image pyramid
 * (push), then brought back up with bilinear upsampling where nothing was known (pull), relaxing
 * the unknown pixels at every level towards the average of their neighbours (a few Gauss-Seidel
 * sweeps of Laplace's equation, coarse to fine), so the fill is close to a membrane stretched over
 * the known values: gradients continue linearly across holes.
 */
export function pushPull(vals: Float32Array, known: Uint8Array, w: number, h: number, ch: number, sweeps = 8): Float32Array {
  type Level = { w: number; h: number; c: Float32Array; wt: Float32Array };
  const base: Level = { w, h, c: new Float32Array(w * h * ch), wt: new Float32Array(w * h) };
  for (let i = 0; i < w * h; i++)
    if (known[i]) {
      base.wt[i] = 1;
      for (let k = 0; k < ch; k++) base.c[i * ch + k] = vals[i * ch + k];
    }
  const levels = [base];
  const acc = new Float64Array(ch);
  for (let cur = base; cur.w > 1 || cur.h > 1; ) {
    const nw = Math.ceil(cur.w / 2);
    const nh = Math.ceil(cur.h / 2);
    const next: Level = { w: nw, h: nh, c: new Float32Array(nw * nh * ch), wt: new Float32Array(nw * nh) };
    let full = true;
    for (let y = 0; y < nh; y++)
      for (let x = 0; x < nw; x++) {
        let sum = 0;
        acc.fill(0);
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const sx = 2 * x + dx;
            const sy = 2 * y + dy;
            if (sx >= cur.w || sy >= cur.h) continue;
            const i = sy * cur.w + sx;
            const wt = cur.wt[i];
            if (!wt) continue;
            sum += wt;
            for (let k = 0; k < ch; k++) acc[k] += cur.c[i * ch + k] * wt;
          }
        const j = y * nw + x;
        if (sum > 0) {
          for (let k = 0; k < ch; k++) next.c[j * ch + k] = acc[k] / sum;
          next.wt[j] = Math.min(1, sum);
        } else full = false;
      }
    levels.push(next);
    cur = next;
    if (full) break;
  }
  const relax = (lv: Level, free: number[]) => {
    const { w: W, h: H, c } = lv;
    for (let it = 0; it < sweeps; it++)
      for (let f = 0; f < free.length; f++) {
        const i = free[f];
        const x = i % W;
        const y = (i - x) / W;
        const l = x > 0 ? i - 1 : -1;
        const r = x < W - 1 ? i + 1 : -1;
        const u = y > 0 ? i - W : -1;
        const d = y < H - 1 ? i + W : -1;
        const cnt = (l >= 0 ? 1 : 0) + (r >= 0 ? 1 : 0) + (u >= 0 ? 1 : 0) + (d >= 0 ? 1 : 0);
        for (let k = 0; k < ch; k++) {
          let sum = 0;
          if (l >= 0) sum += c[l * ch + k];
          if (r >= 0) sum += c[r * ch + k];
          if (u >= 0) sum += c[u * ch + k];
          if (d >= 0) sum += c[d * ch + k];
          c[i * ch + k] = sum / cnt;
        }
      }
  };
  {
    const top = levels[levels.length - 1];
    const free: number[] = [];
    for (let i = 0; i < top.w * top.h; i++) if (top.wt[i] < 1) free.push(i);
    relax(top, free);
  }
  for (let l = levels.length - 2; l >= 0; l--) {
    const fine = levels[l];
    const coarse = levels[l + 1];
    const free: number[] = [];
    for (let y = 0; y < fine.h; y++) {
      const fy = Math.min(coarse.h - 1, Math.max(0, (y + 0.5) / 2 - 0.5));
      const cy0 = Math.floor(fy);
      const cy1 = Math.min(coarse.h - 1, cy0 + 1);
      const ty = fy - cy0;
      for (let x = 0; x < fine.w; x++) {
        const i = y * fine.w + x;
        const wt = fine.wt[i];
        if (wt >= 1) continue;
        free.push(i);
        const fx = Math.min(coarse.w - 1, Math.max(0, (x + 0.5) / 2 - 0.5));
        const cx0 = Math.floor(fx);
        const cx1 = Math.min(coarse.w - 1, cx0 + 1);
        const tx = fx - cx0;
        for (let k = 0; k < ch; k++) {
          const a = coarse.c[(cy0 * coarse.w + cx0) * ch + k];
          const b = coarse.c[(cy0 * coarse.w + cx1) * ch + k];
          const c = coarse.c[(cy1 * coarse.w + cx0) * ch + k];
          const d = coarse.c[(cy1 * coarse.w + cx1) * ch + k];
          const up = (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
          fine.c[i * ch + k] = wt * fine.c[i * ch + k] + (1 - wt) * up;
        }
        fine.wt[i] = 1;
      }
    }
    // Pixels the known values do not fully cover settle between their neighbours.
    relax(fine, free);
  }
  return base.c;
}

/**
 * Whether each part has an outline of its own: most of its edge (pixels next to anything else)
 * lies within two pixels of stroke pixels still to be handed out.
 */
function outlinedParts(owner: Int16Array, pending: Uint8Array, P: number, w: number, h: number): Uint8Array {
  const edge = new Float64Array(P);
  const inked = new Float64Array(P);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      const p = owner[k];
      if (p < 0) continue;
      const border =
        (x > 0 && owner[k - 1] !== p) || (x < w - 1 && owner[k + 1] !== p) || (y > 0 && owner[k - w] !== p) || (y < h - 1 && owner[k + w] !== p);
      if (!border) continue;
      edge[p]++;
      search: for (let dy = -2; dy <= 2; dy++)
        for (let dx = -2; dx <= 2; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < w && ny < h && pending[ny * w + nx]) {
            inked[p]++;
            break search;
          }
        }
    }
  const out = new Uint8Array(P);
  for (let p = 0; p < P; p++) out[p] = edge[p] > 0 && inked[p] >= edge[p] * 0.5 ? 1 : 0;
  return out;
}

/**
 * Pieces (8-connected, window indices) of `pass` pixels not in `claimed` that touch `claimed`,
 * stay inside the window, and are reached entirely within `maxDist` of it.
 */
function deadEnds(claimed: Uint8Array, pass: Uint8Array, ww: number, wh: number, maxDist: number): number[][] {
  const n = ww * wh;
  const seeds = new Int32Array(n).fill(-1);
  const rest = new Uint8Array(n);
  let any = false;
  for (let k = 0; k < n; k++) {
    if (claimed[k]) {
      seeds[k] = 0;
      any = true;
    } else if (pass[k]) rest[k] = 1;
  }
  if (!any) return [];
  const near = growLabels(seeds, rest, ww, wh, maxDist).label;
  const seen = new Uint8Array(n);
  const out: number[][] = [];
  for (let k0 = 0; k0 < n; k0++) {
    if (!rest[k0] || seen[k0]) continue;
    const members: number[] = [];
    let touches = false;
    let inside = true;
    const stack = [k0];
    seen[k0] = 1;
    while (stack.length) {
      const k = stack.pop()!;
      members.push(k);
      if (near[k] < 0) inside = false;
      const x = k % ww;
      const y = (k - x) / ww;
      if (x === 0 || y === 0 || x === ww - 1 || y === wh - 1) inside = false;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= ww || ny >= wh) continue;
          const j = ny * ww + nx;
          if (claimed[j]) touches = true;
          else if (rest[j] && !seen[j]) {
            seen[j] = 1;
            stack.push(j);
          }
        }
    }
    if (touches && inside) out.push(members);
  }
  return out;
}

/**
 * Adds to `grown` the holes in a part (`m`, window coordinates) whose every pixel belongs to a
 * part in front of it.
 */
function fillCoveredHoles(grown: Uint8Array, m: Uint8Array, win: Win, w: number, owner: Int16Array, part: number) {
  const n = win.w * win.h;
  // Outside: everything not in the part that connects to the window's border.
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  const visit = (k: number) => {
    if (!m[k] && !seen[k]) {
      seen[k] = 1;
      stack.push(k);
    }
  };
  for (let x = 0; x < win.w; x++) {
    visit(x);
    visit((win.h - 1) * win.w + x);
  }
  for (let y = 0; y < win.h; y++) {
    visit(y * win.w);
    visit(y * win.w + win.w - 1);
  }
  const flood = () => {
    while (stack.length) {
      const k = stack.pop()!;
      const x = k % win.w;
      const y = (k - x) / win.w;
      if (x > 0) visit(k - 1);
      if (x < win.w - 1) visit(k + 1);
      if (y > 0) visit(k - win.w);
      if (y < win.h - 1) visit(k + win.w);
    }
  };
  flood();
  // Each remaining component is a hole.
  for (let k0 = 0; k0 < n; k0++) {
    if (m[k0] || seen[k0]) continue;
    const start = stack.length;
    const members: number[] = [];
    visit(k0);
    let covered = true;
    while (stack.length > start) {
      const k = stack.pop()!;
      members.push(k);
      const x = k % win.w;
      const y = (k - x) / win.w;
      if (owner[(y + win.y) * w + x + win.x] <= part) covered = false;
      if (x > 0) visit(k - 1);
      if (x < win.w - 1) visit(k + 1);
      if (y > 0) visit(k - win.w);
      if (y < win.h - 1) visit(k + win.w);
    }
    if (covered) for (const k of members) grown[k] = 1;
  }
}

interface Win {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Bounding box of each part's pixels (null if it has none). */
function partBoxes(owner: Int16Array, P: number, w: number, h: number): (Win | null)[] {
  const x0 = new Int32Array(P).fill(w);
  const y0 = new Int32Array(P).fill(h);
  const x1 = new Int32Array(P).fill(-1);
  const y1 = new Int32Array(P).fill(-1);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = owner[y * w + x];
      if (p < 0) continue;
      if (x < x0[p]) x0[p] = x;
      if (x > x1[p]) x1[p] = x;
      if (y < y0[p]) y0[p] = y;
      if (y > y1[p]) y1[p] = y;
    }
  return Array.from({ length: P }, (_, p) => (x1[p] < 0 ? null : { x: x0[p], y: y0[p], w: x1[p] - x0[p] + 1, h: y1[p] - y0[p] + 1 }));
}

/** A box grown by `by` pixels and clipped to the image. */
function pad(box: Win | null, by: number, w: number, h: number): Win | null {
  if (!box) return null;
  const p = Math.ceil(by);
  const x = Math.max(0, box.x - p);
  const y = Math.max(0, box.y - p);
  return { x, y, w: Math.min(w, box.x + box.w + p) - x, h: Math.min(h, box.y + box.h + p) - y };
}

/** Visits every pixel of a window: `k` is the index in the window, `g` in the full image. */
function forWin(win: Win, w: number, fn: (k: number, g: number) => unknown) {
  for (let y = 0; y < win.h; y++) {
    const row = (y + win.y) * w + win.x;
    for (let x = 0; x < win.w; x++) fn(y * win.w + x, row + x);
  }
}

/** Calls `set` for every pixel whose centre is inside the polygon (even-odd rule). */
export function fillPolygon(poly: [number, number][], w: number, h: number, set: (index: number) => void) {
  let minY = Infinity;
  let maxY = -Infinity;
  for (const [, y] of poly) {
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
  }
  for (let y = Math.max(0, Math.floor(minY)); y <= Math.min(h - 1, Math.ceil(maxY)); y++) {
    const cy = y + 0.5;
    const xs: number[] = [];
    for (let a = 0; a < poly.length; a++) {
      const [x1, y1] = poly[a];
      const [x2, y2] = poly[(a + 1) % poly.length];
      if (y1 <= cy === y2 <= cy) continue;
      xs.push(x1 + ((cy - y1) / (y2 - y1)) * (x2 - x1));
    }
    xs.sort((p, q) => p - q);
    for (let k = 0; k + 1 < xs.length; k += 2)
      for (let x = Math.max(0, Math.ceil(xs[k] - 0.5)); x <= Math.min(w - 1, Math.floor(xs[k + 1] - 0.5)); x++) set(y * w + x);
  }
}

/** Straight-alpha "over" compositing of full-canvas layers (bottom first). */
function stack(layers: Layer[], w: number, h: number): Uint8Array {
  const out = new Float64Array(w * h * 4);
  for (const l of layers) {
    const s = l.image;
    for (let row = 0; row < s.height; row++)
      for (let col = 0; col < s.width; col++) {
        const si = (row * s.width + col) * 4;
        const a = s.data[si + 3] / 255;
        if (!a) continue;
        const di = ((row + l.y) * w + col + l.x) * 4;
        const da = out[di + 3];
        const oa = a + da * (1 - a);
        for (let c = 0; c < 3; c++) out[di + c] = (s.data[si + c] * a + out[di + c] * da * (1 - a)) / oa;
        out[di + 3] = oa;
      }
  }
  const res = new Uint8Array(w * h * 4);
  for (let k = 0; k < res.length; k++) res[k] = Math.round((k % 4 === 3 ? out[k] * 255 : out[k]));
  return res;
}

/**
 * A split as stored in a project or sample (split.json): how to read the picture plus the parts.
 * Region ids depend on these settings, so they are kept together.
 */
export interface SplitFile extends SplitSpec {
  /** 'auto' (default), 'none', or a colour '#rrggbb' to remove. */
  background?: string;
  /** Segmentation detail (2 = finer regions, 0.5 = coarser). Default 1. */
  detail?: number;
}

/** Parses '#rgb' / '#rrggbb' into [r, g, b]. */
export function parseColor(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new Error(`Not a colour: "${hex}" (use #rrggbb).`);
  const s = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

/** Background removal + segmentation with a split file's settings. */
export function readPicture(src: RGBAImage, settings: Pick<SplitFile, 'background' | 'detail'> = {}) {
  const bg = settings.background ?? 'auto';
  const background = removeBackground(src, { background: bg === 'auto' || bg === 'none' ? bg : parseColor(bg) });
  const segmentation = segmentArt(background.image, { detail: settings.detail });
  return { image: background.image, background, segmentation };
}
