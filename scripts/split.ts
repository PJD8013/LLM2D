/**
 * Splits a flat picture (PNG, JPEG, WebP) into layers for rigging.
 *
 *   pnpm split regions <picture> [--detail 1] [--background auto|none|#rrggbb] [--out out/split]
 *       Writes <name>-regions.png: the picture with numbered regions over a pixel grid, and
 *       prints the region table. Group the numbers into parts in a split.json.
 *
 *   pnpm split build <picture> --spec split.json [--out <dir>] [--psd <file>]
 *       Writes the layered PSD (default <out>/<name>.psd) and <name>-split.png, a sheet of the
 *       layers with rebuilt (previously hidden) pixels tinted. The PSD goes to `pnpm rig build`
 *       or an MCP project like any artist's PSD.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { closeBrowser, decodeImage, regionsImage, splitSheet } from '../packages/preview/src/index.ts';
import { readPicture, regionTable, splitArt, writePsd, type SplitFile } from '../packages/rig/src/index.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    detail: { type: 'string' },
    background: { type: 'string' },
    spec: { type: 'string' },
    out: { type: 'string', default: 'out/split' },
    psd: { type: 'string' },
  },
});

const [command, input] = positionals;
if (!input || !['regions', 'build'].includes(command)) {
  console.error('usage: pnpm split regions <picture> [--detail 1] [--background auto|none|#rrggbb]\n       pnpm split build <picture> --spec split.json [--out dir] [--psd file]');
  process.exit(1);
}

const name = basename(input).replace(/\.[^.]+$/, '');
const spec: SplitFile | null = values.spec ? JSON.parse(await readFile(values.spec, 'utf8')) : null;
if (command === 'build' && !spec) throw new Error('--spec split.json is required for build');
const settings = {
  background: values.background ?? spec?.background,
  detail: values.detail !== undefined ? Number(values.detail) : spec?.detail,
};

const started = Date.now();
const picture = readPicture(await decodeImage(await readFile(input), input), settings);
const seg = picture.segmentation;
console.log(`${input}: ${seg.width}x${seg.height}, ${picture.background.note}`);
console.log(`${seg.regions.length} regions${seg.outline ? `, outlines ~${seg.outline.width.toFixed(1)} px` : ', no outlines found'} (${Date.now() - started} ms)`);
const out = resolve(values.out);
await mkdir(out, { recursive: true });

try {
  if (command === 'regions') {
    const file = join(out, `${name}-regions.png`);
    await writeFile(file, await regionsImage(picture.image, seg));
    console.log(regionTable(seg));
    console.log(`\nwrote ${file}`);
  } else {
    const result = splitArt(picture.image, seg, spec!);
    const r = result.report;
    console.log(`fill ${r.fill} px, overlap ${r.overlap} px; restacked difference ${r.difference}`);
    for (const p of r.parts)
      console.log(
        `  ${p.name.padEnd(12)} ${String(p.pixels).padStart(7)} px  +${String(p.filled).padEnd(6)} rebuilt` +
          (p.box ? `  x=${p.box.x} y=${p.box.y} ${p.box.width}x${p.box.height}` : '') +
          (p.auto.length ? `  (joined: ${p.auto.join(', ')})` : ''),
      );
    for (const w of r.warnings) console.warn(`warning: ${w}`);
    const psd = resolve(values.psd ?? join(out, `${name}.psd`));
    await mkdir(dirname(psd), { recursive: true });
    await writeFile(psd, writePsd(result.art));
    const sheet = join(out, `${name}-split.png`);
    await writeFile(sheet, await splitSheet(result));
    console.log(`wrote ${psd}\nwrote ${sheet}`);
  }
} finally {
  await closeBrowser();
}
