import {
  Assets,
  DOMAdapter,
  ExtensionType,
  LoaderParserPriority,
  Rectangle,
  Texture,
  extensions,
  type Loader,
  type LoaderParser,
} from 'pixi.js';
import { SkeletonData, type L2DImage } from '@llm2d/core';

export interface LoadedLlm2d {
  data: SkeletonData;
  textures: Record<string, Texture>;
}

/**
 * Texture per image name from already-loaded pages (PNG path -> texture). Images with a
 * `frame` become sub-textures of their atlas page.
 */
export function cutTextures(images: Record<string, L2DImage>, pages: Record<string, Texture>): Record<string, Texture> {
  const out: Record<string, Texture> = {};
  for (const [name, img] of Object.entries(images)) {
    const page = pages[img.path];
    if (!page) throw new Error(`No texture for "${img.path}" (image "${name}")`);
    out[name] = img.frame
      ? new Texture({ source: page.source, frame: new Rectangle(img.frame.x, img.frame.y, img.frame.width, img.frame.height) })
      : page;
  }
  return out;
}

/** Loads every PNG referenced by `images` once (atlas pages are shared) and cuts the frames. */
export async function loadImageTextures(
  images: Record<string, L2DImage>,
  baseUrl: string,
  loadPage: (url: string) => Promise<Texture> = (url) => Assets.load<Texture>(url),
): Promise<Record<string, Texture>> {
  const paths = [...new Set(Object.values(images).map((i) => i.path))];
  const pages = Object.fromEntries(await Promise.all(paths.map(async (p) => [p, await loadPage(new URL(p, baseUrl).href)] as const)));
  return cutTextures(images, pages);
}

/**
 * Loads a `.l2d.json` file and the images it references (paths are relative to the file).
 * Pass `json` to skip fetching the file itself, e.g. when it is bundled.
 */
export async function loadLlm2d(url: string, json?: unknown): Promise<LoadedLlm2d> {
  const base = new URL(url, globalThis.location?.href).href;
  const raw = json ?? (await (await fetch(base)).json());
  const data = SkeletonData.fromJSON(raw);
  return { data, textures: await loadImageTextures(data.images, base) };
}

/** Builds a SkeletonData from already-loaded JSON plus textures (e.g. from drag & drop). */
export function fromLoaded(json: unknown, textures: Record<string, Texture>): LoadedLlm2d {
  const data = SkeletonData.fromJSON(json);
  const missing = Object.keys(data.images).filter((n) => !textures[n]);
  if (missing.length) throw new Error(`Missing textures for images: ${missing.join(', ')}`);
  return { data, textures };
}

/**
 * PixiJS Assets parser for `*.l2d.json`: `Assets.load('fox.l2d.json')` resolves to a
 * LoadedLlm2d (data + textures), ready for `new Llm2dActor(loaded)`. Because pixi-svelte's
 * AssetsLoader passes "sprite" assets straight through Assets.load, a Stake game can preload
 * a skeleton by declaring it as `{ type: 'sprite', src: '.../fox.l2d.json' }`.
 */
export const llm2dAssetLoader = {
  extension: { type: ExtensionType.LoadParser, priority: LoaderParserPriority.High, name: 'llm2d' },
  name: 'llm2d',
  test: (url: string) => /\.l2d\.json(?:[?#].*)?$/i.test(url),
  async load(url: string, _asset?: unknown, loader?: Loader): Promise<LoadedLlm2d> {
    const json = await (await DOMAdapter.get().fetch(url)).json();
    const data = SkeletonData.fromJSON(json);
    const base = new URL(url, globalThis.location?.href).href;
    const textures = await loadImageTextures(data.images, base, (u) => (loader ? loader.load<Texture>(u) : Assets.load<Texture>(u)));
    return { data, textures };
  },
  unload(asset: LoadedLlm2d) {
    // Frame textures are views on the pages; the pages themselves stay in the Assets cache.
    for (const t of Object.values(asset.textures)) if (t.frame.width !== t.source.width || t.frame.height !== t.source.height) t.destroy(false);
  },
} satisfies LoaderParser<LoadedLlm2d>;

let registered = false;

/** Registers `llm2dAssetLoader` with PixiJS once. Call before loading `.l2d.json` assets. */
export function registerLlm2dLoader(): void {
  if (registered) return;
  registered = true;
  extensions.add(llm2dAssetLoader);
}
