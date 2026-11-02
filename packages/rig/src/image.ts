import { PNG } from 'pngjs';

/** Straight (non-premultiplied) RGBA image. */
export interface RGBAImage {
  width: number;
  height: number;
  data: Uint8Array;
}

/** A layer placed on a canvas (e.g. a PSD layer). `x`, `y` are the top-left in canvas pixels. */
export interface Layer {
  name: string;
  x: number;
  y: number;
  image: RGBAImage;
  hidden: boolean;
  /** 0..1 */
  opacity: number;
  blend: 'normal' | 'add' | 'multiply' | 'screen';
}

export function createImage(width: number, height: number): RGBAImage {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

export function decodePng(buffer: Uint8Array): RGBAImage {
  const png = PNG.sync.read(Buffer.from(buffer));
  return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) };
}

export function encodePng(img: RGBAImage): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  png.data = Buffer.from(img.data.buffer, img.data.byteOffset, img.data.length);
  return PNG.sync.write(png);
}

/** Bounding box of pixels with alpha > threshold, or null if fully transparent. */
export function alphaBounds(img: RGBAImage, threshold = 0): { x: number; y: number; width: number; height: number } | null {
  let minX = img.width;
  let minY = img.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++)
      if (img.data[(y * img.width + x) * 4 + 3] > threshold) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
  if (maxX < 0) return null;
  return { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

/** Copies a rectangle; areas outside the source become transparent (so it can also pad). */
export function crop(img: RGBAImage, x: number, y: number, width: number, height: number): RGBAImage {
  const out = createImage(width, height);
  for (let row = 0; row < height; row++) {
    const sy = y + row;
    if (sy < 0 || sy >= img.height) continue;
    for (let col = 0; col < width; col++) {
      const sx = x + col;
      if (sx < 0 || sx >= img.width) continue;
      const si = (sy * img.width + sx) * 4;
      const di = (row * width + col) * 4;
      out.data[di] = img.data[si];
      out.data[di + 1] = img.data[si + 1];
      out.data[di + 2] = img.data[si + 2];
      out.data[di + 3] = img.data[si + 3];
    }
  }
  return out;
}

/** Trims transparent borders and adds `pad` transparent pixels around. Returns null if empty. */
export function trimLayer(layer: Layer, pad = 0): Layer | null {
  const b = alphaBounds(layer.image);
  if (!b) return null;
  return {
    ...layer,
    x: layer.x + b.x - pad,
    y: layer.y + b.y - pad,
    image: crop(layer.image, b.x - pad, b.y - pad, b.width + pad * 2, b.height + pad * 2),
  };
}

/** Composites visible layers onto a canvas, bottom layer first (normal and additive blending). */
export function composite(layers: Layer[], width: number, height: number): RGBAImage {
  const out = createImage(width, height);
  const d = out.data;
  for (const layer of layers) {
    if (layer.hidden) continue;
    const s = layer.image;
    for (let row = 0; row < s.height; row++) {
      const y = layer.y + row;
      if (y < 0 || y >= height) continue;
      for (let col = 0; col < s.width; col++) {
        const x = layer.x + col;
        if (x < 0 || x >= width) continue;
        const si = (row * s.width + col) * 4;
        const a = (s.data[si + 3] / 255) * layer.opacity;
        if (a <= 0) continue;
        const di = (y * width + x) * 4;
        const da = d[di + 3] / 255;
        if (layer.blend === 'add') {
          // Light adds in premultiplied space; over nothing it is just the light itself (stored
          // with straight alpha, so a glow on a transparent canvas keeps its colour).
          const oa = Math.min(1, da + a);
          for (let c = 0; c < 3; c++) d[di + c] = Math.min(255, Math.round((d[di + c] * da + s.data[si + c] * a) / oa));
          d[di + 3] = Math.round(oa * 255);
          continue;
        }
        const oa = a + da * (1 - a);
        for (let c = 0; c < 3; c++) d[di + c] = Math.round((s.data[si + c] * a + d[di + c] * da * (1 - a)) / oa);
        d[di + 3] = Math.round(oa * 255);
      }
    }
  }
  return out;
}

/** Binary mask (1 = covered) from alpha, with a threshold in 0..255. */
export function alphaMask(img: RGBAImage, threshold = 8): Uint8Array {
  const m = new Uint8Array(img.width * img.height);
  for (let i = 0; i < m.length; i++) m[i] = img.data[i * 4 + 3] > threshold ? 1 : 0;
  return m;
}

/** Square dilation by `r` pixels (two separable passes). */
export function dilate(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const tmp = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    let run = -Infinity;
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) run = x;
      if (x - run <= r) tmp[y * w + x] = 1;
    }
    run = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (mask[y * w + x]) run = x;
      if (run - x <= r) tmp[y * w + x] = 1;
    }
  }
  const out = new Uint8Array(mask.length);
  for (let x = 0; x < w; x++) {
    let run = -Infinity;
    for (let y = 0; y < h; y++) {
      if (tmp[y * w + x]) run = y;
      if (y - run <= r) out[y * w + x] = 1;
    }
    run = Infinity;
    for (let y = h - 1; y >= 0; y--) {
      if (tmp[y * w + x]) run = y;
      if (run - y <= r) out[y * w + x] = 1;
    }
  }
  return out;
}

/**
 * Euclidean distance transform (Felzenszwalb & Huttenlocher): distance in pixels from each
 * covered pixel to the nearest uncovered pixel. Pixels outside the mask get 0.
 */
export function distanceTransform(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e20;
  const f = new Float64Array(Math.max(w, h));
  const d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h));
  const z = new Float64Array(Math.max(w, h) + 1);
  const grid = new Float64Array(w * h);
  for (let i = 0; i < grid.length; i++) grid[i] = mask[i] ? INF : 0;
  const pass = (n: number, get: (i: number) => number, set: (i: number, val: number) => void) => {
    for (let i = 0; i < n; i++) f[i] = get(i);
    let k = 0;
    v[0] = 0;
    z[0] = -INF;
    z[1] = INF;
    for (let q = 1; q < n; q++) {
      let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      while (s <= z[k]) {
        k--;
        s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
      }
      k++;
      v[k] = q;
      z[k] = s;
      z[k + 1] = INF;
    }
    k = 0;
    for (let q = 0; q < n; q++) {
      while (z[k + 1] < q) k++;
      d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
    }
    for (let i = 0; i < n; i++) set(i, d[i]);
  };
  for (let x = 0; x < w; x++)
    pass(h, (y) => grid[y * w + x], (y, val) => (grid[y * w + x] = val));
  for (let y = 0; y < h; y++)
    pass(w, (x) => grid[y * w + x], (x, val) => (grid[y * w + x] = val));
  const out = new Float32Array(w * h);
  for (let i = 0; i < out.length; i++) out[i] = Math.sqrt(grid[i]);
  return out;
}

/** Disk dilation: pixels within `r` of the mask (Euclidean). */
export function dilateDisk(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const inv = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) inv[i] = mask[i] ? 0 : 1;
  const d = distanceTransform(inv, w, h);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = mask[i] || d[i] <= r ? 1 : 0;
  return out;
}

/** Disk erosion: mask pixels further than `r` from the outside. */
export function erodeDisk(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  const d = distanceTransform(mask, w, h);
  const out = new Uint8Array(mask.length);
  for (let i = 0; i < mask.length; i++) out[i] = d[i] > r ? 1 : 0;
  return out;
}

/** Disk closing (dilate then erode): fills gaps and bites narrower than about 2r. Keeps the mask. */
export function closeDisk(mask: Uint8Array, w: number, h: number, r: number): Uint8Array {
  if (r <= 0) return mask.slice();
  // Pad so shapes touching the image border close the same way as everywhere else.
  const p = Math.ceil(r) + 1;
  const W = w + 2 * p;
  const H = h + 2 * p;
  const padded = new Uint8Array(W * H);
  for (let y = 0; y < h; y++) padded.set(mask.subarray(y * w, y * w + w), (y + p) * W + p);
  const closed = erodeDisk(dilateDisk(padded, W, H, r), W, H, r);
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) out[y * w + x] = mask[y * w + x] || closed[(y + p) * W + x + p] ? 1 : 0;
  return out;
}

/**
 * Multi-source geodesic growth over `passable` pixels with chamfer distances (orthogonal 5,
 * diagonal 7, so ~5 units per pixel). Seeds are pixels with `seeds[i] >= 0`; every passable
 * pixel reached within `maxDist` pixels takes the label of its nearest seed. Returns the labels
 * (-1 = not reached) and distances in pixels.
 */
export function growLabels(
  seeds: Int32Array,
  passable: Uint8Array,
  w: number,
  h: number,
  maxDist = Infinity,
): { label: Int32Array; dist: Float32Array } {
  const n = w * h;
  const label = new Int32Array(n).fill(-1);
  const dist = new Int32Array(n).fill(0x7fffffff);
  const limit = maxDist === Infinity ? 0x7ffffffe : Math.round(maxDist * 5);
  // Dial's algorithm: circular buckets (edge weights are at most 7).
  const buckets: number[][] = Array.from({ length: 8 }, () => []);
  let pending = 0;
  for (let i = 0; i < n; i++)
    if (seeds[i] >= 0) {
      label[i] = seeds[i];
      dist[i] = 0;
      buckets[0].push(i);
      pending++;
    }
  const DX = [1, -1, 0, 0, 1, 1, -1, -1];
  const DY = [0, 0, 1, -1, 1, -1, 1, -1];
  const DW = [5, 5, 5, 5, 7, 7, 7, 7];
  for (let d = 0; pending > 0; d++) {
    const bucket = buckets[d & 7];
    while (bucket.length) {
      const i = bucket.pop()!;
      pending--;
      if (dist[i] !== d) continue;
      const x = i % w;
      const y = (i - x) / w;
      for (let k = 0; k < 8; k++) {
        const nx = x + DX[k];
        const ny = y + DY[k];
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (!passable[j]) continue;
        const nd = d + DW[k];
        if (nd > limit || nd >= dist[j]) continue;
        dist[j] = nd;
        label[j] = label[i];
        buckets[nd & 7].push(j);
        pending++;
      }
    }
  }
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = label[i] >= 0 ? dist[i] / 5 : Infinity;
  return { label, dist: out };
}
