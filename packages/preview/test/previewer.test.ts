import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { L2DFile } from '@llm2d/core';
import { createImage, decodePng, encodePng } from '@llm2d/rig';
import { Previewer, closeBrowser } from '../src/index.ts';

const gem = join(import.meta.dirname, '../../../samples/gem/gem.l2d.json');

describe('Previewer', () => {
  it('starts again after its page or the browser went away', async () => {
    const previewer = new Previewer();
    try {
      await previewer.loadFile(gem);
      const first = await previewer.frame(null, 0, { size: 128 });
      // The page closes (a crash, or someone closed it).
      await (previewer as unknown as { page: { close(): Promise<void> } }).page.close();
      await previewer.loadFile(gem);
      expect((await previewer.frame(null, 0, { size: 128 })).equals(first)).toBe(true);
      // The whole browser goes away.
      await closeBrowser();
      await previewer.loadFile(gem);
      expect((await previewer.frame(null, 0, { size: 128 })).equals(first)).toBe(true);
    } finally {
      await previewer.close();
      await closeBrowser();
    }
  }, 120_000);

  it('frames the whole motion of an animation in every cell of a contact sheet', async () => {
    // A green box that slides three times its width to the right of the setup pose (sideways,
    // so the frame labels in the top-left corners never cover it).
    const file: L2DFile = {
      format: 'llm2d',
      version: '0.1',
      name: 'jump',
      images: { box: { path: 'box.png', width: 100, height: 100 } },
      bones: [{ name: 'root' }, { name: 'body', parent: 'root' }],
      slots: [{ name: 'box', bone: 'body', attachment: 'box' }],
      attachments: { box: { box: { type: 'region', image: 'box', x: 0, y: -50 } } },
      animations: {
        jump: { bones: { body: { translate: [{ time: 0, x: 0 }, { time: 0.5, x: 300 }, { time: 1, x: 0 }] } } },
      },
    };
    const green = createImage(100, 100);
    for (let i = 0; i < green.data.length; i += 4) green.data.set([0, 255, 0, 255], i);
    const previewer = new Previewer();
    try {
      await previewer.load(file, { 'box.png': encodePng(green) });
      const cell = 120;
      const img = decodePng(await previewer.contactSheet('jump', { frames: 3, cell, columns: 3 }));
      const isBox = (x: number, y: number) => {
        const i = (y * img.width + x) * 4;
        return img.data[i + 1] > 150 && img.data[i] < 100 && img.data[i + 2] < 100;
      };
      const counts = [0, 1, 2].map((c) => {
        let n = 0;
        for (let y = 0; y < cell; y++) for (let x = c * cell; x < (c + 1) * cell; x++) if (isBox(x, y)) n++;
        return n;
      });
      // The box is whole in every frame (same size: same framing), and never touches a cell edge.
      expect(counts[0]).toBeGreaterThan(50);
      for (const n of counts) expect(Math.abs(n - counts[0])).toBeLessThan(counts[0] * 0.05);
      for (let c = 0; c < 3; c++)
        for (let k = 2; k < cell - 2; k++) {
          expect(isBox(c * cell + k, 2) || isBox(c * cell + k, cell - 3) || isBox(c * cell + 2, k) || isBox((c + 1) * cell - 3, k)).toBe(false);
        }
    } finally {
      await previewer.close();
      await closeBrowser();
    }
  }, 120_000);
});
