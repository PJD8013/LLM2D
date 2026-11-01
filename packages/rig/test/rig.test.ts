import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SkeletonData, bendTest, validate } from '@llm2d/core';
import {
  buildMesh,
  buildRig,
  chainJoints,
  components,
  computeWeights,
  createImage,
  pointInPolygon,
  readPsd,
  signedArea,
  simplifyClosed,
  traceBoundary,
  writePsd,
  type Layer,
  type Pt,
  type RGBAImage,
  type RigSpec,
} from '../src/index.ts';

const root = join(import.meta.dirname, '../../..');

/** Image with an opaque shape where `inside(x, y)` is true. */
function shape(w: number, h: number, inside: (x: number, y: number) => boolean): RGBAImage {
  const img = createImage(w, h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (inside(x + 0.5, y + 0.5)) {
        const i = (y * w + x) * 4;
        img.data.set([200, 100, 50, 255], i);
      }
  return img;
}

/** Horizontal capsule from (20, 30) to (180, 30), radius 16, in a 200x60 image. */
const capsule = () =>
  shape(200, 60, (x, y) => {
    const cx = Math.max(20, Math.min(180, x));
    return Math.hypot(x - cx, y - 30) <= 16;
  });

describe('contour', () => {
  it('traces the outline of a rectangle clockwise', () => {
    const w = 20;
    const h = 10;
    const mask = new Uint8Array(w * h);
    for (let y = 2; y < 8; y++) for (let x = 3; x < 15; x++) mask[y * w + x] = 1;
    const { labels, list } = components(mask, w, h);
    expect(list).toHaveLength(1);
    const outline = traceBoundary(labels, w, h, list[0]);
    expect(outline).toHaveLength(2 * (12 + 6) - 4);
    const xs = outline.map((p) => p[0]);
    const ys = outline.map((p) => p[1]);
    expect([Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)]).toEqual([3, 14, 2, 7]);
    expect(signedArea(outline)).toBeGreaterThan(0); // clockwise on screen = positive in y-down
  });

  it('simplifies within tolerance', () => {
    const circle: Pt[] = Array.from({ length: 200 }, (_, i) => [50 + 40 * Math.cos((i / 200) * Math.PI * 2), 50 + 40 * Math.sin((i / 200) * Math.PI * 2)]);
    const s = simplifyClosed(circle, 1);
    expect(s.length).toBeLessThan(40);
    expect(s.length).toBeGreaterThan(8);
  });
});

describe('mesh', () => {
  it('covers the art with valid, non-degenerate triangles inside the outline', () => {
    const img = capsule();
    const m = buildMesh(img, { spacing: 10 });
    expect(m.warnings).toEqual([]);
    expect(m.hull).toBeGreaterThan(10);
    expect(m.points.length).toBeGreaterThan(m.hull);
    const n = m.points.length;
    for (const i of m.triangles) expect(i).toBeLessThan(n);
    for (let i = 0; i < m.triangles.length; i += 3) {
      const [a, b, c] = [m.points[m.triangles[i]], m.points[m.triangles[i + 1]], m.points[m.triangles[i + 2]]];
      const area = (b[0] - a[0]) * (c[1] - a[1]) - (c[0] - a[0]) * (b[1] - a[1]);
      expect(Math.abs(area)).toBeGreaterThan(1e-6);
      expect(pointInPolygon((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, m.outline)).toBe(true);
    }
    for (const [x, y] of m.points) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(img.width);
      expect(y).toBeLessThanOrEqual(img.height);
    }
    // Every opaque pixel centre is covered by some triangle.
    const covered = (px: number, py: number) => {
      for (let i = 0; i < m.triangles.length; i += 3) {
        const [a, b, c] = [m.points[m.triangles[i]], m.points[m.triangles[i + 1]], m.points[m.triangles[i + 2]]];
        if (pointInPolygon(px, py, [a, b, c])) return true;
      }
      return false;
    };
    for (const [x, y] of [[20, 30], [100, 30], [180, 30], [100, 17], [100, 43], [8, 30], [192, 30]] as Pt[])
      expect(covered(x, y), `(${x}, ${y})`).toBe(true);
  });
});

describe('chain', () => {
  it('places evenly spaced joints along the middle of a shape', () => {
    const joints = chainJoints(capsule(), 4, [24, 30]);
    expect(joints).toHaveLength(5);
    expect(joints[0]).toEqual([24, 30]);
    for (const [, y] of joints) expect(Math.abs(y - 30)).toBeLessThan(3);
    // The tip reaches the far end of the capsule.
    expect(joints[4][0]).toBeGreaterThan(185);
    const steps = joints.slice(1).map((p, i) => p[0] - joints[i][0]);
    for (const s of steps) expect(Math.abs(s - steps[0])).toBeLessThan(4);
  });
});

describe('weights', () => {
  it('follows the nearest bone and blends only around the joint', () => {
    const img = capsule();
    const m = buildMesh(img, { spacing: 10 });
    const bones = [
      { x1: 20, y1: 30, x2: 100, y2: 30 },
      { x1: 100, y1: 30, x2: 180, y2: 30 },
    ];
    const w = computeWeights(m.points, m.triangles, bones, m.spacing);
    expect(w).toHaveLength(m.points.length);
    m.points.forEach(([x], i) => {
      const pairs = w[i];
      let sum = 0;
      let first = 0;
      for (let k = 0; k < pairs.length; k += 2) {
        sum += pairs[k + 1];
        if (pairs[k] === 0) first = pairs[k + 1];
      }
      expect(Math.abs(sum - 1)).toBeLessThan(1e-3);
      if (x < 60) expect(first).toBeGreaterThan(0.95);
      if (x > 140) expect(first).toBeLessThan(0.05);
      if (Math.abs(x - 100) < 3) expect(first).toBeGreaterThan(0.2), expect(first).toBeLessThan(0.8);
    });
  });
});

describe('psd', () => {
  it('round-trips layers through a PSD', () => {
    const a = capsule();
    const b = shape(30, 20, (x, y) => (x - 15) ** 2 + (y - 10) ** 2 < 64);
    const layers: Layer[] = [
      { name: 'body', x: 10, y: 20, image: a, hidden: false, opacity: 1, blend: 'normal' },
      { name: 'glow', x: 50, y: 5, image: b, hidden: true, opacity: 0.5, blend: 'add' },
    ];
    const art = readPsd(writePsd({ width: 300, height: 120, layers }));
    expect(art.width).toBe(300);
    expect(art.layers.map((l) => [l.name, l.hidden, l.blend])).toEqual([
      ['body', false, 'normal'],
      ['glow', true, 'add'],
    ]);
    const body = art.layers[0];
    // The PSD stores the opaque bounds; pixels must match where the art is.
    const at = (img: RGBAImage, x: number, y: number) => img.data[(y * img.width + x) * 4 + 3];
    expect(at(body.image, 100 + 10 - body.x, 30 + 20 - body.y)).toBe(255);
    expect(Math.abs(art.layers[1].opacity - 0.5)).toBeLessThan(0.01);
  });
});

describe('kit sample', () => {
  const art = readPsd(readFileSync(join(root, 'samples/kit/source/kit.psd')));
  const spec: RigSpec = JSON.parse(readFileSync(join(root, 'samples/kit/rig.json'), 'utf8'));

  it('rigs every layer and passes validation and the bend test', () => {
    const { file, report } = buildRig(art, spec);
    expect(validate(file).ok).toBe(true);
    expect(report.parts.map((p) => p.layer).sort()).toEqual(art.layers.map((l) => l.name).sort());
    // Alternates land in the right slots.
    expect(Object.keys(file.attachments.eyes).sort()).toEqual(['eyes', 'eyes_closed']);
    expect(Object.keys(file.attachments.mouth).sort()).toEqual(['mouth', 'mouth_open']);
    // Chains became bones.
    for (const b of ['tail1', 'tail4', 'scarf1', 'scarf2']) expect(file.bones.some((x) => x.name === b)).toBe(true);
    const bend = bendTest(SkeletonData.fromJSON(file));
    expect(bend.issues.filter((i) => i.severity === 'error')).toEqual([]);
  });

  it('reports a clear error for unknown bones', () => {
    const bad: RigSpec = { ...spec, parts: { ...spec.parts, tail: { bones: ['tail9'] } } };
    expect(() => buildRig(art, bad)).toThrow(/unknown bone "tail9"/);
  });
});
