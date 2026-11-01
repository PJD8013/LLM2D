import type { Assets } from 'pixi-svelte';

/**
 * Same shape as a Stake web-sdk game's assets.ts. LLM2D skeletons use type "sprite": pixi-svelte
 * passes them to PIXI.Assets.load, where registerLlm2dLoader() handles *.l2d.json.
 */
// Files in public/ are served from the site root (relative to the page so any base path works).
const url = (path: string) => new URL(`assets/${path}`, document.baseURI).href;

export default {
  gem: { type: 'sprite', src: url('gem/gem.l2d.json') },
  coin: { type: 'sprite', src: url('coin/coin.l2d.json') },
  fox: { type: 'sprite', src: url('kit/kit.l2d.json') },
} satisfies Assets;
