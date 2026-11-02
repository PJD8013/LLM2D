import { readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

/**
 * The samples folder is the public dir, so a build copies all of it. The built viewer only
 * needs each sample's .l2d.json and images: drop the art sources, PSDs and build scripts.
 */
function trimSamples(): Plugin {
  let outDir = '';
  const keep = /\.(l2d\.json|png|webp|jpe?g)$/;
  const walk = (dir: string, depth: number) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, e.name);
      if (e.isDirectory()) {
        if (depth === 0 && e.name === 'assets') continue; // the viewer's own bundle
        if (depth > 0 && (e.name === 'source' || e.name === 'art')) rmSync(path, { recursive: true, force: true });
        else walk(path, depth + 1);
      } else if (depth === 0 ? e.name.endsWith('.ts') : !keep.test(e.name)) rmSync(path, { force: true });
    }
  };
  return {
    name: 'llm2d-trim-samples',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    closeBundle() {
      walk(outDir, 0);
    },
  };
}

export default defineConfig({
  // Serve the repo's samples folder at the site root: /bolt/bolt.l2d.json etc.
  publicDir: '../../samples',
  base: './',
  server: { port: 5173, host: true },
  build: { target: 'es2022' },
  plugins: [trimSamples()],
});
