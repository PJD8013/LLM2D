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
  type LayeredArt,
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
      expect(m.outlines.some((o) => pointInPolygon((a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, o))).toBe(true);
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

  it('keeps detached pieces and does not bridge the gaps between them', () => {
    // Two strands 30 px apart and a small dot: all must be in the mesh, the gaps must stay empty.
    const img = shape(200, 120, (x, y) =>
      (x > 10 && x < 190 && y > 10 && y < 40) || (x > 10 && x < 190 && y > 70 && y < 100) || Math.hypot(x - 100, y - 112) < 5,
    );
    const m = buildMesh(img, { spacing: 10 });
    expect(m.outlines).toHaveLength(3);
    const tris: Pt[][] = [];
    for (let i = 0; i < m.triangles.length; i += 3) tris.push([0, 1, 2].map((k) => m.points[m.triangles[i + k]]));
    const covered = (px: number, py: number) => tris.some((t) => pointInPolygon(px, py, t));
    for (const [x, y] of [[20, 25], [180, 25], [20, 85], [180, 85], [100, 112]] as Pt[]) expect(covered(x, y), `(${x}, ${y})`).toBe(true);
    for (const [x, y] of [[20, 55], [100, 55], [180, 55], [100, 104]] as Pt[]) expect(covered(x, y), `gap (${x}, ${y})`).toBe(false);
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

const layer = (name: string, image: RGBAImage, x = 0, y = 0, extra: Partial<Layer> = {}): Layer => ({
  name,
  x,
  y,
  image,
  hidden: false,
  opacity: 1,
  blend: 'normal',
  ...extra,
});
const art = (width: number, height: number, layers: Layer[]): LayeredArt => ({ width, height, layers, warnings: [] });
const dot = (r: number, size = 2 * r + 4) => shape(size, size, (x, y) => Math.hypot(x - size / 2, y - size / 2) < r);
const bar = (x1: number, x2: number, cy: number, r: number) => (x: number, y: number) => Math.hypot(x - Math.max(x1, Math.min(x2, x)), y - cy) <= r;

describe('buildRig', () => {
  it('keeps layer names in any script and finds parts by the names shown in the art', () => {
    const a = art(400, 300, [
      layer('몸통', dot(40), 100, 100),
      layer('팔/왼쪽', shape(130, 30, bar(10, 120, 15, 10)), 180, 130),
      layer('눈', dot(8), 130, 120),
      layer('눈_감음', dot(6), 130, 120, { hidden: true }),
    ]);
    const spec: RigSpec = {
      name: 't',
      origin: [150, 200],
      bones: [
        { name: 'body', from: [150, 190], to: [150, 110] },
        { name: 'upper', parent: 'body', from: [190, 145], to: [245, 145] },
        { name: 'lower', parent: 'upper', from: [245, 145], to: [300, 145] },
      ],
      parts: { '팔/왼쪽': { bones: ['upper', 'lower'] }, 몸통: { bone: 'body' }, tail: { bone: 'body' } },
    };
    const { file, report } = buildRig(a, spec);
    expect(validate(file).ok).toBe(true);
    expect(file.slots.map((sl) => sl.name)).toEqual(['몸통', '팔_왼쪽', '눈']);
    expect(Object.keys(file.attachments['눈']).sort()).toEqual(['눈', '눈_감음']);
    expect(Object.keys(file.images).sort()).toEqual(['눈', '눈_감음', '몸통', '팔_왼쪽'].sort());
    expect(report.parts.find((p) => p.layer === '팔/왼쪽')).toMatchObject({ kind: 'mesh', bones: ['upper', 'lower'], auto: false });
    expect(report.warnings.some((w) => w.startsWith('parts."tail": no layer'))).toBe(true);
    expect(() => buildRig(a, { ...spec, chains: [{ layer: '꼬리', prefix: 'c', count: 2, parent: 'root', start: [0, 0] }] })).toThrow(
      /Chain "c": no layer named "꼬리". Layers: "몸통", "팔\/왼쪽", "눈", "눈_감음"/,
    );
  });

  it('keeps parts, skipped bases and clip slots apart when names come close', () => {
    const spec: RigSpec = {
      name: 't',
      origin: [100, 100],
      bones: [
        { name: 'b', from: [100, 150], to: [100, 50] },
        { name: 'c', from: [50, 100], to: [150, 100] },
      ],
    };
    // "a b" gets the slot id "a_b"; parts written for the layer named "a_b" stay with that layer.
    const named = buildRig(art(200, 200, [layer('a b', dot(20), 40, 40), layer('a_b', dot(20), 120, 120)]), { ...spec, parts: { a_b: { bone: 'c' } } });
    expect(named.report.parts.map((p) => [p.layer, p.slot, p.auto])).toEqual([
      ['a b', 'a_b', true],
      ['a_b', 'a_b_2', false],
    ]);
    // Skipping a layer also skips its hidden alternates (with a warning), instead of failing.
    const skipped = buildRig(art(200, 200, [layer('body', dot(40), 50, 50), layer('eyes', dot(10), 80, 80), layer('eyes_closed', dot(8), 82, 82, { hidden: true })]), {
      ...spec,
      parts: { eyes: { skip: true } },
    });
    expect(skipped.file.slots.map((sl) => sl.name)).toEqual(['body']);
    expect(skipped.report.warnings.some((w) => w.startsWith('eyes_closed: skipped like its layer "eyes"'))).toBe(true);
    // A layer already called "shine_clip" does not stop the shine from being clipped.
    const clip = buildRig(art(200, 200, [layer('coin', dot(40), 50, 50), layer('shine_clip', dot(5), 10, 10), layer('shine', dot(10), 90, 90)]), {
      ...spec,
      parts: { shine: { bone: 'b', clip: 'coin' } },
    });
    expect(clip.file.slots.map((sl) => sl.name)).toEqual(['coin', 'shine_clip', 'shine_clip_2', 'shine']);
    expect(clip.file.attachments.shine_clip_2.shine_clip_2.type).toBe('clipping');
    expect(validate(clip.file).ok).toBe(true);
  });

  it('puts hidden alternate art in its base slot without moving the base in the draw order', () => {
    // Back to front. The hidden alternates sit below their base layers in the art.
    const layers = [
      layer('blink', shape(40, 8, () => true), 80, 116, { hidden: true }),
      layer('mouth_open_wide', dot(12), 76, 140, { hidden: true }),
      layer('mouth_closed', dot(6), 82, 146, { hidden: true }),
      layer('head', dot(60), 36, 36),
      layer('eyes', shape(40, 16, () => true), 80, 112),
      layer('mouth', dot(8), 80, 144),
      layer('mouth_open', dot(10), 78, 142),
    ];
    const spec: RigSpec = { name: 't', origin: [100, 200], bones: [{ name: 'head', from: [100, 160], to: [100, 40] }] };
    const { file, report } = buildRig(art(200, 200, layers), { ...spec, parts: { blink: { slot: 'eyes' } } });
    expect(file.slots.map((sl) => sl.name)).toEqual(['head', 'eyes', 'mouth', 'mouth_open']);
    expect(Object.keys(file.attachments.eyes).sort()).toEqual(['blink', 'eyes']);
    // The longest matching name wins.
    expect(Object.keys(file.attachments.mouth_open).sort()).toEqual(['mouth_open', 'mouth_open_wide']);
    expect(Object.keys(file.attachments.mouth).sort()).toEqual(['mouth', 'mouth_closed']);
    expect(file.slots.find((sl) => sl.name === 'eyes')!.attachment).toBe('eyes');
    expect(report.warnings).toEqual([]);
  });

  it('rejects bad numbers in the spec with the field to fix', () => {
    const a = art(100, 100, [layer('body', dot(30), 16, 16)]);
    const spec: RigSpec = { name: 't', origin: [50, 50], bones: [{ name: 'b', from: [50, 80], to: [50, 20] }] };
    expect(() => buildRig(a, { ...spec, mesh: { spacing: 0 } })).toThrow(/mesh\.spacing must be at least 2/);
    expect(() => buildRig(a, { ...spec, parts: { body: { bones: ['b'], softness: -1 } } })).toThrow(/parts\.body\.softness must be above 0/);
    expect(() => buildRig(a, { ...spec, parts: { body: { smooth: 1.5 } } })).toThrow(/parts\.body\.smooth must be a whole number/);
    expect(() => buildRig(a, { ...spec, scale: 0 })).toThrow(/"scale" must be above 0/);
    expect(() => buildRig(a, { ...spec, origin: [50] as unknown as Pt })).toThrow(/"origin" must be \[x, y\]/);
    expect(() => buildRig(a, { ...spec, bones: [{ name: 'b', from: [50, Number.NaN] }] })).toThrow(/bone "b": "from" must be \[x, y\]/);
    expect(() => buildRig(a, { ...spec, chains: [{ layer: 'body', prefix: 'c', count: 0, parent: 'root', start: [50, 50] }] })).toThrow(
      /chain "c": "count" must be a whole number/,
    );
  });

  it('chains each strand of a layer and places bones that hang off chain bones', () => {
    const hair = shape(420, 180, (x, y) => bar(40, 360, 50, 14)(x, y) || bar(40, 300, 130, 14)(x, y));
    const spec: RigSpec = {
      name: 't',
      origin: [200, 170],
      bones: [{ name: 'bead', parent: 'a3', from: [372, 50], to: [392, 50] }],
      chains: [
        { layer: 'hair', prefix: 'a', count: 3, parent: 'root', start: [42, 50] },
        { layer: 'hair', prefix: 'b', count: 3, parent: 'root', start: [42, 130] },
      ],
    };
    const { file, report } = buildRig(art(420, 180, [layer('hair', hair)]), spec);
    for (const [, y] of report.chains.a) expect(Math.abs(y - 50)).toBeLessThan(3);
    for (const [, y] of report.chains.b) expect(Math.abs(y - 130)).toBeLessThan(3);
    expect(report.chains.b[3][0]).toBeGreaterThan(290);
    expect(report.chains.b[3][0]).toBeLessThan(320);
    expect(file.bones.find((b) => b.name === 'bead')?.parent).toBe('a3');
    const far = { ...spec, chains: [{ ...spec.chains![0], start: [400, 400] as Pt }] };
    expect(() => buildRig(art(420, 180, [layer('hair', hair)]), far)).toThrow(/Chain "a" \(start \[400, 400\]\) on layer "hair": the start is \d+ px from the art/);
  });

  it.each([8, 12])('does not let a bone pull on art across a %i px gap in the same layer', (gap) => {
    // Two legs drawn in one layer, joined at the hips. At 8 px the mesh margins nearly meet.
    const legR = 20;
    const cxL = 200 - gap / 2 - legR;
    const cxR = 200 + gap / 2 + legR;
    const legs = shape(400, 520, (x, y) =>
      (y > 40 && y < 120 && Math.abs(x - 200) < gap / 2 + legR * 2) || (y >= 40 && y <= 480 && (Math.abs(x - cxL) <= legR || Math.abs(x - cxR) <= legR)),
    );
    const spec: RigSpec = {
      name: 't',
      origin: [200, 500],
      bones: [
        { name: 'hip', from: [200, 80], to: [200, 40] },
        { name: 'thigh_l', parent: 'hip', from: [cxL, 100], to: [cxL, 290] },
        { name: 'shin_l', parent: 'thigh_l', from: [cxL, 290], to: [cxL, 480] },
        { name: 'thigh_r', parent: 'hip', from: [cxR, 100], to: [cxR, 290] },
        { name: 'shin_r', parent: 'thigh_r', from: [cxR, 290], to: [cxR, 480] },
      ],
      parts: { legs: { bones: ['hip', 'thigh_l', 'shin_l', 'thigh_r', 'shin_r'] } },
    };
    const { file } = buildRig(art(400, 520, [layer('legs', legs)]), spec);
    const att = file.attachments.legs.legs;
    if (att.type !== 'mesh') throw new Error('expected a mesh');
    // Weight from the other leg's bones: the crotch (y 120) blends, a little is left 40 to 90 px
    // below it, none further down (it used to reach the feet).
    let near = 0;
    let far = 0;
    att.weights!.forEach((w, i) => {
      const [x, y] = [att.vertices[i * 2] + 200, att.vertices[i * 2 + 1] + 500];
      if (y < 160) return;
      let other = 0;
      // Bones 1, 2: left leg; 3, 4: right leg (0 is the hip).
      for (let k = 0; k < w.length; k += 2) if (x > 200 ? w[k] === 1 || w[k] === 2 : w[k] === 3 || w[k] === 4) other += w[k + 1];
      if (y > 210) far = Math.max(far, other);
      else near = Math.max(near, other);
    });
    expect(far).toBe(0);
    expect(near).toBeLessThan(0.08);
  });

  it('makes the clip of a bending layer follow its bones', () => {
    const coin = shape(200, 60, bar(20, 180, 30, 26));
    const shine = shape(30, 60, () => true);
    const spec: RigSpec = {
      name: 't',
      origin: [100, 30],
      bones: [
        { name: 'left', from: [10, 30], to: [100, 30] },
        { name: 'right', parent: 'left', from: [100, 30], to: [190, 30] },
        { name: 'shine', from: [100, 30], to: [100, 0] },
      ],
      parts: { coin: { bones: ['left', 'right'] }, shine: { bone: 'shine', clip: 'coin' } },
    };
    const { file } = buildRig(art(200, 60, [layer('coin', coin), layer('shine', shine, 85, 0)]), spec);
    expect(validate(file).ok).toBe(true);
    expect(file.slots.map((sl) => sl.name)).toEqual(['coin', 'shine_clip', 'shine']);
    const clip = file.attachments.shine_clip.shine_clip;
    if (clip.type !== 'clipping') throw new Error('expected a clipping attachment');
    expect(clip.bones).toEqual(['left', 'right']);
    expect(clip.weights).toHaveLength(clip.vertices.length / 2);
    // Points at the far ends follow the bone on their side.
    clip.weights!.forEach((w, i) => {
      const x = clip.vertices[i * 2];
      if (Math.abs(x) > 60) expect(w[0]).toBe(x < 0 ? 0 : 1);
    });
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
