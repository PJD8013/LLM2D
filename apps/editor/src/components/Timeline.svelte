<!--
  Dope sheet: one row per keyed bone / slot / IK constraint (expand a row for its channels) and
  one for events. Click the ruler to move the playhead; click keys to select (Shift adds), drag
  them to move in time, drag on empty space to box-select, double-click a track to add a key.
  Ctrl/⌘ + wheel zooms, Shift + wheel scrolls in time.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { editor } from '../lib/editor.svelte.ts';
  import * as M from '../lib/model.ts';

  const LABEL_W = 180;
  const RULER_H = 26;
  const ROW_H = 22;
  const COLORS: Record<string, string> = {
    rotate: '#5ee38a',
    translate: '#5aa8ff',
    scale: '#ff7a6b',
    color: '#c58bff',
    alpha: '#cfd3e0',
    attachment: '#ffb347',
    mix: '#f5e05a',
    events: '#ffd84d',
  };

  let canvas: HTMLCanvasElement;
  let box: HTMLDivElement;
  let width = $state(800);
  let height = $state(200);
  let pps = $state(300); // pixels per second
  let scrollX = $state(0); // seconds at the left edge
  let scrollY = $state(0);
  let boxSel = $state<{ x0: number; y0: number; x1: number; y1: number } | null>(null);
  let fittedFor = '';

  const rows = $derived.by(() => {
    void editor.rev;
    if (!editor.data || !editor.animName) return [] as M.Row[];
    return M.timelineRows(editor.anim, editor.data, {
      expanded: new Set(editor.expanded),
      showAll: editor.showAll,
      selectedBone: editor.selectedBone,
      selectedSlot: editor.selectedSlot,
    });
  });

  const xOf = (t: number) => LABEL_W + (t - scrollX) * pps;
  const tOf = (x: number) => scrollX + (x - LABEL_W) / pps;
  const rowAt = (y: number) => Math.floor((y - RULER_H + scrollY) / ROW_H);
  const yOf = (i: number) => RULER_H + i * ROW_H - scrollY;
  const selectedIds = $derived(new Set(editor.selectedKeys.map(M.keyId)));

  /** Keys drawn on a row: [time, tracks keyed at that time]. */
  function rowKeys(row: M.Row): { time: number; refs: M.KeyRef[]; label?: string }[] {
    const anim = editor.anim;
    const out = new Map<string, { time: number; refs: M.KeyRef[]; label?: string }>();
    for (const tr of row.tracks)
      for (const k of M.keysOf(anim, tr)) {
        const id = k.time.toFixed(4);
        const e = out.get(id) ?? out.set(id, { time: k.time, refs: [] }).get(id)!;
        if (!e.refs.some((r) => M.trackId(r) === M.trackId(tr))) e.refs.push({ ...tr, time: k.time } as M.KeyRef);
        if (tr.group === 'events') e.label = e.label ? `${e.label}, ${k.name}` : String(k.name);
      }
    return [...out.values()].sort((a, b) => a.time - b.time);
  }

  // Fit the animation to the width when switching animations.
  $effect(() => {
    const key = `${editor.info?.id}/${editor.animName}`;
    if (key === fittedFor || !width) return;
    fittedFor = key;
    pps = Math.max(40, (width - LABEL_W - 40) / Math.max(0.5, editor.duration));
    scrollX = 0;
    scrollY = 0;
  });

  // Keep the playhead in view while playing.
  $effect(() => {
    const x = xOf(editor.time);
    if (editor.playing && (x > width - 20 || x < LABEL_W)) scrollX = Math.max(0, editor.time - 0.1);
  });

  $effect(() => {
    // Redraw on any change these read.
    void [editor.rev, editor.time, editor.selectedKeys, rows, width, height, pps, scrollX, scrollY, boxSel, editor.selectedBone, editor.selectedSlot, editor.fps];
    draw();
  });

  onMount(() => {
    const ro = new ResizeObserver(() => {
      width = box.clientWidth;
      height = box.clientHeight;
    });
    ro.observe(box);
    return () => ro.disconnect();
  });

  function draw() {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const ctx = canvas.getContext('2d')!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#1b1d29';
    ctx.fillRect(0, 0, width, height);
    if (!editor.data || !editor.animName) return;
    const dur = editor.duration;
    const fps = editor.fps;

    // Rows.
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, RULER_H, width, height - RULER_H);
    ctx.clip();
    rows.forEach((row, i) => {
      const y = yOf(i);
      if (y + ROW_H < RULER_H || y > height) return;
      const active = (row.kind === 'bone' && row.target === editor.selectedBone) || (row.kind === 'slot' && row.target === editor.selectedSlot);
      ctx.fillStyle = active ? '#2c3150' : i % 2 ? '#1f2230' : '#22263a';
      ctx.fillRect(0, y, width, ROW_H);
      // Label.
      ctx.fillStyle = row.depth ? '#9aa0b8' : '#e8eaf4';
      ctx.font = `${row.depth ? 400 : 600} 12px system-ui, sans-serif`;
      const indent = 8 + row.depth * 18;
      if (row.expandable) {
        ctx.fillStyle = '#9aa0b8';
        ctx.fillText(row.expanded ? '▾' : '▸', indent, y + 15);
      }
      ctx.fillStyle = row.depth ? (COLORS[row.tracks[0]?.channel] ?? '#9aa0b8') : '#e8eaf4';
      ctx.fillText(row.label, indent + 14, y + 15, LABEL_W - indent - 20);
      // Track area.
      ctx.save();
      ctx.beginPath();
      ctx.rect(LABEL_W, y, width - LABEL_W, ROW_H);
      ctx.clip();
      const keys = rowKeys(row);
      const color = row.tracks.length === 1 ? COLORS[row.tracks[0].channel] : '#b9bfd6';
      // Segment lines between keys of a single track (none after stepped keys).
      if (row.tracks.length === 1 && row.kind !== 'events') {
        const list = M.keysOf(editor.anim, row.tracks[0]);
        ctx.strokeStyle = color + '66';
        ctx.lineWidth = 2;
        for (let k = 0; k + 1 < list.length; k++) {
          if (list[k].curve === 'stepped' || row.tracks[0].channel === 'attachment') continue;
          ctx.beginPath();
          ctx.moveTo(xOf(list[k].time), y + ROW_H / 2);
          ctx.lineTo(xOf(list[k + 1].time), y + ROW_H / 2);
          ctx.stroke();
        }
      }
      for (const k of keys) {
        const x = xOf(k.time);
        const sel = k.refs.some((r) => selectedIds.has(M.keyId(r)));
        const r = row.depth === 0 && row.tracks.length > 1 ? 4.5 : 5.5;
        ctx.beginPath();
        ctx.moveTo(x, y + ROW_H / 2 - r);
        ctx.lineTo(x + r, y + ROW_H / 2);
        ctx.lineTo(x, y + ROW_H / 2 + r);
        ctx.lineTo(x - r, y + ROW_H / 2);
        ctx.closePath();
        ctx.fillStyle = sel ? '#ffb020' : color;
        ctx.fill();
        ctx.strokeStyle = sel ? '#ffffff' : '#00000088';
        ctx.lineWidth = sel ? 1.5 : 1;
        ctx.stroke();
        if (k.label) {
          ctx.fillStyle = '#ffe9a8';
          ctx.font = '11px system-ui, sans-serif';
          ctx.fillText(k.label, x + 8, y + 15);
        }
      }
      ctx.restore();
    });
    ctx.restore();

    // Label column border and past-the-end shade.
    ctx.fillStyle = '#00000055';
    const endX = xOf(dur);
    if (endX < width) ctx.fillRect(Math.max(LABEL_W, endX), RULER_H, width - Math.max(LABEL_W, endX), height - RULER_H);
    ctx.fillStyle = '#ffffff22';
    ctx.fillRect(LABEL_W - 1, 0, 1, height);

    // Ruler.
    ctx.fillStyle = '#151722';
    ctx.fillRect(0, 0, width, RULER_H);
    ctx.fillStyle = '#9aa0b8';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(`${editor.time.toFixed(2)}s · ${Math.round(editor.time * fps)}f`, 8, 17);
    const framePx = pps / fps;
    const stepS = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10].find((s) => s * pps >= 60) ?? 20;
    const t0 = Math.max(0, Math.floor(scrollX / stepS) * stepS);
    ctx.save();
    ctx.beginPath();
    ctx.rect(LABEL_W, 0, width - LABEL_W, height);
    ctx.clip();
    if (framePx >= 5)
      for (let f = Math.floor(scrollX * fps); f <= tOf(width) * fps; f++) {
        const x = Math.round(xOf(f / fps)) + 0.5;
        ctx.fillStyle = '#ffffff22';
        ctx.fillRect(x, RULER_H - 5, 1, 5);
      }
    for (let t = t0; xOf(t) < width; t = Math.round((t + stepS) * 1000) / 1000) {
      const x = Math.round(xOf(t)) + 0.5;
      ctx.fillStyle = '#ffffff44';
      ctx.fillRect(x, RULER_H - 10, 1, 10);
      ctx.fillStyle = '#ffffff10';
      ctx.fillRect(x, RULER_H, 1, height - RULER_H);
      ctx.fillStyle = '#c8cce0';
      ctx.fillText(`${+t.toFixed(2)}s`, x + 3, 12);
    }
    // End of the animation.
    if (endX >= LABEL_W && endX <= width) {
      ctx.fillStyle = '#ff6b6b';
      ctx.fillRect(Math.round(endX), 0, 2, RULER_H);
    }
    // Playhead.
    const px = Math.round(xOf(editor.time)) + 0.5;
    ctx.fillStyle = '#ff4d6d';
    ctx.fillRect(px - 0.5, 0, 2, height);
    ctx.beginPath();
    ctx.moveTo(px - 6, 0);
    ctx.lineTo(px + 7, 0);
    ctx.lineTo(px + 0.5, 9);
    ctx.closePath();
    ctx.fill();
    ctx.restore();

    if (boxSel) {
      ctx.fillStyle = '#5aa8ff22';
      ctx.strokeStyle = '#5aa8ffaa';
      const x = Math.min(boxSel.x0, boxSel.x1);
      const y = Math.min(boxSel.y0, boxSel.y1);
      ctx.fillRect(x, y, Math.abs(boxSel.x1 - boxSel.x0), Math.abs(boxSel.y1 - boxSel.y0));
      ctx.strokeRect(x + 0.5, y + 0.5, Math.abs(boxSel.x1 - boxSel.x0), Math.abs(boxSel.y1 - boxSel.y0));
    }
  }

  // ---------------- Interaction ----------------

  type Drag =
    | { kind: 'scrub' }
    | { kind: 'keys'; x0: number; start: M.KeyRef[]; started: boolean; anchor: number }
    | { kind: 'box'; additive: boolean; moved: boolean };
  let drag: Drag | null = null;

  function pos(e: MouseEvent) {
    const r = canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  function hitKey(x: number, y: number): { row: M.Row; refs: M.KeyRef[] } | null {
    const row = rows[rowAt(y)];
    if (!row || y < RULER_H) return null;
    let best: { d: number; refs: M.KeyRef[] } | null = null;
    for (const k of rowKeys(row)) {
      const d = Math.abs(xOf(k.time) - x);
      if (d <= 7 && (!best || d < best.d)) best = { d, refs: k.refs };
    }
    return best ? { row, refs: best.refs } : null;
  }

  function down(e: PointerEvent) {
    if (!editor.data) return;
    canvas.setPointerCapture(e.pointerId);
    const p = pos(e);
    if (p.y < RULER_H && p.x >= LABEL_W) {
      editor.playing = false;
      drag = { kind: 'scrub' };
      editor.seek(tOf(p.x), !e.shiftKey);
      return;
    }
    if (p.x < LABEL_W) {
      const row = rows[rowAt(p.y)];
      if (!row || p.y < RULER_H) return;
      if (row.expandable && p.x < 8 + row.depth * 18 + 14) {
        editor.expanded = row.expanded ? editor.expanded.filter((id) => id !== row.id) : [...editor.expanded, row.id];
        return;
      }
      if (row.kind === 'bone' || (row.kind === 'channel' && row.tracks[0].group === 'bones')) editor.selectBone(row.target);
      else if (row.kind === 'slot' || (row.kind === 'channel' && row.tracks[0].group === 'slots')) editor.selectSlot(row.target);
      // Select every key of the row with a double-click on the label.
      if (e.detail === 2) editor.selectedKeys = rowKeys(row).flatMap((k) => k.refs);
      return;
    }
    const hit = hitKey(p.x, p.y);
    if (hit) {
      const ids = new Set(editor.selectedKeys.map(M.keyId));
      const already = hit.refs.every((r) => ids.has(M.keyId(r)));
      if (e.shiftKey) editor.selectedKeys = already ? editor.selectedKeys.filter((k) => !hit.refs.some((r) => M.keyId(r) === M.keyId(k))) : M.uniqueRefs([...editor.selectedKeys, ...hit.refs]);
      else if (!already) editor.selectedKeys = hit.refs;
      if (hit.row.kind === 'bone' || hit.row.tracks[0]?.group === 'bones') editor.selectBone(hit.row.target);
      else if (hit.row.kind === 'slot' || hit.row.tracks[0]?.group === 'slots') editor.selectSlot(hit.row.target);
      editor.playing = false;
      editor.seek(hit.refs[0].time, false);
      drag = { kind: 'keys', x0: p.x, start: [...editor.selectedKeys], started: false, anchor: hit.refs[0].time };
      return;
    }
    drag = { kind: 'box', additive: e.shiftKey, moved: false };
    boxSel = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
  }

  function move(e: PointerEvent) {
    if (!drag) return;
    const p = pos(e);
    if (drag.kind === 'scrub') editor.seek(tOf(p.x), !e.shiftKey);
    else if (drag.kind === 'keys') {
      if (!drag.started && Math.abs(p.x - drag.x0) < 4) return;
      if (!drag.started) {
        drag.started = true;
        editor.beginDrag();
      }
      // The key under the pointer lands on a frame; the others keep their distance to it.
      const dt = M.snap(drag.anchor + (p.x - drag.x0) / pps, editor.fps) - drag.anchor;
      editor.dragKeys(drag.start, dt);
      if (editor.selectedKeys[0]) editor.seek(editor.selectedKeys[0].time, false);
    } else if (drag.kind === 'box' && boxSel) {
      boxSel = { ...boxSel, x1: p.x, y1: p.y };
      drag.moved = Math.abs(boxSel.x1 - boxSel.x0) > 3 || Math.abs(boxSel.y1 - boxSel.y0) > 3;
    }
  }

  function up(e: PointerEvent) {
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (drag?.kind === 'keys' && drag.started) editor.endDrag();
    if (drag?.kind === 'box' && boxSel) {
      if (!drag.moved) {
        if (!drag.additive) editor.selectedKeys = [];
        editor.playing = false;
        editor.seek(tOf(boxSel.x0));
      } else {
        const t0 = tOf(Math.min(boxSel.x0, boxSel.x1));
        const t1 = tOf(Math.max(boxSel.x0, boxSel.x1));
        const r0 = rowAt(Math.min(boxSel.y0, boxSel.y1));
        const r1 = rowAt(Math.max(boxSel.y0, boxSel.y1));
        const picked: M.KeyRef[] = [];
        rows.forEach((row, i) => {
          if (i < r0 || i > r1) return;
          for (const k of rowKeys(row)) if (k.time >= t0 - 1e-6 && k.time <= t1 + 1e-6) picked.push(...k.refs);
        });
        const seen = new Set<string>();
        editor.selectedKeys = [...(drag.additive ? editor.selectedKeys : []), ...picked].filter((k) => !seen.has(M.keyId(k)) && seen.add(M.keyId(k)));
      }
      boxSel = null;
    }
    drag = null;
  }

  function dblclick(e: MouseEvent) {
    const p = pos(e);
    if (p.x < LABEL_W || p.y < RULER_H || hitKey(p.x, p.y)) return;
    const row = rows[rowAt(p.y)];
    if (!row) return;
    const time = M.snap(tOf(p.x), editor.fps);
    if (row.kind === 'events') return editor.seek(time), editor.addEvent('event');
    if (row.kind === 'bone') {
      editor.selectBone(row.target);
      return editor.addKeyAt({ group: 'bones', target: row.target, channel: editor.tool }, time);
    }
    if (row.tracks.length === 1) editor.addKeyAt(row.tracks[0], time);
  }

  function wheel(e: WheelEvent) {
    e.preventDefault();
    const p = pos(e);
    if (e.ctrlKey || e.metaKey) {
      const at = tOf(p.x);
      pps = Math.min(3000, Math.max(20, pps * Math.exp(-e.deltaY * 0.002)));
      scrollX = Math.max(0, at - (p.x - LABEL_W) / pps);
    } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
      scrollX = Math.max(0, scrollX + (e.shiftKey ? e.deltaY : e.deltaX) / pps);
    } else {
      const max = Math.max(0, rows.length * ROW_H - (height - RULER_H) + 8);
      scrollY = Math.min(max, Math.max(0, scrollY + e.deltaY));
    }
  }

  export function fitAll() {
    pps = Math.max(40, (width - LABEL_W - 40) / Math.max(0.5, editor.duration));
    scrollX = 0;
  }
</script>

<div class="wrap" bind:this={box}>
  <canvas
    bind:this={canvas}
    style:width="{width}px"
    style:height="{height}px"
    onpointerdown={down}
    onpointermove={move}
    onpointerup={up}
    onpointercancel={up}
    ondblclick={dblclick}
    onwheel={wheel}
    data-testid="timeline"
    data-pps={pps}
    data-scrollx={scrollX}
    data-scrolly={scrollY}
  ></canvas>
</div>

<style>
  .wrap {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
  canvas {
    display: block;
    touch-action: none;
  }
</style>
