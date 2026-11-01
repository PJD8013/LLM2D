/**
 * Game export: writes <out>/<name>/<name>.l2d.json plus atlas pages.
 *
 *   pnpm export samples/kit/kit.l2d.json --out out/game
 *   pnpm export samples/kit/kit.l2d.json --out out/game-mobile --scale 0.5
 *
 * Options: --out <dir> (default out/export), --scale <0..1>, --max <px> (default 2048),
 * --padding <px> (default 4), --no-atlas, --pretty
 */
import { parseArgs } from 'node:util';
import { exportSkeleton } from '../packages/export/src/index.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: 'out/export' },
    scale: { type: 'string', default: '1' },
    max: { type: 'string', default: '2048' },
    padding: { type: 'string', default: '4' },
    'no-atlas': { type: 'boolean', default: false },
    pretty: { type: 'boolean', default: false },
  },
});
if (!positionals.length) {
  console.error('usage: pnpm export <file.l2d.json> [more...] --out <dir> [--scale 0.5]');
  process.exit(2);
}
for (const file of positionals) {
  const r = await exportSkeleton(file, values.out!, {
    atlas: !values['no-atlas'],
    scale: Number(values.scale),
    maxSize: Number(values.max),
    padding: Number(values.padding),
    pretty: values.pretty,
  });
  const total = r.files.reduce((s, f) => s + f.bytes, 0);
  console.log(`${file} -> ${r.dir} (${(total / 1024).toFixed(0)} KB)`);
  for (const p of r.pages) console.log(`  ${p.name}: ${p.width}x${p.height}, ${(p.fill * 100).toFixed(0)}% filled`);
}
