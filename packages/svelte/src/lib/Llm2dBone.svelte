<!--
  Children follow a bone of the enclosing <Llm2dProvider> (position, rotation, scale), drawn above
  the skeleton. For win frames, particles, coins in a hand, text on a sign.

  <Llm2dBone boneName="hand_r"><Sprite key="coin" anchor={0.5} /></Llm2dBone>
-->
<script lang="ts" module>
  import type { Snippet } from 'svelte';

  export type Props = { boneName: string; children: Snippet };
</script>

<script lang="ts">
  import { onDestroy } from 'svelte';
  import * as PIXI from 'pixi.js';
  import { createContextParent } from 'pixi-svelte';
  import { getContextLlm2d } from './context.js';

  const props: Props = $props();
  const actor = getContextLlm2d();
  const container = new PIXI.Container({ label: `bone:${props.boneName}` });

  actor.attachToBone(props.boneName, container);
  createContextParent(container);
  onDestroy(() => {
    if (!actor.destroyed) actor.detachFromBone(container);
    container.destroy({ children: true });
  });
</script>

{@render props.children()}
