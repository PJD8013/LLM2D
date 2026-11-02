/**
 * Renders contact sheets (a grid of frames across an animation) with headless Chromium,
 * using the real PixiJS runtime in the viewer. This is how a person or an LLM checks an
 * animation without opening a browser.
 *
 *   pnpm render                                   # every animation of every sample
 *   pnpm render --file bolt/bolt.l2d.json --anim cheer --frames 12 --debug
 *
 * Options:
 *   --file <path>    .l2d.json file; a path under samples/ or any path (repeatable). Default: all samples.
 *   --anim <name>    animation to render (repeatable). Default: all.
 *   --frames <n>     frames per sheet (default 8)
 *   --cell <px>      cell size (default 256)
 *   --bg <dark|light|checker>
 *   --debug          draw bones, meshes and IK targets
 *   --bend           render the bend test poses instead of animations (--stress adds extreme poses)
 *   --out <dir>      output folder (default out/renders in the repository)
 */
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { SkeletonData, bendPoses } from '../packages/core/src/index.ts';
import { Previewer, closeBrowser } from '../packages/preview/src/index.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    file: { type: 'string', multiple: true },
    anim: { type: 'string', multiple: true },
    frames: { type: 'string', default: '8' },
    cell: { type: 'string', default: '256' },
    bg: { type: 'string', default: 'dark' },
    debug: { type: 'boolean', default: false },
    bend: { type: 'boolean', default: false },
    stress: { type: 'boolean', default: false },
    out: { type: 'string' },
  },
});

const files = (values.file ?? ['bolt/bolt.l2d.json', 'gem/gem.l2d.json', 'kit/kit.l2d.json', 'coin/coin.l2d.json']).map((f) =>
  existsSync(f) ? f : join(root, 'samples', f),
);
const outDir = values.out ? resolve(values.out) : join(root, 'out/renders');
await mkdir(outDir, { recursive: true });
const write = async (name: string, png: Buffer) => {
  const path = join(outDir, name);
  await writeFile(path, png);
  const rel = relative(process.cwd(), path);
  console.log(`wrote ${rel.startsWith('..') ? path : rel}`);
};
const background = values.bg as 'dark' | 'light' | 'checker';
const cell = Number(values.cell);

const previewer = new Previewer();
try {
  for (const path of files) {
    const file = await previewer.loadFile(path);
    if (values.bend) {
      if (!bendPoses(SkeletonData.fromJSON(file)).length) console.log(`${file.name}: no mesh bends with its bones; nothing to bend-test`);
      const png = await previewer.bendSheet({ cell, stress: values.stress, debug: values.debug, background });
      await write(`${file.name}-bend${values.stress ? '-stress' : ''}${values.debug ? '-debug' : ''}.png`, png);
      continue;
    }
    const names = Object.keys(file.animations ?? {});
    for (const anim of values.anim ?? names) {
      if (!names.includes(anim)) {
        console.error(`${file.name}: no animation "${anim}" (has ${names.join(', ') || 'none'})`);
        process.exitCode = 1;
        continue;
      }
      const png = await previewer.contactSheet(anim, { frames: Number(values.frames), cell, debug: values.debug, background });
      await write(`${file.name}-${anim}${values.debug ? '-debug' : ''}.png`, png);
    }
  }
} finally {
  await previewer.close();
  await closeBrowser();
}
