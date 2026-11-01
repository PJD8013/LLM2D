<script lang="ts">
  import { Container, Rectangle } from 'pixi-svelte';
  import { innerHeight, innerWidth } from 'svelte/reactivity/window';
  import { Llm2dProvider, Llm2dTrack } from '@llm2d/svelte';
  import Cell from './Cell.svelte';
  import { CELL, COLS, ROWS, game } from './game.svelte';

  // Lay out a 1280x720 design area, scaled to fit the window.
  const W = 1280;
  const H = 720;
  const scale = $derived(Math.min((innerWidth.current ?? W) / W, (innerHeight.current ?? H) / H));
  const boardX = 120;
  const boardY = 70;

  let blink = $state(false);
  $effect(() => {
    const id = setInterval(() => {
      blink = true;
      setTimeout(() => (blink = false), 220);
    }, 3200);
    return () => clearInterval(id);
  });
</script>

<Container x={((innerWidth.current ?? W) - W * scale) / 2} y={((innerHeight.current ?? H) - H * scale) / 2} scale={scale}>
  <Rectangle
    x={boardX - 16}
    y={boardY - 16}
    width={COLS * CELL + 32}
    height={ROWS * CELL + 32}
    borderRadius={24}
    backgroundColor={0x1d2236}
    borderColor={0xf5b730}
    borderWidth={4}
  />
  {#key game.spinId}
    {#each game.grid as column, c (c)}
      {#each column as symbol, r (r)}
        <Cell {symbol} col={c} row={r} x={boardX + c * CELL + CELL / 2} y={boardY + r * CELL + CELL / 2} win={game.wins[c][r]} />
      {/each}
    {/each}
  {/key}

  <!-- Host character: idle, cheers on a win. -->
  <Llm2dProvider key="fox" x={1080} y={600} height={520}>
    <Llm2dTrack
      trackIndex={0}
      animationName={game.host}
      loop={game.host === 'idle'}
      mix={0.2}
      listener={{ complete: (e) => e.animation.name === 'cheer' && (game.host = 'idle') }}
    />
    {#if blink && game.host === 'idle'}
      <Llm2dTrack trackIndex={1} animationName="blink" />
    {/if}
  </Llm2dProvider>
</Container>
