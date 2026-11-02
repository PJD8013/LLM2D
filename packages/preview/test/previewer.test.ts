import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
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
});
