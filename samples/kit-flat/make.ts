/**
 * Makes the flat test picture: Kit's visible layers merged into one image on a white
 * background and saved as JPEG (quality 90), the way a picture from an image generator or a
 * quick export arrives: no layers, no transparency, compression noise.
 *
 *   node samples/kit-flat/make.ts
 *
 * The original layers (samples/kit/source/kit.psd) are kept as the ground truth that the
 * automatic split is compared against in the tests.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { composite, encodePng, readPsd } from '../../packages/rig/src/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const art = readPsd(await readFile(join(here, '../kit/source/kit.psd')));
const flat = composite(art.layers, art.width, art.height);

const browser = await chromium.launch();
const page = await browser.newPage();
const jpeg = await page.evaluate(
  async ({ png, width, height }) => {
    const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${png}`)).blob());
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bmp, 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  },
  { png: encodePng(flat).toString('base64'), width: art.width, height: art.height },
);
await browser.close();
const out = join(here, 'source/kit-flat.jpg');
await writeFile(out, Buffer.from(jpeg, 'base64'));
console.log(`wrote samples/kit-flat/source/kit-flat.jpg (${art.width}x${art.height})`);
