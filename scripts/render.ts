/**
 * Renders contact sheets (a grid of frames across an animation) with headless Chromium,
 * using the real PixiJS runtime in the viewer. This is how a person or an LLM checks an
 * animation without opening a browser.
 *
 *   pnpm render                                   # every animation of every sample
 *   pnpm render --file bolt/bolt.l2d.json --anim cheer --frames 12 --debug
 *
 * Options:
 *   --file <path>    .l2d.json path under samples/ (repeatable). Default: all samples.
 *   --anim <name>    animation to render (repeatable). Default: all.
 *   --frames <n>     frames per sheet (default 8)
 *   --cell <px>      cell size (default 256)
 *   --bg <dark|light|checker>
 *   --debug          draw bones, meshes and IK targets
 *   --bend           render the bend test poses instead of animations (--stress adds extreme poses)
 *   --out <dir>      output folder (default out/renders)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { createServer } from 'vite';

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
    out: { type: 'string', default: 'out/renders' },
  },
});

const files = values.file ?? ['bolt/bolt.l2d.json', 'gem/gem.l2d.json', 'kit/kit.l2d.json'];
const frames = Number(values.frames);
const cell = Number(values.cell);
const outDir = join(root, values.out!);
await mkdir(outDir, { recursive: true });

const server = await createServer({
  root: join(root, 'apps/viewer'),
  configFile: join(root, 'apps/viewer/vite.config.ts'),
  server: { port: 0, host: '127.0.0.1' },
  logLevel: 'error',
});
await server.listen();
const address = server.httpServer!.address();
const port = typeof address === 'object' && address ? address.port : 5173;

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
try {
  const page = await browser.newPage({ viewport: { width: 640, height: 640 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));

  for (const file of files) {
    const query = new URLSearchParams({ headless: '1', file, bg: values.bg! });
    if (values.debug) query.set('debug', '1');
    await page.goto(`http://127.0.0.1:${port}/?${query}`);
    await page.waitForSelector('body[data-ready="true"]', { timeout: 30000 });
    const info = await page.evaluate(() => (window as any).__llm2d.info());
    if (!info) throw new Error(`Failed to load ${file}: ${errors.join('\n')}`);
    if (values.bend) {
      const dataUrl: string = await page.evaluate(
        ([c, st]) => (window as any).__llm2d.bendSheet(c, st),
        [cell, values.stress] as const,
      );
      const name = `${info.name}-bend${values.stress ? '-stress' : ''}${values.debug ? '-debug' : ''}.png`;
      await writeFile(join(outDir, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
      console.log(`wrote ${join(values.out!, name)}`);
      continue;
    }
    const anims: string[] = values.anim ?? info.animations.map((a: { name: string }) => a.name);
    for (const anim of anims) {
      const dataUrl: string = await page.evaluate(
        ([a, f, c]) => (window as any).__llm2d.contactSheet(a, f, c),
        [anim, frames, cell] as const,
      );
      const name = `${info.name}-${anim}${values.debug ? '-debug' : ''}.png`;
      await writeFile(join(outDir, name), Buffer.from(dataUrl.split(',')[1], 'base64'));
      console.log(`wrote ${join(values.out!, name)}`);
    }
  }
  if (errors.length) console.warn(`page errors:\n${errors.join('\n')}`);
} finally {
  await browser.close();
  await server.close();
}
