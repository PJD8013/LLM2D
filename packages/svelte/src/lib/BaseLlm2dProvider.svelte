<script lang="ts" module>
  import type { Snippet } from 'svelte';
  import type * as PIXI from 'pixi.js';
  import type { DebugOptions, LoadedLlm2d } from '@llm2d/pixi';

  export type Props = Omit<PIXI.ContainerOptions, 'children'> & {
    loaded: LoadedLlm2d;
    debug?: boolean | DebugOptions;
    /** Advance with PIXI.Ticker.shared (default true). Set false to drive `actor.update(dt)` yourself. */
    autoUpdate?: boolean;
    /** Receives the actor once it exists (for imperative control). */
    onactor?: (actor: Llm2dActor) => void;
    children?: Snippet;
  };
</script>

<script lang="ts">
  import { onDestroy } from 'svelte';
  import { getContextParent, propsSyncEffect } from 'pixi-svelte';
  import { Llm2dActor } from '@llm2d/pixi';
  import { setContextLlm2d } from './context.js';

  const props: Props = $props();
  const parent = getContextParent();
  const actor = new Llm2dActor({ ...props.loaded, autoUpdate: props.autoUpdate ?? true });

  propsSyncEffect({ props, target: actor, ignore: ['loaded', 'children', 'debug', 'autoUpdate', 'onactor'] });
  $effect(() => {
    actor.debug = props.debug ?? false;
  });
  $effect(() => {
    actor.autoUpdate = props.autoUpdate ?? true;
  });

  // pixi-svelte destroys the node when the component unmounts.
  parent.addToParent(actor);
  setContextLlm2d(actor);
  props.onactor?.(actor);
  onDestroy(() => (actor.autoUpdate = false));
</script>

{@render props.children?.()}
