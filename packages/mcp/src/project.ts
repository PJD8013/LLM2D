import { copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, join, relative, resolve } from 'node:path';
import {
  SkeletonData,
  bendTest,
  validate,
  type BendReport,
  type L2DAnimation,
  type L2DFile,
  type ValidationResult,
} from '@llm2d/core';
import {
  alphaBounds,
  buildRig,
  composite,
  readPicture,
  readPsd,
  splitArt,
  writePsd,
  type LayeredArt,
  type RGBAImage,
  type RigResult,
  type RigSpec,
  type SplitFile,
  type SplitResult,
} from '@llm2d/rig';

/** File types create_project treats as a flat picture to split (anything else must be a PSD). */
export const PICTURE = /\.(png|jpe?g|webp)$/i;

/** Decodes a picture file (PNG, JPEG, WebP) to RGBA. JPEG and WebP go through the browser. */
export type Decoder = (bytes: Uint8Array, fileName: string) => Promise<RGBAImage>;

/** Segmenting a big picture takes seconds; keep the last few results by file, date and settings. */
const pictures = new Map<string, ReturnType<typeof readPicture>>();

let tmpCount = 0;
/** Writes a file whole or not at all (temp file + rename), so a crash or a concurrent reader never sees half of it. */
export async function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.${process.pid}.${++tmpCount}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

/** Pending work per project folder: changes to one project run one after another. */
const locks = new Map<string, Promise<unknown>>();

/** Animation timelines that point at bones, slots, IK constraints or attachments the skeleton lacks. */
export function staleTimelines(file: L2DFile, animations: Record<string, L2DAnimation>): { clean: Record<string, L2DAnimation>; removed: string[] } {
  const bones = new Set(file.bones.map((b) => b.name));
  const slots = new Set(file.slots.map((s) => s.name));
  const ik = new Set((file.ik ?? []).map((c) => c.name));
  const removed: string[] = [];
  const clean = structuredClone(animations);
  for (const [name, anim] of Object.entries(clean)) {
    for (const b of Object.keys(anim.bones ?? {}))
      if (!bones.has(b)) {
        delete anim.bones![b];
        removed.push(`animations.${name}.bones.${b}`);
      }
    for (const [s, tl] of Object.entries(anim.slots ?? {})) {
      if (!slots.has(s)) {
        delete anim.slots![s];
        removed.push(`animations.${name}.slots.${s}`);
        continue;
      }
      const names = new Set(Object.keys(file.attachments[s] ?? {}));
      if (tl.attachment?.some((k) => k.name !== null && !names.has(k.name))) {
        delete tl.attachment;
        removed.push(`animations.${name}.slots.${s}.attachment`);
      }
    }
    for (const c of Object.keys(anim.ik ?? {}))
      if (!ik.has(c)) {
        delete anim.ik![c];
        removed.push(`animations.${name}.ik.${c}`);
      }
  }
  return { clean, removed };
}

/** Rig spec as stored in a project: the build spec plus where the art lives. */
export type ProjectSpec = RigSpec & { art?: string };

/** split.json in a project made from a flat picture: the split settings plus the picture's path. */
export type ProjectSplit = SplitFile & { picture: string };

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

  /** Runs `fn` after every earlier change to this project folder (from this process) is done. */
  async locked<T>(fn: () => Promise<T>): Promise<T> {
    const before = locks.get(this.dir) ?? Promise.resolve();
    const run = before.then(fn, fn);
    const settled = run.catch(() => {});
    locks.set(this.dir, settled);
    try {
      return await run;
    } finally {
      if (locks.get(this.dir) === settled) locks.delete(this.dir);
    }
  }

  get specPath() {
    return join(this.dir, 'rig.json');
  }
  get animationsPath() {
    return join(this.dir, 'animations.json');
  }
  get splitPath() {
    return join(this.dir, 'split.json');
  }

  async readSplit(): Promise<ProjectSplit | null> {
    if (!(await this.exists(this.splitPath))) return null;
    return JSON.parse(await readFile(this.splitPath, 'utf8'));
  }

  async requireSplit(): Promise<ProjectSplit> {
    const split = await this.readSplit();
    if (!split) throw new Error(`No split.json in ${this.dir}: this project was not made from a flat picture.`);
    return split;
  }

  async writeSplit(split: ProjectSplit): Promise<void> {
    await writeAtomic(this.splitPath, JSON.stringify(split, null, 2) + '\n');
  }

  /** The flat picture with its background removed and its segmentation (cached). */
  async readPicture(decode: Decoder, settings?: Pick<SplitFile, 'background' | 'detail'>) {
    const split = await this.requireSplit();
    const path = resolve(this.dir, split.picture);
    const use = { background: settings?.background ?? split.background, detail: settings?.detail ?? split.detail };
    const key = `${path}\u0000${(await stat(path)).mtimeMs}\u0000${JSON.stringify(use)}`;
    let picture = pictures.get(key);
    if (!picture) {
      picture = readPicture(await decode(await readFile(path), path), use);
      pictures.set(key, picture);
      while (pictures.size > 3) pictures.delete(pictures.keys().next().value!);
    }
    return picture;
  }

  /**
   * Splits the flat picture into layers with `parts` (back to front), writes the layered PSD that
   * rig.json points at, and saves the split settings to split.json.
   */
  async split(decode: Decoder, spec: Omit<SplitFile, 'background' | 'detail'>): Promise<SplitResult & { psd: string }> {
    const split = await this.requireSplit();
    const picture = await this.readPicture(decode);
    const result = splitArt(picture.image, picture.segmentation, spec);
    const rig = await this.requireSpec();
    const psd = resolve(this.dir, rig.art ?? join('source', `${rig.name}.psd`));
    await mkdir(join(psd, '..'), { recursive: true });
    await writeAtomic(psd, writePsd(result.art));
    await this.writeSplit({ picture: split.picture, background: split.background, detail: split.detail, ...spec });
    return { ...result, psd };
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
    await writeAtomic(this.specPath, JSON.stringify(spec, null, 2) + '\n');
  }

  async readArt(): Promise<LayeredArt> {
    const spec = await this.requireSpec();
    if (!spec.art) throw new Error('rig.json has no "art" path to the PSD.');
    const path = resolve(this.dir, spec.art);
    if (!(await this.exists(path)) && (await this.readSplit()))
      throw new Error('This project starts from a flat picture that has not been split into layers yet. Call split_art first.');
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
    return this.locked(() => this.saveAnimations(animations));
  }

  /**
   * Reads the animations, changes them with `fn` and saves them, with no other change to this
   * project in between (two tools at once cannot lose each other's work).
   */
  async updateAnimations(
    fn: (animations: Record<string, L2DAnimation>) => Record<string, L2DAnimation> | void,
  ): Promise<{ result: ValidationResult; animations: Record<string, L2DAnimation> }> {
    return this.locked(async () => {
      const animations = await this.readAnimations();
      const next = fn(animations) ?? animations;
      return { result: await this.saveAnimations(next), animations: next };
    });
  }

  private async saveAnimations(animations: Record<string, L2DAnimation>): Promise<ValidationResult> {
    const path = await this.requireSkeletonPath();
    const file = JSON.parse(await readFile(path, 'utf8')) as L2DFile;
    file.animations = animations;
    const result = validate(file);
    if (!result.ok) return result;
    await writeAtomic(this.animationsPath, JSON.stringify(animations, null, 2) + '\n');
    await writeAtomic(path, JSON.stringify(file, null, 2) + '\n');
    return result;
  }

  /**
   * Rigs the art with rig.json (+ animations.json), writes the skeleton and runs the bend test.
   * Animation timelines of bones, slots, IK constraints or attachments the new rig no longer has
   * are dropped from animations.json and listed in `removed`; a skeleton left from an earlier
   * name is deleted.
   */
  async build(): Promise<{ result: RigResult; bend: BendReport; path: string; removed: string[]; replaced: string[] }> {
    return this.locked(async () => {
      const spec = await this.requireSpec();
      const art = await this.readArt();
      const { art: _art, ...rigSpec } = spec;
      const rig = buildRig(art, rigSpec, {});
      const { clean, removed } = staleTimelines(rig.file, await this.readAnimations());
      const result = buildRig(art, rigSpec, clean);
      await mkdir(join(this.dir, 'images'), { recursive: true });
      for (const [name, png] of Object.entries(result.images)) await writeAtomic(join(this.dir, 'images', `${name}.png`), png);
      const path = join(this.dir, `${spec.name}.l2d.json`);
      await writeAtomic(path, JSON.stringify(result.file, null, 2) + '\n');
      if (removed.length || !(await this.exists(this.animationsPath)))
        await writeAtomic(this.animationsPath, JSON.stringify(result.file.animations, null, 2) + '\n');
      const replaced: string[] = [];
      for (const f of await readdir(this.dir))
        if (f.endsWith('.l2d.json') && join(this.dir, f) !== path) {
          await rm(join(this.dir, f));
          replaced.push(f);
        }
      const bend = bendTest(SkeletonData.fromJSON(result.file));
      return { result, bend, path, removed, replaced };
    });
  }

  /**
   * Creates a project around a PSD, or around a flat picture (PNG/JPEG/WebP) that split_art will
   * turn into a PSD: copies the art into source/ and writes a starter rig.json (and split.json).
   */
  static async create(
    dir: string,
    artPath: string,
    options: { kind: 'character' | 'symbol'; name?: string; scale?: number; overwrite?: boolean; decode?: Decoder; background?: string; detail?: number },
  ) {
    const project = new Project(dir);
    if ((await project.exists(project.specPath)) && !options.overwrite)
      throw new Error(`${project.specPath} already exists. Pass overwrite: true to start over, or use set_rig_spec to change it.`);
    await mkdir(join(project.dir, 'source'), { recursive: true });
    const artName = basename(artPath);
    const target = join(project.dir, 'source', artName);
    if (resolve(artPath) !== target) await copyFile(resolve(artPath), target);
    const name = (options.name ?? basename(project.dir)).replace(/[^A-Za-z0-9_-]+/g, '_');

    let art: LayeredArt;
    let artFile = target;
    let picture: ReturnType<typeof readPicture> | null = null;
    if (PICTURE.test(artName)) {
      if (!options.decode) throw new Error('No picture decoder available.');
      await project.writeSplit({ picture: relative(project.dir, target), background: options.background ?? 'auto', detail: options.detail, parts: [] });
      picture = await project.readPicture(options.decode);
      const img = picture.image;
      art = { width: img.width, height: img.height, layers: [{ name: 'picture', x: 0, y: 0, image: img, hidden: false, opacity: 1, blend: 'normal' }], warnings: [] };
      artFile = join(project.dir, 'source', `${name}.psd`);
    } else {
      art = readPsd(await readFile(target));
    }

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
    const spec: ProjectSpec = {
      name,
      art: relative(project.dir, artFile),
      scale,
      origin,
      bones: [],
      parts: {},
    };
    await project.writeSpec(spec);
    if (!(await project.exists(project.animationsPath))) await writeAtomic(project.animationsPath, '{}\n');
    return { project, art, spec, picture };
  }
}
