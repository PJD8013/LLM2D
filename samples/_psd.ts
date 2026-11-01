/**
 * Renders full-canvas SVG layers at a pixel scale with headless Chromium and writes them as a
 * layered PSD (trimmed layers) plus a flattened preview. Used to make test art for samples.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { chromium } from 'playwright';
import { composite, decodePng, encodePng, trimLayer, writePsd, type Layer } from '../packages/rig/src/index.ts';

export interface SvgLayer {
  name: string;
  svg: string;
  hidden?: boolean;
  blend?: Layer['blend'];
}

export async function svgLayersToPsd(
  layers: SvgLayer[],
  canvas: { width: number; height: number },
  psdPath: string,
  previewPath: string,
  scale = 2,
): Promise<Layer[]> {
  const browser = await chromium.launch();
  const page = await browser.newPage({ deviceScaleFactor: scale, viewport: canvas });
  const out: Layer[] = [];
  for (const l of layers) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas.width}" height="${canvas.height}" viewBox="0 0 ${canvas.width} ${canvas.height}">${l.svg}</svg>`;
    await page.setContent(`<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`);
    const png = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, ...canvas } });
    const trimmed = trimLayer({ name: l.name, x: 0, y: 0, image: decodePng(png), hidden: !!l.hidden, opacity: 1, blend: l.blend ?? 'normal' });
    if (!trimmed) throw new Error(`Layer ${l.name} is empty`);
    out.push(trimmed);
  }
  await browser.close();
  const width = canvas.width * scale;
  const height = canvas.height * scale;
  await mkdir(dirname(psdPath), { recursive: true });
  await writeFile(psdPath, writePsd({ width, height, layers: out }));
  await writeFile(previewPath, encodePng(composite(out, width, height)));
  return out;
}
