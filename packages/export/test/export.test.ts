import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SkeletonData, validate, type L2DFile } from '@llm2d/core';
import { createImage, decodePng, encodePng, type RGBAImage } from '@llm2d/rig';
import { MaxRects, exportSkeleton, packAtlas, resample } from '../src/index.ts';

const root = join(import.meta.dirname, '../../..');

describe('MaxRects', () => {
  it('places rectangles without overlap inside the bin', () => {
    const bin = new MaxRects(256, 256);
    const placed = [];
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 60; i++) {
      const r = bin.insert(8 + Math.floor(rnd() * 40), 8 + Math.floor(rnd() * 40));
      if (r) placed.push(r);
    }
    expect(placed.length).toBeGreaterThan(20);
    for (const r of placed) {
      expect(r.x + r.w).toBeLessThanOrEqual(256);
      expect(r.y + r.h).toBeLessThanOrEqual(256);
    }
    for (let i = 0; i < placed.length; i++)
      for (let j = i + 1; j < placed.length; j++) {
        const a = placed[i];
        const b = placed[j];
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap).toBe(false);
      }
  });
});

describe('resample', () => {
  it('keeps colour under transparent edges (premultiplied averaging)', () => {
    const img = createImage(4, 4);
    for (let i = 0; i < 16; i++) img.data.set(i % 2 ? [255, 0, 0, 255] : [0, 0, 0, 0], i * 4);
    const half = resample(img, 0.5);
    expect([half.width, half.height]).toEqual([2, 2]);
    expect(Array.from(half.data.slice(0, 4))).toEqual([255, 0, 0, 128]);
  });
});

describe('packAtlas', () => {
  it('packs the kit sample into one page with exact pixels and valid frames', async () => {
    const path = join(root, 'samples/kit/kit.l2d.json');
    const file = JSON.parse(readFileSync(path, 'utf8')) as L2DFile;
    const load = async (p: string) => readFileSync(join(root, 'samples/kit', p));
    const atlas = await packAtlas(file, load);
    expect(Object.keys(atlas.pages)).toEqual(['kit.png']);
    expect(validate(atlas.file).ok).toBe(true);
    SkeletonData.fromJSON(atlas.file);
    const page = decodePng(atlas.pages['kit.png']);
    const frames = Object.entries(atlas.file.images).map(([name, img]) => ({ name, ...img.frame! }));
    // Frames do not overlap and stay inside the page.
    for (const f of frames) {
      expect(f.x + f.width).toBeLessThanOrEqual(page.width);
      expect(f.y + f.height).toBeLessThanOrEqual(page.height);
    }
    for (let i = 0; i < frames.length; i++)
      for (let j = i + 1; j < frames.length; j++) {
        const a = frames[i];
        const b = frames[j];
        expect(a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height).toBe(false);
      }
    // Pixels inside each frame equal the source image.
    for (const f of frames) {
      const src = decodePng(await load(file.images[f.name].path));
      for (const [x, y] of [[0, 0], [src.width >> 1, src.height >> 1], [src.width - 1, src.height - 1]]) {
        const si = (y * src.width + x) * 4;
        const pi = ((f.y + y) * page.width + f.x + x) * 4;
        expect(Array.from(page.data.slice(pi, pi + 4))).toEqual(Array.from(src.data.slice(si, si + 4)));
      }
    }
    // Logical sizes are unchanged.
    for (const [name, img] of Object.entries(atlas.file.images)) {
      expect(img.width).toBe(file.images[name].width);
      expect(img.height).toBe(file.images[name].height);
    }
  });

  it('spreads over several pages when the page size is small, and re-packs an atlased file', async () => {
    const solid = (w: number, h: number): RGBAImage => {
      const img = createImage(w, h);
      img.data.fill(200);
      return img;
    };
    const images = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`p${i}`, { path: `p${i}.png`, width: 100, height: 100 }]));
    const file = { format: 'llm2d', version: '0.1', name: 'multi', images, bones: [{ name: 'root' }], slots: [], attachments: {}, animations: {} } as L2DFile;
    const atlas = await packAtlas(file, async () => encodePng(solid(200, 200)), { maxSize: 512 });
    expect(Object.keys(atlas.pages).length).toBeGreaterThan(1);
    const again = await packAtlas(atlas.file, async (p) => atlas.pages[p], { maxSize: 1024 });
    expect(Object.keys(again.pages)).toEqual(['multi.png']);
    expect(validate(again.file).ok).toBe(true);
  });
});

describe('exportSkeleton', () => {
  it('writes a minified skeleton and an atlas, optionally at half resolution', async () => {
    const dest = mkdtempSync(join(tmpdir(), 'llm2d-export-'));
    const full = await exportSkeleton(join(root, 'samples/bolt/bolt.l2d.json'), dest);
    const json = readFileSync(join(full.dir, 'bolt.l2d.json'), 'utf8');
    expect(json.includes('\n  ')).toBe(false);
    expect(validate(JSON.parse(json)).ok).toBe(true);
    const half = await exportSkeleton(join(root, 'samples/bolt/bolt.l2d.json'), join(dest, 'half'), { scale: 0.5 });
    expect(half.pages[0].width).toBeLessThan(full.pages[0].width);
  });
});
