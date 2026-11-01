import { Assets, type Texture } from 'pixi.js';
import { SkeletonData } from '@llm2d/core';

export interface LoadedLlm2d {
  data: SkeletonData;
  textures: Record<string, Texture>;
}

/**
 * Loads a `.l2d.json` file and the images it references (paths are relative to the file).
 * Pass `json` to skip fetching the file itself, e.g. when it is bundled.
 */
export async function loadLlm2d(url: string, json?: unknown): Promise<LoadedLlm2d> {
  const base = new URL(url, globalThis.location?.href);
  const raw = json ?? (await (await fetch(base)).json());
  const data = SkeletonData.fromJSON(raw);
  const entries = await Promise.all(
    Object.entries(data.images).map(async ([name, img]) => {
      const texture = await Assets.load<Texture>(new URL(img.path, base).href);
      return [name, texture] as const;
    }),
  );
  return { data, textures: Object.fromEntries(entries) };
}

/** Builds a SkeletonData from already-loaded JSON plus textures (e.g. from drag & drop). */
export function fromLoaded(json: unknown, textures: Record<string, Texture>): LoadedLlm2d {
  const data = SkeletonData.fromJSON(json);
  const missing = Object.keys(data.images).filter((n) => !textures[n]);
  if (missing.length) throw new Error(`Missing textures for images: ${missing.join(', ')}`);
  return { data, textures };
}
