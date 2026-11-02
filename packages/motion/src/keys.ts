import type { L2DAnimation, L2DValueKey, L2DVec2Key } from '@llm2d/core';

export const sine = 'easeInOutSine';
export const r3 = (x: number) => {
  const v = Math.round(x * 1000) / 1000;
  return Object.is(v, -0) ? 0 : v;
};

/**
 * Seamless looping sway v(t) = amp * sin(2π (t - lag) / period) over one period: keys at the
 * zero crossings and extremes (and the loop seam), each segment a cubic Bézier matching the sine's
 * slope at both ends, so the speed is continuous everywhere, the seam included.
 */
export function swayKeys(amp: number, period: number, lag = 0, start = 0): L2DValueKey[] {
  const w = (2 * Math.PI) / period;
  const v = (t: number) => amp * Math.sin(w * (t - lag));
  const slope = (t: number) => amp * w * Math.cos(w * (t - lag));
  const times = [0, period];
  for (let k = 0; k < 4; k++) {
    const t = (((lag + (k * period) / 4) % period) + period) % period;
    if (t > 1e-6 && t < period - 1e-6) times.push(t);
  }
  times.sort((a, b) => a - b);
  return times.map((t, i) => {
    const key: L2DValueKey = { time: r3(start + t), value: r3(v(t)) };
    const next = times[i + 1];
    if (next === undefined) return key;
    const dt = next - t;
    const dv = v(next) - v(t);
    // Hermite to Bézier: control points a third of the way along the end tangents.
    if (Math.abs(dv) > 1e-9) key.curve = [0.333, r3((slope(t) * dt) / 3 / dv), 0.667, r3(1 - (slope(next) * dt) / 3 / dv)];
    return key;
  });
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
 * Merges `add` into `base`. For each timeline in `add`, its keys replace those of the same
 * timeline in `base` from its first key on; earlier keys stay, so presets placed one after the
 * other with "start" add up, and re-applying a preset replaces it. Events `add` fires replace
 * events of the same name from that time on. Everything else is kept; the duration covers the
 * result.
 */
export function mergeAnimations(base: L2DAnimation, add: L2DAnimation): L2DAnimation {
  const out = structuredClone(base) as L2DAnimation & Record<string, unknown>;
  const join = (old: { time: number }[] | undefined, keys: { time: number }[]) => {
    const from = keys[0]?.time ?? 0;
    return [...(old ?? []).filter((k) => k.time < from - 1e-6), ...structuredClone(keys)];
  };
  for (const group of ['bones', 'slots', 'ik'] as const) {
    const adds = add[group] as Record<string, Record<string, { time: number }[]>> | undefined;
    if (!adds) continue;
    const g = ((out[group] as Record<string, Record<string, { time: number }[]>> | undefined) ?? {}) as Record<string, Record<string, { time: number }[]>>;
    for (const [target, channels] of Object.entries(adds)) {
      const t = (g[target] ??= {});
      for (const [channel, keys] of Object.entries(channels)) if (keys) t[channel] = join(t[channel], keys);
    }
    (out as Record<string, unknown>)[group] = g;
  }
  if (add.events?.length) {
    const from = Math.min(...add.events.map((e) => e.time), firstKeyTime(add));
    const names = new Set(add.events.map((e) => e.name));
    out.events = [...(out.events ?? []).filter((e) => !(names.has(e.name) && e.time >= from - 1e-6)), ...structuredClone(add.events)].sort((a, b) => a.time - b.time);
  }
  if (add.duration !== undefined || base.duration !== undefined) {
    delete out.duration;
    out.duration = Math.max(add.duration ?? 0, lastKeyTime(out));
  }
  return strip(out);
}

/** Time of the earliest key in an animation (Infinity if it has none). */
function firstKeyTime(anim: L2DAnimation): number {
  let t = Infinity;
  const scan = (keys?: { time: number }[]) => keys?.forEach((k) => (t = Math.min(t, k.time)));
  for (const tl of Object.values(anim.bones ?? {})) (scan(tl.rotate), scan(tl.translate), scan(tl.scale));
  for (const tl of Object.values(anim.slots ?? {})) (scan(tl.color), scan(tl.alpha), scan(tl.attachment));
  for (const tl of Object.values(anim.ik ?? {})) scan(tl.mix);
  return t;
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

/**
 * Applies a partial animation to `base`: every timeline in `patch` (a bone, slot or IK channel)
 * replaces that timeline, an empty list deletes it, `events` replaces the events and `duration`
 * replaces the duration. Everything not mentioned is kept.
 */
export function patchAnimation(base: L2DAnimation, patch: L2DAnimation): L2DAnimation {
  const out = structuredClone(base) as Record<string, unknown> & L2DAnimation;
  for (const group of ['bones', 'slots', 'ik'] as const) {
    const changes = patch[group] as Record<string, Record<string, unknown[]>> | undefined;
    if (!changes) continue;
    const g = (out[group] ?? {}) as Record<string, Record<string, unknown[]>>;
    for (const [target, channels] of Object.entries(changes)) {
      const t = (g[target] ??= {});
      for (const [channel, keys] of Object.entries(channels)) {
        if (Array.isArray(keys) && keys.length === 0) delete t[channel];
        else t[channel] = structuredClone(keys);
      }
      if (!Object.keys(t).length) delete g[target];
    }
    if (Object.keys(g).length) (out as Record<string, unknown>)[group] = g;
    else delete out[group];
  }
  if (patch.events) {
    if (patch.events.length) out.events = structuredClone(patch.events).sort((a, b) => a.time - b.time);
    else delete out.events;
  }
  if (patch.duration !== undefined) out.duration = patch.duration;
  return out;
}
