/**
 * Automatic rigging CLI.
 *
 *   pnpm rig inspect <art.psd> [--spec rig.json] [--out out/rig]
 *       Lists layers and writes <name>-inspect.png: the flattened art with a pixel grid and
 *       layer boxes (plus the spec's bones if given), for picking joint positions.
 *
 *   pnpm rig build <art.psd> --spec rig.json [--animations animations.json|.ts] --out samples/kit
 *       Builds <out>/<name>.l2d.json and <out>/images/, prints the part report and runs the
 *       bend test. Exits with code 1 if the bend test finds errors (override with --allow-errors).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { SkeletonData, bendTest } from '../packages/core/src/index.ts';
import { closeBrowser, inspectImage } from '../packages/preview/src/index.ts';
import { buildRig, readPsd, type LayeredArt, type RigSpec } from '../packages/rig/src/index.ts';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    spec: { type: 'string' },
    animations: { type: 'string' },
    out: { type: 'string' },
    'allow-errors': { type: 'boolean', default: false },
  },
});
const [command, input] = positionals;
if (!command || !input || !['inspect', 'build'].includes(command)) {
  console.error('usage: pnpm rig inspect <art.psd> [--spec rig.json] | pnpm rig build <art.psd> --spec rig.json --out <dir>');
  process.exit(2);
}

const art: LayeredArt = readPsd(await readFile(input));
const spec: RigSpec | undefined = values.spec ? JSON.parse(await readFile(values.spec, 'utf8')) : undefined;
const name = spec?.name ?? basename(input).replace(/\.[^.]+$/, '');
for (const w of art.warnings) console.warn(`warning: ${w}`);

if (command === 'inspect') {
  const out = values.out ?? 'out/rig';
  await mkdir(out, { recursive: true });
  console.log(`${input}: ${art.width}x${art.height}, ${art.layers.length} layers (bottom to top)`);
  for (const l of art.layers)
    console.log(`  ${l.name.padEnd(16)} x=${String(l.x).padEnd(5)} y=${String(l.y).padEnd(5)} ${l.image.width}x${l.image.height}${l.hidden ? '  hidden' : ''}`);
  const file = join(out, `${name}-inspect.png`);
  await writeFile(file, await inspectImage(art, { spec }));
  await closeBrowser();
  console.log(`wrote ${file}`);
} else {
  if (!spec) throw new Error('--spec is required for build');
  const outDir = values.out ?? join('samples', name);
  // Animations: a JSON object of { name: animation }, or a .ts/.js module exporting `animations`.
  const animations = !values.animations
    ? {}
    : /\.(ts|js|mjs)$/.test(values.animations)
      ? (await import(pathToFileURL(resolve(values.animations)).href)).animations
      : JSON.parse(await readFile(values.animations, 'utf8'));
  const result = buildRig(art, spec, animations);
  await mkdir(join(outDir, 'images'), { recursive: true });
  for (const [img, png] of Object.entries(result.images)) await writeFile(join(outDir, 'images', `${img}.png`), png);
  await writeFile(join(outDir, `${name}.l2d.json`), JSON.stringify(result.file, null, 2) + '\n');

  console.log(`${name}: ${result.file.bones.length} bones, ${result.file.slots.length} slots -> ${join(outDir, `${name}.l2d.json`)}`);
  for (const p of result.report.parts)
    console.log(
      `  ${p.layer.padEnd(14)} slot=${p.slot.padEnd(10)} ${p.kind.padEnd(6)} ${String(p.vertices).padStart(3)}v ` +
        `${String(p.triangles).padStart(3)}t  ${p.bones.join(', ')}${p.auto ? '  (auto)' : ''}${p.hidden ? '  (hidden)' : ''}`,
    );
  for (const [prefix, joints] of Object.entries(result.report.chains))
    console.log(`  chain ${prefix}: ${joints.map(([x, y]) => `(${x}, ${y})`).join(' -> ')}`);
  for (const w of result.report.warnings) console.warn(`  warning: ${w}`);

  const report = bendTest(SkeletonData.fromJSON(result.file));
  console.log(report.summary);
  for (const i of report.issues) console.log(`  ${i.severity.padEnd(7)} ${i.message}`);
  if (!report.ok && !values['allow-errors']) process.exitCode = 1;
}
