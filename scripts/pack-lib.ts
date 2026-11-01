/**
 * Builds the runtime packages (@llm2d/core, @llm2d/pixi, @llm2d/svelte) to JavaScript and packs
 * them as .tgz files that a Stake web-sdk game can install without a registry.
 *
 *   pnpm pack:lib            # -> out/packages/llm2d-*.tgz
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'out/packages');
mkdirSync(out, { recursive: true });
for (const f of readdirSync(out)) if (f.endsWith('.tgz')) rmSync(join(out, f));

for (const pkg of ['core', 'pixi', 'svelte']) {
  const dir = join(root, 'packages', pkg);
  rmSync(join(dir, 'dist'), { recursive: true, force: true });
  execFileSync('pnpm', ['run', 'build'], { cwd: dir, stdio: 'inherit' });
  execFileSync('pnpm', ['pack', '--pack-destination', out], { cwd: dir, stdio: 'inherit' });
}
console.log(`\nPackages in ${out}:\n${readdirSync(out).filter((f) => f.endsWith('.tgz')).map((f) => `  ${f}`).join('\n')}`);
