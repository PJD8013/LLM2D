import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  composite,
  createImage,
  growLabels,
  parseColor,
  readPicture,
  readPsd,
  removeBackground,
  segmentArt,
  splitArt,
  type RGBAImage,
  type SplitFile,
} from '../src/index.ts';

const root = join(import.meta.dirname, '../../..');

type RGB = [number, number, number];
const OUT: RGB = [40, 30, 25];
const BACK: RGB = [230, 120, 40];
const FRONT: RGB = [40, 140, 200];

/**
 * A flat test picture on white: an outlined orange disc (back, centre 100,100, radius 70) with
 * an outlined blue bar (front, x 88..112) standing across its middle, drawn with 6 px outlines
 * and 2x2 supersampling for soft edges.
 */
function picture(): RGBAImage {
  const w = 240;
  const h = 200;
  const img = createImage(w, h);
  const disc = (x: number, y: number) => Math.hypot(x - 100, y - 100);
  const bar = (x: number, y: number) => Math.max(Math.abs(x - 100) - 12, Math.abs(y - 100) - 90);
  const colorAt = (x: number, y: number): RGB => {
    const b = bar(x, y);
    if (b <= 0) return b > -6 ? OUT : FRONT;
    const d = disc(x, y);
    if (d <= 70) return d > 64 ? OUT : BACK;
    return [255, 255, 255];
  };
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0];
      for (const [sx, sy] of [
        [0.25, 0.25],
        [0.75, 0.25],
        [0.25, 0.75],
        [0.75, 0.75],
      ]) {
        const c = colorAt(x + sx, y + sy);
        for (let k = 0; k < 3; k++) acc[k] += c[k] / 4;
      }
      img.data.set([...acc.map(Math.round), 255], (y * w + x) * 4);
    }
  return img;
}

describe('flat picture split', () => {
  it('removes a white background with soft edges', () => {
    const { image, color } = removeBackground(picture());
    expect(color).toEqual([255, 255, 255]);
    const at = (x: number, y: number) => image.data[(y * image.width + x) * 4 + 3];
    expect(at(5, 5)).toBe(0);
    expect(at(100, 100)).toBe(255);
    // Pixels the disc's edge crosses get partial alpha.
    let soft = 0;
    for (let i = 3; i < image.data.length; i += 4) if (image.data[i] > 0 && image.data[i] < 255) soft++;
    expect(soft).toBeGreaterThan(100);
  });

  it('finds the colour regions and the outline', () => {
    const { image } = removeBackground(picture());
    const seg = segmentArt(image);
    expect(seg.outline).not.toBeNull();
    expect(seg.outline!.width).toBeGreaterThan(4);
    expect(seg.outline!.width).toBeLessThan(11);
    // Two halves of the disc and the bar.
    expect(seg.regions.map((r) => r.color).sort()).toEqual(['#288cc8', '#e67828', '#e67828']);
    const bar = seg.regions.find((r) => r.color === '#288cc8')!;
    expect(bar.neighbors).toHaveLength(2);
    expect(seg.labels[100 * image.width + 33]).toBe(-1); // on the disc's outline
  });

  it('splits losslessly, gives the shared outline to the front and rebuilds the hidden disc', () => {
    const { image } = removeBackground(picture());
    const seg = segmentArt(image);
    const result = splitArt(image, seg, {
      parts: [
        { name: 'disc', regions: [[60, 100], [140, 100]] },
        { name: 'bar', regions: [[100, 100]] },
      ],
    });
    expect(result.report.difference).toBe(0);
    expect(result.art.layers.map((l) => l.name)).toEqual(['disc', 'bar']);
    const [disc] = result.art.layers;
    const px = (x: number, y: number) => {
      const i = ((y - disc.y) * disc.image.width + x - disc.x) * 4;
      return x < disc.x || y < disc.y || x >= disc.x + disc.image.width || y >= disc.y + disc.image.height ? [0, 0, 0, 0] : [...disc.image.data.slice(i, i + 4)];
    };
    // The bar's outline (x 88..94) belongs to the bar, which is in front.
    expect(result.owner[100 * image.width + 91]).toBe(1);
    // Under the bar the disc is bridged in its own colour ...
    expect(px(100, 100)).toEqual([...BACK, 255]);
    // ... its outline continues along the rebuilt edge (the disc's top is at y = 30) ...
    expect(px(100, 33)[0]).toBeLessThan(120);
    // ... and nothing is added outside the disc.
    expect(px(100, 22)[3]).toBe(0);
    expect(result.report.parts[0].filled).toBeGreaterThan(2500);
    expect(result.report.parts[1].filled).toBe(0);
  });

  it('joins small enclosed regions, reports unassigned ones and supports polygons', () => {
    const { image } = removeBackground(picture());
    const seg = segmentArt(image);
    expect(() => splitArt(image, seg, { parts: [{ name: 'disc', regions: [[60, 100], [140, 100]] }] })).toThrow(/Regions not in any part: \d+/);
    const rest = splitArt(image, seg, { parts: [{ name: 'disc', regions: [[60, 100], [140, 100]] }, { name: 'other', rest: true }] });
    expect(rest.report.parts[1].auto).toHaveLength(1);
    const cut = splitArt(image, seg, {
      parts: [
        { name: 'disc', regions: [[60, 100], [140, 100]] },
        { name: 'bar', regions: [[100, 100]] },
        { name: 'top', polygon: [[80, 5], [120, 5], [120, 40], [80, 40]] },
      ],
    });
    expect(cut.report.difference).toBe(0);
    expect(cut.owner[20 * image.width + 100]).toBe(2);
    expect(() => splitArt(image, seg, { parts: [{ name: 'a b', regions: [1] }] })).toThrow(/Part name/);
    expect(() => splitArt(image, seg, { parts: [{ name: 'a', regions: [99] }] })).toThrow(/no region 99/);
  });

  it('grows labels geodesically within passable pixels', () => {
    const w = 5;
    const seeds = new Int32Array(25).fill(-1);
    seeds[0] = 7;
    const pass = new Uint8Array(25).fill(1);
    pass[12] = 0;
    const { label, dist } = growLabels(seeds, pass, w, 5, 2);
    expect(label[2]).toBe(7);
    expect(dist[2]).toBe(2);
    expect(label[3]).toBe(-1);
    expect(label[12]).toBe(-1);
    expect(parseColor('#fa0')).toEqual([255, 170, 0]);
  });

  it('splits the flattened Kit fox close to the artist layers', { timeout: 120_000 }, () => {
    const truth = readPsd(readFileSync(join(root, 'samples/kit/source/kit.psd')));
    const flat = composite(truth.layers, truth.width, truth.height);
    // On white, opaque, like a picture from an image generator.
    for (let i = 0; i < flat.data.length; i += 4) {
      const a = flat.data[i + 3] / 255;
      for (let c = 0; c < 3; c++) flat.data[i + c] = Math.round(flat.data[i + c] * a + 255 * (1 - a));
      flat.data[i + 3] = 255;
    }
    const spec: SplitFile = JSON.parse(readFileSync(join(root, 'samples/kit-flat/split.json'), 'utf8'));
    const { image, segmentation } = readPicture(flat, spec);
    const result = splitArt(image, segmentation, spec);
    expect(result.report.difference).toBe(0);

    // Visible pixels of each original layer vs the split's parts.
    const W = truth.width;
    const visible = new Int16Array(W * truth.height).fill(-1);
    truth.layers.forEach((l, li) => {
      if (l.hidden) return;
      for (let y = 0; y < l.image.height; y++)
        for (let x = 0; x < l.image.width; x++)
          if (l.image.data[(y * l.image.width + x) * 4 + 3] >= 128) visible[(y + l.y) * W + x + l.x] = li;
    });
    const iou: Record<string, number> = {};
    spec.parts.forEach((p, pi) => {
      const li = truth.layers.findIndex((l) => l.name === p.name);
      let inter = 0;
      let union = 0;
      for (let i = 0; i < visible.length; i++) {
        const a = visible[i] === li;
        const b = result.owner[i] === pi && image.data[i * 4 + 3] >= 128;
        if (a && b) inter++;
        if (a || b) union++;
      }
      iou[p.name] = inter / union;
    });
    for (const name of ['tail', 'ear_l', 'ear_r', 'arm_l', 'arm_r', 'leg_l', 'leg_r', 'body', 'scarf', 'head']) expect(iou[name], name).toBeGreaterThan(0.93);
    // Eyes and mouth are small, so their anti-aliased rims weigh more.
    expect(iou.eyes).toBeGreaterThan(0.8);
    expect(iou.mouth).toBeGreaterThan(0.5);
  });
});
