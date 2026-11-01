import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  SkeletonData,
  bendTest,
  validate,
  type BendReport,
  type L2DAnimation,
  type L2DFile,
  type ValidationResult,
} from '@llm2d/core';
import { alphaBounds, buildRig, composite, readPsd, type LayeredArt, type RigResult, type RigSpec } from '@llm2d/rig';

/** Rig spec as stored in a project: the build spec plus where the art lives. */
export type ProjectSpec = RigSpec & { art?: string };

/**
 * An LLM2D project folder:
 *   rig.json          rig spec (joints in art pixels) + "art": path to the PSD
 *   animations.json   { name: animation } — the source of truth for animations
 *   <name>.l2d.json   built skeleton (+ images/)
 *   source/           the art
 * A folder with only a .l2d.json (no rig.json) also works for animating.
 */
export class Project {
  readonly dir: string;
  private artCache: { path: string; mtime: number; art: LayeredArt } | null = null;

  constructor(dir: string) {
    this.dir = resolve(dir);
  }

  get specPath() {
    return join(this.dir, 'rig.json');
  }
  get animationsPath() {
    return join(this.dir, 'animations.json');
  }

  async exists(path: string): Promise<boolean> {
    return stat(path).then(
      () => true,
      () => false,
    );
  }

  async readSpec(): Promise<ProjectSpec | null> {
    if (!(await this.exists(this.specPath))) return null;
    return JSON.parse(await readFile(this.specPath, 'utf8'));
  }

  async requireSpec(): Promise<ProjectSpec> {
    const spec = await this.readSpec();
    if (!spec) throw new Error(`No rig.json in ${this.dir}. Use create_project first, or set_rig_spec.`);
    return spec;
  }

  async writeSpec(spec: ProjectSpec): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await writeFile(this.specPath, JSON.stringify(spec, null, 2) + '\n');
  }

  async readArt(): Promise<LayeredArt> {
    const spec = await this.requireSpec();
    if (!spec.art) throw new Error('rig.json has no "art" path to the PSD.');
    const path = resolve(this.dir, spec.art);
    const mtime = (await stat(path)).mtimeMs;
    if (this.artCache?.path === path && this.artCache.mtime === mtime) return this.artCache.art;
    const art = readPsd(await readFile(path));
    this.artCache = { path, mtime, art };
    return art;
  }

  /** Path of the built skeleton, or null if there is none yet. */
  async skeletonPath(): Promise<string | null> {
    const spec = await this.readSpec();
    if (spec) {
      const p = join(this.dir, `${spec.name}.l2d.json`);
      return (await this.exists(p)) ? p : null;
    }
    const files = (await readdir(this.dir).catch(() => [] as string[])).filter((f) => f.endsWith('.l2d.json'));
    if (files.length > 1) throw new Error(`Several .l2d.json files in ${this.dir}: ${files.join(', ')}. Keep one per project.`);
    return files.length ? join(this.dir, files[0]) : null;
  }

  async requireSkeletonPath(): Promise<string> {
    const p = await this.skeletonPath();
    if (!p) throw new Error(`No skeleton built in ${this.dir} yet. Run build_rig first.`);
    return p;
  }

  async readSkeleton(): Promise<L2DFile> {
    return JSON.parse(await readFile(await this.requireSkeletonPath(), 'utf8'));
  }

  async readAnimations(): Promise<Record<string, L2DAnimation>> {
    if (await this.exists(this.animationsPath)) return JSON.parse(await readFile(this.animationsPath, 'utf8'));
    const p = await this.skeletonPath();
    return p ? (JSON.parse(await readFile(p, 'utf8')) as L2DFile).animations : {};
  }

  /**
   * Saves animations to animations.json and patches them into the built skeleton (no re-rig).
   * Returns the skeleton's validation result; nothing is written if it has errors.
   */
  async writeAnimations(animations: Record<string, L2DAnimation>): Promise<ValidationResult> {
    const path = await this.requireSkeletonPath();
    const file = JSON.parse(await readFile(path, 'utf8')) as L2DFile;
    file.animations = animations;
    const result = validate(file);
    if (!result.ok) return result;
    await writeFile(this.animationsPath, JSON.stringify(animations, null, 2) + '\n');
    await writeFile(path, JSON.stringify(file, null, 2) + '\n');
    return result;
  }

  /** Rigs the art with rig.json (+ animations.json), writes the skeleton and runs the bend test. */
  async build(): Promise<{ result: RigResult; bend: BendReport; path: string }> {
    const spec = await this.requireSpec();
    const art = await this.readArt();
    const { art: _art, ...rigSpec } = spec;
    const result = buildRig(art, rigSpec, await this.readAnimations());
    await mkdir(join(this.dir, 'images'), { recursive: true });
    for (const [name, png] of Object.entries(result.images)) await writeFile(join(this.dir, 'images', `${name}.png`), png);
    const path = join(this.dir, `${spec.name}.l2d.json`);
    await writeFile(path, JSON.stringify(result.file, null, 2) + '\n');
    if (!(await this.exists(this.animationsPath)))
      await writeFile(this.animationsPath, JSON.stringify(result.file.animations, null, 2) + '\n');
    const bend = bendTest(SkeletonData.fromJSON(result.file));
    return { result, bend, path };
  }

  /** Creates a project around a PSD: copies it into source/ and writes a starter rig.json. */
  static async create(dir: string, artPath: string, options: { kind: 'character' | 'symbol'; name?: string; scale?: number; overwrite?: boolean }) {
    const project = new Project(dir);
    if ((await project.exists(project.specPath)) && !options.overwrite)
      throw new Error(`${project.specPath} already exists. Pass overwrite: true to start over, or use set_rig_spec to change it.`);
    const art = readPsd(await readFile(resolve(artPath)));
    await mkdir(join(project.dir, 'source'), { recursive: true });
    const artName = basename(artPath);
    const target = join(project.dir, 'source', artName);
    if (resolve(artPath) !== target) await copyFile(resolve(artPath), target);

    // Origin: between the feet for characters (centre of the lowest opaque rows, so a tail or
    // a raised arm does not pull it sideways), centre of the art for symbols.
    const flat = composite(art.layers, art.width, art.height);
    const bounds = alphaBounds(flat, 8);
    if (!bounds) throw new Error('The art is empty.');
    let origin: [number, number];
    if (options.kind === 'symbol') origin = [Math.round(bounds.x + bounds.width / 2), Math.round(bounds.y + bounds.height / 2)];
    else {
      const bottom = bounds.y + bounds.height - 1;
      const band = Math.max(2, Math.round(bounds.height * 0.04));
      let sum = 0;
      let n = 0;
      for (let y = bottom - band; y <= bottom; y++)
        for (let x = 0; x < art.width; x++)
          if (flat.data[(y * art.width + x) * 4 + 3] > 8) {
            sum += x;
            n++;
          }
      origin = [Math.round(n ? sum / n : bounds.x + bounds.width / 2), bottom + 1];
    }
    const scale = options.scale ?? (Math.max(art.width, art.height) > 1200 ? 0.5 : 1);
    const name = (options.name ?? basename(dir)).replace(/[^A-Za-z0-9_-]+/g, '_');
    const spec: ProjectSpec = {
      name,
      art: relative(project.dir, target),
      scale,
      origin,
      bones: [],
      parts: {},
    };
    await project.writeSpec(spec);
    if (!(await project.exists(project.animationsPath))) await writeFile(project.animationsPath, '{}\n');
    return { project, art, spec };
  }

  /** Copies the skeleton and its images into `dest/<name>/`. */
  async export(dest: string): Promise<string[]> {
    const path = await this.requireSkeletonPath();
    const file = JSON.parse(await readFile(path, 'utf8')) as L2DFile;
    const out = resolve(dest, file.name);
    const written: string[] = [];
    await mkdir(join(out, 'images'), { recursive: true });
    await writeFile(join(out, `${file.name}.l2d.json`), JSON.stringify(file) + '\n');
    written.push(join(out, `${file.name}.l2d.json`));
    for (const img of Object.values(file.images)) {
      const target = join(out, img.path);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(join(dirname(path), img.path), target);
      written.push(target);
    }
    return written;
  }
}
