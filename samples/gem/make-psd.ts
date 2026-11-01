/**
 * Packs the Gem art into a layered PSD (glow, gem, flash, sparkle) the way an artist would
 * deliver a symbol, for trying the rig + MCP workflow on a symbol. Effect layers use Linear
 * Dodge (additive); the white flash is hidden, as an artist would leave it.
 *
 *   node samples/gem/make-psd.ts
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { composite, decodePng, encodePng, writePsd, type Layer } from '../../packages/rig/src/index.ts';

const dir = dirname(fileURLToPath(import.meta.url));
const SIZE = 640; // art pixels (@2x of a 320-unit canvas)
const C = SIZE / 2;
const place = async (name: string, cx: number, cy: number, blend: Layer['blend'] = 'normal', hidden = false): Promise<Layer> => {
  const image = decodePng(await readFile(join(dir, 'images', `${name}.png`)));
  return { name, x: Math.round(cx - image.width / 2), y: Math.round(cy - image.height / 2), image, hidden, opacity: 1, blend };
};
const layers = [
  await place('glow', C, C, 'add'),
  await place('gem', C, C + 4),
  await place('gem_flash', C, C + 4, 'add', true),
  await place('sparkle', C + 80, C - 116, 'add'),
];
await mkdir(join(dir, 'source'), { recursive: true });
await writeFile(join(dir, 'source', 'gem.psd'), writePsd({ width: SIZE, height: SIZE, layers }));
await writeFile(join(dir, 'source', 'gem-preview.png'), encodePng(composite(layers, SIZE, SIZE)));
console.log('wrote samples/gem/source/gem.psd');
