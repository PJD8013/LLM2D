import type { L2DFile } from '../src/index.ts';

/** A two-segment arm hanging from a root, with a target bone for IK and a weighted mesh. */
export function armFile(): L2DFile {
  return {
    format: 'llm2d',
    version: '0.1',
    name: 'arm',
    images: {
      box: { path: 'box.png', width: 20, height: 20 },
      strip: { path: 'strip.png', width: 10, height: 100 },
    },
    bones: [
      { name: 'root' },
      { name: 'upper', parent: 'root', x: 0, y: 0, rotation: 0, length: 50 },
      { name: 'lower', parent: 'upper', x: 50, y: 0, rotation: 0, length: 50 },
      { name: 'target', parent: 'root', x: 100, y: 0 },
    ],
    slots: [
      { name: 'strip', bone: 'upper', attachment: 'strip' },
      { name: 'hand', bone: 'lower', attachment: 'hand', color: 'ff000080', blend: 'add' },
    ],
    attachments: {
      strip: {
        strip: {
          type: 'mesh',
          image: 'strip',
          // A line of vertices along the arm (x = 0, 50, 100), two rows.
          vertices: [0, -5, 50, -5, 100, -5, 100, 5, 50, 5, 0, 5],
          uvs: [0, 0, 0.5, 0, 1, 0, 1, 1, 0.5, 1, 0, 1],
          triangles: [0, 1, 5, 1, 4, 5, 1, 2, 4, 2, 3, 4],
          hull: 6,
          bones: ['upper', 'lower'],
          weights: [[0, 1], [0, 0.5, 1, 0.5], [1, 1], [1, 1], [0, 0.5, 1, 0.5], [0, 1]],
        },
      },
      hand: {
        hand: { type: 'region', image: 'box', x: 100, y: 0 },
        fist: { type: 'region', image: 'box', x: 100, y: 0, scaleX: 0.5, scaleY: 0.5 },
      },
    },
    ik: [{ name: 'arm_ik', bones: ['upper', 'lower'], target: 'target', bendPositive: true, mix: 0 }],
    animations: {
      swing: {
        bones: {
          upper: {
            rotate: [
              { time: 0, value: 0 },
              { time: 1, value: 90, curve: 'stepped' },
              { time: 2, value: 45 },
            ],
          },
        },
        events: [
          { time: 0, name: 'start' },
          { time: 0.5, name: 'mid', strength: 2 },
        ],
      },
      grow: {
        bones: { lower: { scale: [{ time: 0, x: 1, y: 1 }, { time: 1, x: 2, y: 2 }] } },
        slots: {
          hand: {
            color: [{ time: 0, value: 'ffffff' }, { time: 1, value: '000000' }],
            attachment: [{ time: 0.5, name: 'fist' }],
          },
        },
      },
      reach: {
        duration: 1,
        ik: { arm_ik: { mix: [{ time: 0, value: 1 }] } },
        bones: { target: { translate: [{ time: 0, x: -30, y: 40 }] } },
      },
    },
  };
}
