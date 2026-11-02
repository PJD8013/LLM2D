<!--
  Curve of the segment that starts at the selected key(s): a named easing or a custom cubic
  Bézier [x1, y1, x2, y2] edited by dragging its two handles.
-->
<script lang="ts">
  import { CURVE_NAMES, resolveCurve, type L2DCurve } from '@llm2d/core';

  interface Props {
    curve: L2DCurve | undefined;
    mixed?: boolean;
    /** `live` is true for the steps of a handle drag (between onbegin and onend). */
    onchange: (curve: L2DCurve | undefined, live?: boolean) => void;
    onbegin?: () => void;
    onend?: () => void;
  }
  let { curve, mixed = false, onchange, onbegin, onend }: Props = $props();

  const W = 176;
  const H = 120;
  const PAD = 14;
  const isCustom = $derived(Array.isArray(curve));
  const name = $derived(mixed ? '' : Array.isArray(curve) ? 'custom' : (curve ?? 'linear'));
  const bez = $derived<[number, number, number, number]>(Array.isArray(curve) ? curve : [0.25, 0.1, 0.25, 1]);

  // y of the curve can overshoot (back/elastic): fit the plot to its range.
  const plot = $derived.by(() => {
    const ease = resolveCurve(curve ?? 'linear') ?? ((t: number) => t);
    const pts: [number, number][] = [];
    for (let i = 0; i <= 60; i++) pts.push([i / 60, ease(i / 60)]);
    if (curve === 'stepped') pts.splice(0, pts.length, [0, 0], [1, 0], [1, 1]);
    const ys = pts.map((p) => p[1]).concat(isCustom ? [bez[1], bez[3]] : []);
    const lo = Math.min(0, ...ys);
    const hi = Math.max(1, ...ys);
    return { pts, lo, hi };
  });
  const sx = (x: number) => PAD + x * (W - 2 * PAD);
  const sy = (y: number) => H - PAD - ((y - plot.lo) / (plot.hi - plot.lo || 1)) * (H - 2 * PAD);
  const path = $derived(plot.pts.map(([x, y], i) => `${i ? 'L' : 'M'}${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(' '));

  let svg: SVGSVGElement;
  let dragging: 0 | 1 | null = null;

  function pick(name: string) {
    if (name === 'custom') onchange([0.25, 0.1, 0.25, 1]);
    else onchange(name === 'linear' ? undefined : name);
  }

  function moveHandle(e: PointerEvent) {
    if (dragging === null) return;
    const r = svg.getBoundingClientRect();
    const x = Math.min(1, Math.max(0, (e.clientX - r.left - PAD) / (W - 2 * PAD)));
    const y = plot.lo + ((H - PAD - (e.clientY - r.top)) / (H - 2 * PAD)) * (plot.hi - plot.lo);
    const next = [...bez] as [number, number, number, number];
    next[dragging * 2] = Math.round(x * 100) / 100;
    next[dragging * 2 + 1] = Math.round(Math.max(-1, Math.min(2, y)) * 100) / 100;
    onchange(next, true);
  }

  function release() {
    if (dragging === null) return;
    dragging = null;
    onend?.();
  }

  function setNumber(i: number, v: string) {
    const n = Number(v);
    if (!Number.isFinite(n)) return;
    const next = [...bez] as [number, number, number, number];
    next[i] = i % 2 === 0 ? Math.min(1, Math.max(0, n)) : n;
    onchange(next);
  }
</script>

<div class="curve">
  <select value={name} onchange={(e) => pick(e.currentTarget.value)} aria-label="곡선">
    {#if mixed}<option value="" disabled>(여러 곡선)</option>{/if}
    {#each CURVE_NAMES as c (c)}<option value={c}>{c}</option>{/each}
    <option value="custom">custom (베지어)</option>
  </select>
  <svg
    bind:this={svg}
    width={W}
    height={H}
    role="img"
    aria-label="곡선 모양"
    onpointermove={moveHandle}
    onpointerup={release}
    onpointercancel={release}
    onlostpointercapture={release}
  >
    <rect x={PAD} y={sy(1)} width={W - 2 * PAD} height={sy(0) - sy(1)} class="box" />
    <path d={path} class="line" />
    {#if isCustom}
      <line x1={sx(0)} y1={sy(0)} x2={sx(bez[0])} y2={sy(bez[1])} class="arm" />
      <line x1={sx(1)} y1={sy(1)} x2={sx(bez[2])} y2={sy(bez[3])} class="arm" />
      {#each [0, 1] as h (h)}
        <circle
          cx={sx(bez[h * 2])}
          cy={sy(bez[h * 2 + 1])}
          r="6"
          class="handle"
          role="slider"
          tabindex="0"
          aria-label={`손잡이 ${h + 1}`}
          aria-valuenow={bez[h * 2 + 1]}
          onpointerdown={(e) => {
            dragging = h as 0 | 1;
            svg.setPointerCapture(e.pointerId);
            onbegin?.();
          }}
        />
      {/each}
    {/if}
  </svg>
  {#if isCustom}
    <div class="nums">
      {#each bez as v, i (i)}
        <input type="number" step="0.05" value={v} onchange={(e) => setNumber(i, e.currentTarget.value)} aria-label={['x1', 'y1', 'x2', 'y2'][i]} />
      {/each}
    </div>
  {/if}
</div>

<style>
  .curve {
    display: grid;
    gap: 6px;
  }
  svg {
    background: #161824;
    border-radius: 6px;
    touch-action: none;
  }
  .box {
    fill: none;
    stroke: #ffffff18;
  }
  .line {
    fill: none;
    stroke: #ffb020;
    stroke-width: 2;
  }
  .arm {
    stroke: #6fd3ff88;
    stroke-width: 1.5;
  }
  .handle {
    fill: #6fd3ff;
    cursor: grab;
  }
  .nums {
    display: grid;
    grid-template-columns: repeat(4, 1fr);
    gap: 4px;
  }
  .nums input {
    width: 100%;
    min-width: 0;
  }
</style>
