import type { L2DAnimation, L2DValueKey, L2DVec2Key } from '@llm2d/core';

export const sine = 'easeInOutSine';
export const r3 = (x: number) => {
  const v = Math.round(x * 1000) / 1000;
  return Object.is(v, -0) ? 0 : v;
};

/**
 * Seamless looping sway v(t) = amp * sin(2π (t - lag) / period) over one period, as keys at
 * the extremes (exact at the loop seam, so it repeats without a hitch).
 */
export function swayKeys(amp: number, period: number, lag = 0, start = 0): L2DValueKey[] {
  const v = (t: number) => amp * Math.sin((2 * Math.PI * (t - lag)) / period);
  const extremes = [lag + period / 4, lag + (3 * period) / 4]
    .map((t) => ((t % period) + period) % period)
    .filter((t) => t > 1e-6 && t < period - 1e-6)
    .sort((a, b) => a - b);
  return [
    { time: r3(start), value: r3(v(0)), curve: 'easeOutSine' },
    ...extremes.map((t, i) => ({
      time: r3(start + t),
      value: r3(v(t)),
      curve: i === extremes.length - 1 ? 'easeInSine' : sine,
    })),
    { time: r3(start + period), value: r3(v(period)) },
  ];
}

/** Uniform scale keys from [time, scale, curve?] tuples. */
export function scaleKeys(list: [number, number, string?][]): L2DVec2Key[] {
  return list.map(([time, s, curve]) => ({ time: r3(time), x: r3(s), y: r3(s), ...(curve ? { curve } : {}) }));
}

export function valueKeys(list: [number, number, string?][]): L2DValueKey[] {
  return list.map(([time, value, curve]) => ({ time: r3(time), value: r3(value), ...(curve ? { curve } : {}) }));
}

/** Shifts every key and event of an animation by `offset` seconds. */
export function shift(anim: L2DAnimation, offset: number): L2DAnimation {
  if (!offset) return anim;
  const move = <T extends { time: number }>(keys: T[] | undefined) => keys?.map((k) => ({ ...k, time: r3(k.time + offset) }));
  const out: L2DAnimation = {};
  if (anim.duration !== undefined) out.duration = r3(anim.duration + offset);
  if (anim.bones)
    out.bones = Object.fromEntries(
      Object.entries(anim.bones).map(([b, tl]) => [b, { rotate: move(tl.rotate), translate: move(tl.translate), scale: move(tl.scale) }]),
    );
  if (anim.slots)
    out.slots = Object.fromEntries(
      Object.entries(anim.slots).map(([s, tl]) => [s, { color: move(tl.color), alpha: move(tl.alpha), attachment: move(tl.attachment) }]),
    );
  if (anim.ik) out.ik = Object.fromEntries(Object.entries(anim.ik).map(([n, tl]) => [n, { mix: move(tl.mix) }]));
  if (anim.events) out.events = move(anim.events);
  return strip(out);
}

/** Removes undefined timelines so the JSON stays clean. */
export function strip(anim: L2DAnimation): L2DAnimation {
  const clean = <T extends object>(o: T) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
  const out: L2DAnimation = { ...anim };
  if (out.bones) out.bones = Object.fromEntries(Object.entries(out.bones).map(([k, v]) => [k, clean(v)]));
  if (out.slots) out.slots = Object.fromEntries(Object.entries(out.slots).map(([k, v]) => [k, clean(v)]));
  if (out.ik) out.ik = Object.fromEntries(Object.entries(out.ik).map(([k, v]) => [k, clean(v)]));
  return clean(out);
}

/**
 * Merges `add` into `base`: timelines in `add` replace the same bone/slot timeline in `base`,
 * everything else is kept. Events are combined. Duration is the longer of the two.
 */
export function mergeAnimations(base: L2DAnimation, add: L2DAnimation): L2DAnimation {
  const out: L2DAnimation = structuredClone(base);
  for (const [b, tl] of Object.entries(add.bones ?? {})) out.bones = { ...out.bones, [b]: { ...out.bones?.[b], ...tl } };
  for (const [s, tl] of Object.entries(add.slots ?? {})) out.slots = { ...out.slots, [s]: { ...out.slots?.[s], ...tl } };
  for (const [n, tl] of Object.entries(add.ik ?? {})) out.ik = { ...out.ik, [n]: { ...out.ik?.[n], ...tl } };
  if (add.events?.length) out.events = [...(out.events ?? []), ...add.events].sort((a, b) => a.time - b.time);
  if (add.duration !== undefined || base.duration !== undefined)
    out.duration = Math.max(add.duration ?? 0, base.duration ?? 0, lastKeyTime(add), lastKeyTime(base));
  return strip(out);
}

export function lastKeyTime(anim: L2DAnimation): number {
  let t = 0;
  const scan = (keys?: { time: number }[]) => keys?.forEach((k) => (t = Math.max(t, k.time)));
  for (const tl of Object.values(anim.bones ?? {})) (scan(tl.rotate), scan(tl.translate), scan(tl.scale));
  for (const tl of Object.values(anim.slots ?? {})) (scan(tl.color), scan(tl.alpha), scan(tl.attachment));
  for (const tl of Object.values(anim.ik ?? {})) scan(tl.mix);
  scan(anim.events);
  return Math.max(t, anim.duration ?? 0);
}
