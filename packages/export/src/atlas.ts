import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { L2DFile, L2DImage } from '@llm2d/core';
import { createImage, crop, decodePng, encodePng, type RGBAImage } from '@llm2d/rig';
import { MaxRects } from './maxrects.ts';

export interface AtlasOptions {
  /** Largest page side in pixels. Default 2048 (safe on every device). */
  maxSize?: number;
  /** Gap between images, in pixels. Default 4. */
  padding?: number;
  /** Repeat edge pixels this far into the gap so filtering at the edges matches a standalone texture. Default 2. */
  extrude?: number;
  /** Resample images by this factor (0.5 = half resolution for mobile). Default 1. */
  scale?: number;
  /** Page file name stem; pages are <stem>.png, <stem>-2.png, ... Default: the skeleton name. */
  pageName?: string;
}

export interface AtlasResult {
  /** The skeleton with images pointing at atlas pages (frames set). */
  file: L2DFile;
  /** Page file name -> PNG bytes. */
  pages: Record<string, Buffer>;
  report: { images: number; pages: { name: string; width: number; height: number; fill: number }[] };
}

/** Area-averaging resample with premultiplied alpha (no dark fringes on transparent edges). */
export function resample(img: RGBAImage, scale: number): RGBAImage {
  if (scale === 1) return img;
  const w = Math.max(1, Math.round(img.width * scale));
  const h = Math.max(1, Math.round(img.height * scale));
  const out = createImage(w, h);
  const sx = img.width / w;
  const sy = img.height / h;
  for (let y = 0; y < h; y++) {
    const y0 = y * sy;
    const y1 = y0 + sy;
    for (let x = 0; x < w; x++) {
      const x0 = x * sx;
      const x1 = x0 + sx;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let area = 0;
      for (let yy = Math.floor(y0); yy < Math.ceil(y1) && yy < img.height; yy++) {
        const wy = Math.min(y1, yy + 1) - Math.max(y0, yy);
        if (wy <= 0) continue;
        for (let xx = Math.floor(x0); xx < Math.ceil(x1) && xx < img.width; xx++) {
          const wx = Math.min(x1, xx + 1) - Math.max(x0, xx);
          if (wx <= 0) continue;
          const k = wx * wy;
          const i = (yy * img.width + xx) * 4;
          const al = img.data[i + 3] / 255;
          r += img.data[i] * al * k;
          g += img.data[i + 1] * al * k;
          b += img.data[i + 2] * al * k;
          a += al * k;
          area += k;
        }
      }
      const o = (y * w + x) * 4;
      if (a > 0) {
        out.data[o] = Math.round(r / a);
        out.data[o + 1] = Math.round(g / a);
        out.data[o + 2] = Math.round(b / a);
      }
      out.data[o + 3] = Math.round((a / area) * 255);
    }
  }
  return out;
}

const pow2 = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(1, n)));

/**
 * Packs every image of a skeleton into as few atlas pages as possible. `load` returns the
 * PNG bytes for a path in the file (images that already have frames are cut out first).
 */
export async function packAtlas(file: L2DFile, load: (path: string) => Promise<Uint8Array>, options: AtlasOptions = {}): Promise<AtlasResult> {
  const maxSize = options.maxSize ?? 2048;
  const pad = options.padding ?? 4;
  const extrude = Math.min(options.extrude ?? 2, pad);
  const scale = options.scale ?? 1;
  const stem = options.pageName ?? file.name;

  const decoded = new Map<string, RGBAImage>();
  const source = async (img: L2DImage): Promise<RGBAImage> => {
    let page = decoded.get(img.path);
    if (!page) {
      page = decodePng(await load(img.path));
      decoded.set(img.path, page);
    }
    return img.frame ? crop(page, img.frame.x, img.frame.y, img.frame.width, img.frame.height) : page;
  };
  const items = await Promise.all(
    Object.entries(file.images).map(async ([name, img]) => ({ name, img, pixels: resample(await source(img), scale) })),
  );
  for (const it of items)
    if (it.pixels.width + pad * 2 > maxSize || it.pixels.height + pad * 2 > maxSize)
      throw new Error(`Image "${it.name}" (${it.pixels.width}x${it.pixels.height}) does not fit a ${maxSize}px page; raise maxSize or lower scale`);
  // Big first packs tighter.
  items.sort((a, b) => Math.max(b.pixels.width, b.pixels.height) - Math.max(a.pixels.width, a.pixels.height) || b.pixels.width * b.pixels.height - a.pixels.width * a.pixels.height);

  // Fill pages one at a time; each page starts at the smallest power-of-two square that could
  // hold the remaining area and grows until everything fits or it reaches maxSize.
  type Placed = { name: string; img: L2DImage; pixels: RGBAImage; x: number; y: number };
  const pages: { width: number; height: number; placed: Placed[] }[] = [];
  let rest = items;
  while (rest.length) {
    const area = rest.reduce((s, it) => s + (it.pixels.width + pad * 2) * (it.pixels.height + pad * 2), 0);
    const widest = Math.max(...rest.map((it) => it.pixels.width + pad * 2));
    const tallest = Math.max(...rest.map((it) => it.pixels.height + pad * 2));
    let w = Math.min(maxSize, Math.max(pow2(Math.sqrt(area)), pow2(widest)));
    let h = Math.min(maxSize, Math.max(w / 2, pow2(tallest)));
    for (;;) {
      const bin = new MaxRects(w, h);
      const placed: Placed[] = [];
      const left: typeof rest = [];
      for (const it of rest) {
        const r = bin.insert(it.pixels.width + pad * 2, it.pixels.height + pad * 2);
        if (r) placed.push({ ...it, x: r.x + pad, y: r.y + pad });
        else left.push(it);
      }
      if (!left.length || (w >= maxSize && h >= maxSize)) {
        if (!placed.length) throw new Error('Atlas packing made no progress');
        pages.push({ width: w, height: h, placed });
        rest = left;
        break;
      }
      // Grow the shorter side, never past maxSize (which need not be a power of two).
      if (h < w || w >= maxSize) h = Math.min(maxSize, h * 2);
      else w = Math.min(maxSize, w * 2);
    }
  }

  const out: AtlasResult = { file: structuredClone(file), pages: {}, report: { images: items.length, pages: [] } };
  pages.forEach((p, i) => {
    const name = `${stem}${i ? `-${i + 1}` : ''}.png`;
    // Shrink to the used area (rounded up to a multiple of 4 for GPU friendliness).
    const usedW = Math.min(p.width, Math.ceil((Math.max(...p.placed.map((q) => q.x + q.pixels.width)) + pad) / 4) * 4);
    const usedH = Math.min(p.height, Math.ceil((Math.max(...p.placed.map((q) => q.y + q.pixels.height)) + pad) / 4) * 4);
    const canvas = createImage(usedW, usedH);
    let fill = 0;
    for (const q of p.placed) {
      blit(canvas, q.pixels, q.x, q.y, extrude);
      fill += q.pixels.width * q.pixels.height;
      out.file.images[q.name] = {
        path: name,
        width: q.img.width,
        height: q.img.height,
        frame: { x: q.x, y: q.y, width: q.pixels.width, height: q.pixels.height },
      };
    }
    out.pages[name] = encodePng(canvas);
    out.report.pages.push({ name, width: usedW, height: usedH, fill: fill / (usedW * usedH) });
  });
  return out;
}

/** Copies `src` into `dst` at (x, y) and repeats its edge pixels `extrude` pixels outward. */
function blit(dst: RGBAImage, src: RGBAImage, x: number, y: number, extrude: number) {
  for (let row = -extrude; row < src.height + extrude; row++) {
    const sy = Math.min(src.height - 1, Math.max(0, row));
    const dy = y + row;
    if (dy < 0 || dy >= dst.height) continue;
    for (let col = -extrude; col < src.width + extrude; col++) {
      const sx = Math.min(src.width - 1, Math.max(0, col));
      const dx = x + col;
      if (dx < 0 || dx >= dst.width) continue;
      const si = (sy * src.width + sx) * 4;
      const di = (dy * dst.width + dx) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = src.data[si + 3];
    }
  }
}

/** Reads a `.l2d.json` from disk and packs its images. */
export async function packAtlasFromFile(path: string, options: AtlasOptions = {}): Promise<AtlasResult> {
  const file = JSON.parse(await readFile(path, 'utf8')) as L2DFile;
  return packAtlas(file, (p) => readFile(join(dirname(path), p)), options);
}
