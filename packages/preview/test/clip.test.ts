/**
 * Clipping attachments end to end: validation, compiling, the rig spec "clip" option, and the
 * PixiJS runtime drawing clipped slots only inside the polygon (rendered in Chromium).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { SkeletonData, validate, type L2DFile } from '@llm2d/core';
import { buildRig, createImage, decodePng, encodePng, readPsd, type RigSpec } from '@llm2d/rig';
import { Previewer } from '../src/index.ts';

const root = join(import.meta.dirname, '../../..');

/** A white 100x100 box centred on the origin, with a clip polygon over its left half. */
function clipped(): L2DFile {
  return {
    format: 'llm2d',
    version: '0.1',
    name: 'clip',
    images: { box: { path: 'box.png', width: 100, height: 100 } },
    bones: [{ name: 'root' }],
    slots: [
      { name: 'mask', bone: 'root', attachment: 'mask' },
      { name: 'box', bone: 'root', attachment: 'box' },
      { name: 'after', bone: 'root', attachment: 'box' },
    ],
    attachments: {
      mask: { mask: { type: 'clipping', vertices: [-50, -50, 0, -50, 0, 50, -50, 50], end: 'box' } },
      box: { box: { type: 'region', image: 'box', x: 0, y: 0 } },
      after: { box: { type: 'region', image: 'box', x: 0, y: 0, scaleX: 0.2, scaleY: 0.2 } },
    },
    animations: {},
  };
}

let previewer: Previewer | null = null;
afterAll(async () => previewer?.close());

describe('clipping', () => {
  it('validates and compiles clipping polygons', () => {
    expect(validate(clipped()).ok).toBe(true);
    const data = SkeletonData.fromJSON(clipped());
    const mask = data.attachments[0][0];
    expect([mask.kind, mask.clipEnd, mask.vertexCount]).toEqual(['clipping', 1, 4]);
    // The polygon does not count for the framing.
    expect(data.bounds).toEqual({ x: -50, y: -50, width: 100, height: 100 });

    const before = clipped();
    (before.attachments.mask.mask as { end: string }).end = 'mask';
    expect(validate(before).errors.map((e) => e.path)).toContain('attachments.mask.mask.end');
    const overlap = clipped();
    overlap.attachments.box.cut = { type: 'clipping', vertices: [0, 0, 10, 0, 0, 10] };
    expect(validate(overlap).errors.some((e) => /overlap/.test(e.message))).toBe(true);
  });

  it('draws the clipped slots only inside the polygon', { timeout: 120_000 }, async () => {
    const white = createImage(100, 100);
    white.data.fill(255);
    previewer = new Previewer();
    await previewer.load(clipped(), { 'box.png': encodePng(white) });
    const img = decodePng(await previewer.frame(null, 0, { size: 400, background: 'dark' }));
    const at = (fx: number, fy: number) => {
      const i = (Math.round(img.height * fy) * img.width + Math.round(img.width * fx)) * 4;
      return img.data[i] + img.data[i + 1] + img.data[i + 2];
    };
    expect(at(0.3, 0.3)).toBeGreaterThan(600); // left half of the box: inside the clip
    expect(at(0.7, 0.3)).toBeLessThan(200); // right half: clipped away
    expect(at(0.5, 0.5)).toBeGreaterThan(600); // the slot after the range is not clipped
  });

  it('clips a part to another layer with the rig spec', () => {
    const art = readPsd(readFileSync(join(root, 'samples/coin/source/coin.psd')));
    const spec = JSON.parse(readFileSync(join(root, 'samples/coin/rig.json'), 'utf8')) as RigSpec;
    spec.parts!.shine.clip = 'coin';
    const { file } = buildRig(art, spec);
    const names = file.slots.map((s) => s.name);
    expect(names.indexOf('shine_clip')).toBe(names.indexOf('shine') - 1);
    const clip = file.attachments.shine_clip.shine_clip;
    expect(clip.type).toBe('clipping');
    expect(clip.type === 'clipping' && clip.end).toBe('shine');
    expect(clip.type === 'clipping' && clip.vertices.length).toBeGreaterThan(30);
    expect(validate(file).ok).toBe(true);
  });
});
