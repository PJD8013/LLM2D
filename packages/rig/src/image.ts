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

/** Composites visible layers (normal blending only) onto a canvas, bottom layer first. */
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
