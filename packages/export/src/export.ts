import { copyFile, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { validate, type L2DFile } from '@llm2d/core';
import { packAtlas, type AtlasOptions } from './atlas.ts';

export interface ExportOptions extends AtlasOptions {
  /** Pack images into atlas pages. Default true. */
  atlas?: boolean;
  /** Indent the JSON (bigger file). Default false. */
  pretty?: boolean;
}

export interface ExportResult {
  dir: string;
  files: { path: string; bytes: number }[];
  pages: { name: string; width: number; height: number; fill: number }[];
}

/**
 * Writes a game-ready copy of a skeleton to `<dest>/<name>/`: minified `<name>.l2d.json` plus
 * its images, packed into atlas pages by default (optionally downscaled).
 */
export async function exportSkeleton(path: string, dest: string, options: ExportOptions = {}): Promise<ExportResult> {
  const src = resolve(path);
  const file = JSON.parse(await readFile(src, 'utf8')) as L2DFile;
  const check = validate(file);
  if (!check.ok) throw new Error(`Cannot export an invalid skeleton:\n${check.errors.map((e) => `  ${e.path}: ${e.message}`).join('\n')}`);
  const dir = resolve(dest, file.name);
  if (dir === dirname(src))
    throw new Error(`Exporting into ${dir} would overwrite the project's own ${file.name}.l2d.json; export into another folder (e.g. the game's assets).`);
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  let out = file;
  let pages: ExportResult['pages'] = [];

  if (options.atlas ?? true) {
    const atlas = await packAtlas(file, (p) => readFile(join(dirname(src), p)), options);
    // Pages from an earlier export that this one no longer makes (fewer pages now).
    const page = new RegExp(`^${file.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(-\\d+)?\\.png$`);
    for (const f of await readdir(dir)) if (page.test(f) && !(f in atlas.pages)) await rm(join(dir, f));
    for (const [name, png] of Object.entries(atlas.pages)) {
      await writeFile(join(dir, name), png);
      written.push(join(dir, name));
    }
    out = atlas.file;
    pages = atlas.report.pages;
  } else {
    if (options.scale && options.scale !== 1) throw new Error('scale needs atlas packing (atlas: true)');
    for (const img of new Set(Object.values(file.images).map((i) => i.path))) {
      const target = join(dir, img);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(dirname(src), img), target);
      written.push(target);
    }
  }
  const jsonPath = join(dir, `${file.name}.l2d.json`);
  await writeFile(jsonPath, JSON.stringify(out, null, options.pretty ? 2 : undefined) + '\n');
  written.unshift(jsonPath);
  const files = await Promise.all(written.map(async (p) => ({ path: p, bytes: (await stat(p)).size })));
  return { dir, files, pages };
}
