<script lang="ts">
  import { onMount } from 'svelte';
  import { Llm2dProvider, Llm2dTrack } from '@llm2d/svelte';
  import { CELL, SYMBOLS, delayOf, game, type SymbolId } from './game.svelte';

  type Props = { symbol: SymbolId; col: number; row: number; x: number; y: number; win: boolean };
  const { symbol, col, row, x, y, win }: Props = $props();

  let visible = $state(false);
  let landed = $state(false);
  onMount(() => {
    const t = setTimeout(() => (visible = true), delayOf(col, row));
    return () => clearTimeout(t);
  });

  const animation = $derived(win ? 'win' : landed ? 'idle' : 'land');
  const info = $derived(SYMBOLS[symbol]);
  const listener = {
    complete: (e: { animation: { name: string } }) => {
      if (e.animation.name === 'land') landed = true;
    },
    event: (_e: unknown, ev: { name: string }) => {
      if (ev.name === 'land') game.landEvents++;
    },
  };
</script>

<Llm2dProvider key={info.key} {x} {y} anchor={0.5} width={CELL * 0.78 * info.size} tint={info.tint} {visible}>
  {#if visible}
    <Llm2dTrack trackIndex={0} animationName={animation} loop={animation !== 'land'} mix={0.1} {listener} />
  {/if}
</Llm2dProvider>
