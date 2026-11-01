<!--
  Plays an animation on a track of the enclosing <Llm2dProvider>, like pixi-svelte's <SpineTrack>.
  Changing `animationName` crossfades (state.defaultMix or `mix`). Removing the component fades
  the track out over `mixOut` seconds.
-->
<script lang="ts" module>
  import type { TrackEntry } from '@llm2d/core';

  export type Props = Partial<Pick<TrackEntry, 'timeScale' | 'alpha' | 'listener'>> & {
    trackIndex: number;
    animationName: string;
    loop?: boolean;
    /** Crossfade into this animation, in seconds. Default: the state's defaultMix. */
    mix?: number;
    /** Fade-out when the component is removed, in seconds. Default 0. */
    mixOut?: number;
  };
</script>

<script lang="ts">
  import { onDestroy } from 'svelte';
  import { getContextLlm2d } from './context.js';

  const props: Props = $props();
  const actor = getContextLlm2d();
  let entry: TrackEntry | null = null;

  /** Copies the entry options from props (also onto entries created later). */
  const applyOptions = (e: TrackEntry) => {
    e.loop = props.loop ?? false;
    if (props.timeScale !== undefined) e.timeScale = props.timeScale;
    if (props.alpha !== undefined) e.alpha = props.alpha;
    e.listener = props.listener ?? null;
  };

  $effect(() => {
    const { trackIndex, animationName } = props;
    if (entry && entry.trackIndex === trackIndex && entry.animation.name === animationName && actor.state.getCurrent(trackIndex) === entry) {
      applyOptions(entry);
      return;
    }
    try {
      const previous = actor.state.defaultMix;
      if (props.mix !== undefined) actor.state.defaultMix = props.mix;
      entry = actor.state.setAnimation(trackIndex, animationName, props.loop ?? false);
      actor.state.defaultMix = previous;
      applyOptions(entry);
    } catch (error) {
      console.error(error);
    }
  });

  onDestroy(() => {
    if (!actor.destroyed) actor.state.setEmptyAnimation(props.trackIndex, props.mixOut ?? 0);
  });
</script>
