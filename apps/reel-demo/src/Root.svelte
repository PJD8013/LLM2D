<script lang="ts">
  import { App, createApp, setContextApp } from 'pixi-svelte';
  import assets from './assets';
  import Scene from './Scene.svelte';
  import { game, spin } from './game.svelte';

  const { stateApp } = createApp({ assets });
  setContextApp({ stateApp });
</script>

<App>
  {#if stateApp.loaded}
    <Scene />
  {/if}
</App>

<div class="ui">
  <div class="status" data-testid="status">{stateApp.loaded ? game.message : `로딩 ${Math.round(stateApp.loadingProgress)}%`}</div>
  <button type="button" onclick={spin} disabled={!stateApp.loaded || game.spinning} data-testid="spin">SPIN</button>
  <div class="hint">LLM2D × pixi-svelte · 착지 이벤트 {game.landEvents}</div>
</div>

<style>
  .ui {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 24px;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    pointer-events: none;
    color: #f4f1e8;
  }
  .status {
    font-size: 20px;
    font-weight: 700;
    text-shadow: 0 2px 6px #000a;
  }
  button {
    pointer-events: auto;
    min-width: 160px;
    padding: 14px 28px;
    border: 0;
    border-radius: 999px;
    font-family: inherit;
    font-size: 22px;
    font-weight: 800;
    line-height: 1;
    letter-spacing: 0.08em;
    color: #3b2200;
    background: linear-gradient(#ffe38a, #f5a623);
    box-shadow: 0 4px 0 #a86a10, 0 8px 24px #0008;
    cursor: pointer;
  }
  button:disabled {
    filter: grayscale(0.6) brightness(0.8);
    cursor: default;
  }
  .hint {
    font-size: 12px;
    opacity: 0.6;
  }
</style>
