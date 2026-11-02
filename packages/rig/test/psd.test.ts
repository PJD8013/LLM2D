import { describe, expect, it } from 'vitest';
import { writePsdBuffer, type Layer as PsdLayer } from 'ag-psd';
import { readPsd, type RGBAImage } from '../src/index.ts';

/** A w x h image filled with one colour. */
function fill(w: number, h: number, [r, g, b, a]: number[]): { width: number; height: number; data: Uint8ClampedArray } {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) data.set([r, g, b, a], i * 4);
  return { width: w, height: h, data };
}

/** A grey mask image (R channel carries the grey) from a function of (x, y). */
function mask(w: number, h: number, grey: (x: number, y: number) => number) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([grey(x, y), 0, 0, 255], (y * w + x) * 4);
  return { width: w, height: h, data };
}

const layer = (name: string, left: number, top: number, img: ReturnType<typeof fill>, extra: Partial<PsdLayer> = {}): PsdLayer => ({
  name,
  left,
  top,
  right: left + img.width,
  bottom: top + img.height,
  imageData: img,
  ...extra,
});

const psd = (children: PsdLayer[]) => new Uint8Array(writePsdBuffer({ width: 40, height: 40, children }, { generateThumbnail: false }));
const px = (img: RGBAImage, x: number, y: number) => [...img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];

/** A minimal 16-bit RGB PSD with one full-canvas layer of one colour (values 0..65535). */
function psd16(w: number, h: number, rgba16: [number, number, number, number]): Uint8Array {
  const bytes: number[] = [];
  const u8 = (v: number) => bytes.push(v & 255);
  const u16 = (v: number) => (u8(v >> 8), u8(v));
  const u32 = (v: number) => (u16(v >>> 16), u16(v & 0xffff));
  const str = (s: string) => [...s].forEach((c) => u8(c.charCodeAt(0)));
  str('8BPS'), u16(1), bytes.push(0, 0, 0, 0, 0, 0), u16(4), u32(h), u32(w), u16(16), u16(3);
  u32(0); // colour mode data
  u32(0); // image resources
  const channel = 2 + w * h * 2;
  const record = 16 + 2 + 4 * 6 + 12 + 4 + 4 + 4 + 4; // bounds, count, channels, blend..filler, extra (masks, ranges, name)
  let layerInfo = 2 + record + 4 * channel;
  layerInfo += layerInfo % 2;
  u32(4 + layerInfo + 4); // layer and mask section
  u32(layerInfo);
  u16(1);
  u32(0), u32(0), u32(h), u32(w), u16(4);
  for (const id of [0xffff, 0, 1, 2]) u16(id), u32(channel);
  str('8BIM'), str('norm'), u8(255), u8(0), u8(0), u8(0);
  u32(12), u32(0), u32(0), u8(3), str('top'); // extra: no mask, no blending ranges, name "top" (4 bytes)
  for (const c of [3, 0, 1, 2]) {
    u16(0);
    for (let i = 0; i < w * h; i++) u16(rgba16[c]);
  }
  if ((2 + record + 4 * channel) % 2) u8(0);
  u32(0); // global layer mask info
  u16(0); // merged image, raw
  for (const c of [0, 1, 2, 3]) for (let i = 0; i < w * h; i++) u16(rgba16[c]);
  return new Uint8Array(bytes);
}

describe('PSD import', () => {
  it('applies layer masks, including the colour outside the mask', () => {
    const art = readPsd(
      psd([
        // Left half shown, right half masked out.
        layer('half', 0, 0, fill(20, 20, [255, 0, 0, 255]), { mask: { left: 0, top: 0, right: 20, bottom: 20, imageData: mask(20, 20, (x) => (x < 10 ? 255 : 0)) } }),
        // Mask smaller than the layer; outside it the default colour (white = shown) applies; inside half strength.
        layer('soft', 20, 20, fill(20, 20, [0, 0, 255, 255]), { mask: { left: 20, top: 20, right: 30, bottom: 30, defaultColor: 255, imageData: mask(10, 10, () => 128) } }),
      ]),
    );
    const [half, soft] = art.layers;
    expect([half.x, half.image.width, half.image.height]).toEqual([0, 10, 20]);
    expect(px(half.image, 5, 5)).toEqual([255, 0, 0, 255]);
    expect(px(soft.image, 2, 2)[3]).toBe(128);
    expect(px(soft.image, 15, 15)[3]).toBe(255);
    expect(art.warnings).toEqual([]);
  });

  it('paints clipped layers into the layer below, keeping its shape', () => {
    const art = readPsd(
      psd([
        layer('body', 10, 10, fill(10, 10, [200, 100, 50, 255])),
        // A shadow bigger than the body, clipped to it with multiply at half opacity.
        layer('shadow', 0, 0, fill(40, 40, [0, 0, 0, 255]), { clipping: true, blendMode: 'multiply', opacity: 0.5 }),
        layer('light', 15, 10, fill(5, 10, [255, 255, 255, 255]), { clipping: true, blendMode: 'screen' }),
      ]),
    );
    expect(art.layers.map((l) => l.name)).toEqual(['body']);
    const body = art.layers[0];
    expect([body.x, body.y, body.image.width, body.image.height]).toEqual([10, 10, 10, 10]);
    expect(px(body.image, 0, 0)).toEqual([100, 50, 25, 255]); // half-way to black
    expect(px(body.image, 7, 5)).toEqual([255, 255, 255, 255]); // screened white
  });

  it('carries group visibility, opacity and masks to the layers inside', () => {
    const art = readPsd(
      psd([
        {
          name: 'arm',
          opacity: 0.5,
          mask: { left: 0, top: 0, right: 40, bottom: 40, imageData: mask(40, 40, (_x, y) => (y < 20 ? 255 : 0)) },
          children: [layer('upper', 0, 0, fill(10, 40, [10, 20, 30, 255]), { opacity: 0.8 })],
        },
        { name: 'alt', hidden: true, children: [layer('fist', 0, 0, fill(5, 5, [1, 2, 3, 255]))] },
      ]),
    );
    const [upper, fist] = art.layers;
    expect(upper.name).toBe('arm/upper');
    expect(upper.opacity).toBeCloseTo(0.4, 2);
    expect(upper.image.height).toBe(20);
    expect([fist.name, fist.hidden]).toEqual(['alt/fist', true]);
  });

  it('reads 16-bit documents as 8-bit colour', () => {
    const art = readPsd(psd16(4, 3, [65535, 32896, 0, 65535]));
    expect(art.layers).toHaveLength(1);
    expect(px(art.layers[0].image, 1, 1)).toEqual([255, 128, 0, 255]);
  });

  it('explains how to fix a CMYK document', () => {
    const cmyk = psd16(2, 2, [0, 0, 0, 65535]);
    cmyk[25] = 4; // colour mode: CMYK
    expect(() => readPsd(cmyk)).toThrow(/RGB colour mode/);
  });
});
