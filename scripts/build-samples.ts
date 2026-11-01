/**
 * Regenerates the sample skeletons: writes each part's SVG source, rasterises it to PNG at
 * 2x with headless Chromium, writes the .l2d.json and validates it.
 *
 *   pnpm samples            # all samples
 *   pnpm samples bolt       # one sample
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { validate, type L2DFile } from '../packages/core/src/index.ts';
import type { ArtPart } from '../samples/_lib.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCALE = 2;
const ALL = ['bolt', 'gem'];

const wanted = process.argv.slice(2);
const names = wanted.length ? wanted : ALL;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: SCALE });

for (const name of names) {
  const mod = (await import(`../samples/${name}/build.ts`)) as { art: Record<string, ArtPart>; file: L2DFile };
  const dir = join(root, 'samples', name);
  await mkdir(join(dir, 'images'), { recursive: true });
  await mkdir(join(dir, 'art'), { recursive: true });

  for (const [part, a] of Object.entries(mod.art)) {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${a.w}" height="${a.h}" viewBox="0 0 ${a.w} ${a.h}">${a.svg}</svg>`;
    await writeFile(join(dir, 'art', `${part}.svg`), svg + '\n');
    await page.setViewportSize({ width: a.w, height: a.h });
    await page.setContent(
      `<html><body style="margin:0;background:transparent;overflow:hidden">${svg}</body></html>`,
    );
    await page.screenshot({
      path: join(dir, 'images', `${part}.png`),
      omitBackground: true,
      clip: { x: 0, y: 0, width: a.w, height: a.h },
    });
  }

  const result = validate(mod.file);
  for (const w of result.warnings) console.warn(`  warning ${w.path}: ${w.message}`);
  if (!result.ok) {
    for (const e of result.errors) console.error(`  error ${e.path}: ${e.message}`);
    process.exitCode = 1;
  }
  await writeFile(join(dir, `${name}.l2d.json`), JSON.stringify(mod.file, null, 2) + '\n');
  console.log(`${name}: ${Object.keys(mod.art).length} images, ${mod.file.bones.length} bones, ` +
    `${Object.keys(mod.file.animations).length} animations -> samples/${name}/${name}.l2d.json ${result.ok ? 'OK' : 'INVALID'}`);
}

await browser.close();
