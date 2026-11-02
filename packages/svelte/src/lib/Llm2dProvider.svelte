<!--
  Places an LLM2D skeleton in a pixi-svelte scene, like pixi-svelte's <SpineProvider>.

  <Llm2dProvider key="fox" x={400} y={600} height={300}>
    <Llm2dTrack trackIndex={0} animationName="idle" loop />
  </Llm2dProvider>

  `key` reads pixi-svelte's loadedAssets (declare the asset as { type: 'sprite', src: '.../fox.l2d.json' }
  and call registerLlm2dLoader() before the app loads). Or pass `asset` (a LoadedLlm2d) directly.
-->
<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type * as PIXI from 'pixi.js';
  import type { DebugOptions, Llm2dActor, LoadedLlm2d } from '@llm2d/pixi';

  type Point = PIXI.PointData | number | undefined;

  export type Props = Omit<PIXI.ContainerOptions, 'children' | 'scale' | 'pivot' | 'width' | 'height'> & {
    /** Asset key in pixi-svelte's loadedAssets. */
    key?: string;
    /** Loaded skeleton, instead of `key`. */
    asset?: LoadedLlm2d;
    /** Point of the skeleton's bounds placed at (x, y): 0.5 = centre. Default: the skeleton origin. */
    anchor?: Point;
    /** Fit the skeleton's bounds to this width and/or height (keeps proportions when only one is given). */
    width?: number;
    height?: number;
    scale?: Point;
    debug?: boolean | DebugOptions;
    autoUpdate?: boolean;
    onactor?: (actor: Llm2dActor) => void;
    children?: Snippet;
  };
</script>

<script lang="ts">
  import { getContextApp } from 'pixi-svelte';
  import BaseLlm2dProvider from './BaseLlm2dProvider.svelte';

  const { key, asset, anchor, width, height, scale: scaleProp, children, ...rest }: Props = $props();
  const app = getContextApp();

  const loaded = $derived(asset ?? (key ? (app.stateApp.loadedAssets?.[key] as unknown as LoadedLlm2d | undefined) : undefined));

  const xy = (p: Point, fallback: number) => (typeof p === 'number' ? { x: p, y: p } : { x: p?.x ?? fallback, y: p?.y ?? fallback });

  const scale = $derived.by(() => {
    const extra = xy(scaleProp, 1);
    const b = loaded?.data.bounds;
    if (!b || (!width && !height) || !(b.width > 0 && b.height > 0)) return extra;
    let sx = width ? width / b.width : height! / b.height;
    let sy = height ? height / b.height : sx;
    if (!height) sy = sx;
    if (!width) sx = sy;
    return { x: sx * extra.x, y: sy * extra.y };
  });

  const pivot = $derived.by(() => {
    const b = loaded?.data.bounds;
    if (!b || anchor === undefined) return { x: 0, y: 0 };
    const a = xy(anchor, 0);
    return { x: b.x + b.width * a.x, y: b.y + b.height * a.y };
  });
</script>

{#if !loaded}
  {console.error(`Llm2dProvider: no skeleton for key "${key}". Declare it in the assets and call registerLlm2dLoader().`)}
{:else}
  {#key loaded}
    <BaseLlm2dProvider {...rest} {loaded} {scale} {pivot}>
      {@render children?.()}
    </BaseLlm2dProvider>
  {/key}
{/if}
