/**
 * Rasterises the Kit layers at 2x and writes them as a layered PSD, standing in for art an
 * artist would deliver. Also writes a flattened preview.
 *
 *   node samples/kit/make-psd.ts
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { composite, decodePng, encodePng, trimLayer, writePsd, type Layer } from '../../packages/rig/src/index.ts';
import { CANVAS, layers } from './art.ts';

const SCALE = 2;
const dir = join(dirname(fileURLToPath(import.meta.url)), 'source');
await mkdir(dir, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: SCALE, viewport: CANVAS });
const out: Layer[] = [];
for (const l of layers) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS.width}" height="${CANVAS.height}" viewBox="0 0 ${CANVAS.width} ${CANVAS.height}">${l.svg}</svg>`;
  await page.setContent(`<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`);
  const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, ...CANVAS } });
  const trimmed = trimLayer({ name: l.name, x: 0, y: 0, image: decodePng(png), hidden: !!l.hidden, opacity: 1, blend: 'normal' });
  if (!trimmed) throw new Error(`Layer ${l.name} is empty`);
  out.push(trimmed);
}
await browser.close();

const width = CANVAS.width * SCALE;
const height = CANVAS.height * SCALE;
await writeFile(join(dir, 'kit.psd'), writePsd({ width, height, layers: out }));
await writeFile(join(dir, 'kit-preview.png'), encodePng(composite(out, width, height)));
console.log(`wrote samples/kit/source/kit.psd (${width}x${height}, ${out.length} layers)`);
for (const l of out) console.log(`  ${l.name.padEnd(12)} x=${l.x} y=${l.y} ${l.image.width}x${l.image.height}${l.hidden ? ' (hidden)' : ''}`);
