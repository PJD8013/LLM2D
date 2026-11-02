/**
 * Editing operations on LLM2D animation JSON, independent of the UI.
 *
 * A *track* is one key list of an animation (a bone's rotate keys, a slot's alpha keys, the
 * events, ...). Keys are addressed by track + time: within a track there is at most one key per
 * time, so the time identifies it even after the list is re-sorted.
 */
import { BONE_CHANNELS, CH_ROT, CH_SX, CH_SY, CH_X, CH_Y, SLOT_CHANNELS, toHex, type L2DAnimation, type L2DCurve, type Skeleton, type SkeletonData } from '@llm2d/core';

export type BoneChannel = 'rotate' | 'translate' | 'scale';
export type SlotChannel = 'color' | 'alpha' | 'attachment';
export type Track =
  | { group: 'bones'; target: string; channel: BoneChannel }
  | { group: 'slots'; target: string; channel: SlotChannel }
  | { group: 'ik'; target: string; channel: 'mix' }
  | { group: 'events'; target: ''; channel: 'events' };
export type KeyRef = Track & { time: number };
export type AnyKey = { time: number; curve?: L2DCurve; [field: string]: unknown };

export const BONE_CHANNEL_LIST: BoneChannel[] = ['rotate', 'translate', 'scale'];
export const SLOT_CHANNEL_LIST: SlotChannel[] = ['color', 'alpha', 'attachment'];
export const EVENTS: Track = { group: 'events', target: '', channel: 'events' };

/** Times closer than this are the same key. */
export const EPS = 1e-4;

export const trackId = (t: Track) => `${t.group}/${t.target}/${t.channel}`;
export const keyId = (k: KeyRef) => `${trackId(k)}@${k.time.toFixed(4)}`;
export const sameTime = (a: number, b: number) => Math.abs(a - b) < EPS;
export const toTrack = (k: KeyRef): Track => ({ group: k.group, target: k.target, channel: k.channel }) as Track;

/** Rounds to a frame of `fps` (and to 4 decimals). */
export function snap(time: number, fps: number): number {
  return Math.max(0, Math.round(Math.round(time * fps) / fps * 10000) / 10000);
}

const round = (v: number, digits: number) => {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
};

/** The key list of a track, or undefined when it has none. With `create`, makes an empty one. */
function list(anim: L2DAnimation, t: Track, create = false): AnyKey[] | undefined {
  if (t.group === 'events') {
    if (!anim.events && create) anim.events = [];
    return anim.events as AnyKey[] | undefined;
  }
  const groups = anim as Record<string, Record<string, Record<string, AnyKey[]>> | undefined>;
  let g = groups[t.group];
  if (!g) {
    if (!create) return undefined;
    g = groups[t.group] = {};
  }
  let target = g[t.target];
  if (!target) {
    if (!create) return undefined;
    target = g[t.target] = {};
  }
  if (!target[t.channel] && create) target[t.channel] = [];
  return target[t.channel];
}

export function keysOf(anim: L2DAnimation, t: Track): AnyKey[] {
  return list(anim, t) ?? [];
}

export function getKey(anim: L2DAnimation, ref: KeyRef): AnyKey | undefined {
  return keysOf(anim, ref).find((k) => sameTime(k.time, ref.time));
}

/**
 * Adds a key, or replaces the key at the same time (keeping its curve unless the new key has
 * one, or `keepCurve` is false). Events are different: several may share a time, so they are
 * always added.
 */
export function setKey(anim: L2DAnimation, t: Track, key: AnyKey, keepCurve = true): void {
  const keys = list(anim, t, true)!;
  const i = t.group === 'events' ? -1 : keys.findIndex((k) => sameTime(k.time, key.time));
  if (i >= 0) {
    const curve = keepCurve ? (key.curve ?? keys[i].curve) : key.curve;
    keys[i] = { ...key, time: keys[i].time };
    if (curve !== undefined && t.channel !== 'attachment') keys[i].curve = curve;
    return;
  }
  keys.push({ ...key });
  keys.sort((a, b) => a.time - b.time);
}

/** Deletes the referenced keys (events: every event at that time). */
export function deleteKeys(anim: L2DAnimation, refs: KeyRef[]): void {
  for (const ref of refs) {
    const keys = list(anim, ref);
    if (!keys) continue;
    for (let i = keys.length - 1; i >= 0; i--) if (sameTime(keys[i].time, ref.time)) keys.splice(i, 1);
  }
  prune(anim);
}

/** The references without repeats (events sharing a time have one reference). */
export function uniqueRefs(refs: KeyRef[]): KeyRef[] {
  const seen = new Set<string>();
  return refs.filter((r) => !seen.has(keyId(r)) && !!seen.add(keyId(r)));
}

/**
 * Moves keys in time by `dt` (clamped at 0). Moved keys replace keys already at their new
 * time. Returns the moved keys' new references.
 */
export function moveKeys(anim: L2DAnimation, refs: KeyRef[], dt: number): KeyRef[] {
  refs = uniqueRefs(refs);
  if (!refs.length) return [];
  const byTrack = new Map<string, { track: Track; times: number[] }>();
  for (const r of refs) {
    const id = trackId(r);
    const entry = byTrack.get(id) ?? byTrack.set(id, { track: toTrack(r), times: [] }).get(id)!;
    entry.times.push(r.time);
  }
  const shift = Math.max(dt, -Math.min(...refs.map((r) => r.time)));
  const out: KeyRef[] = [];
  for (const { track, times } of byTrack.values()) {
    const keys = list(anim, track);
    if (!keys) continue;
    const moving = keys.filter((k) => times.some((t) => sameTime(t, k.time)));
    const staying = keys.filter((k) => !moving.includes(k));
    const moved = moving.map((k) => ({ ...k, time: round(k.time + shift, 4) }));
    const kept = track.group === 'events' ? staying : staying.filter((k) => !moved.some((m) => sameTime(m.time, k.time)));
    keys.splice(0, keys.length, ...[...kept, ...moved].sort((a, b) => a.time - b.time));
    for (const m of moved) out.push({ ...track, time: m.time } as KeyRef);
  }
  return uniqueRefs(out);
}

/** Sets (or with undefined, removes) the curve of the referenced keys. */
export function setCurve(anim: L2DAnimation, refs: KeyRef[], curve: L2DCurve | undefined): void {
  for (const ref of refs) {
    if (ref.channel === 'attachment' || ref.group === 'events') continue;
    const k = getKey(anim, ref);
    if (!k) continue;
    if (curve === undefined || curve === 'linear') delete k.curve;
    else k.curve = curve;
  }
}

/** Removes empty key lists, targets and groups. */
export function prune(anim: L2DAnimation): void {
  const groups = anim as Record<string, unknown>;
  for (const g of ['bones', 'slots', 'ik'] as const) {
    const group = groups[g] as Record<string, Record<string, unknown[]>> | undefined;
    if (!group) continue;
    for (const [target, channels] of Object.entries(group)) {
      for (const [ch, keys] of Object.entries(channels)) if (!keys?.length) delete channels[ch];
      if (!Object.keys(channels).length) delete group[target];
    }
    if (!Object.keys(group).length) delete groups[g];
  }
  if (anim.events && !anim.events.length) delete anim.events;
}

/** Every track that has keys. */
export function tracksWithKeys(anim: L2DAnimation): Track[] {
  const out: Track[] = [];
  for (const [target, tl] of Object.entries(anim.bones ?? {}))
    for (const ch of BONE_CHANNEL_LIST) if (tl[ch]?.length) out.push({ group: 'bones', target, channel: ch });
  for (const [target, tl] of Object.entries(anim.slots ?? {}))
    for (const ch of SLOT_CHANNEL_LIST) if (tl[ch]?.length) out.push({ group: 'slots', target, channel: ch });
  for (const [target, tl] of Object.entries(anim.ik ?? {})) if (tl.mix?.length) out.push({ group: 'ik', target, channel: 'mix' });
  if (anim.events?.length) out.push(EVENTS);
  return out;
}

/** The animation's length: its duration, or the last key time. */
export function lengthOf(anim: L2DAnimation): number {
  if (anim.duration !== undefined) return anim.duration;
  let max = 0;
  for (const t of tracksWithKeys(anim)) for (const k of keysOf(anim, t)) max = Math.max(max, k.time);
  return max;
}

// ---------------- Timeline rows ----------------

export interface Row {
  id: string;
  label: string;
  /** 0 = a bone, slot, IK constraint or the events; 1 = one channel of it. */
  depth: 0 | 1;
  kind: 'bone' | 'slot' | 'ik' | 'events' | 'channel';
  /** Bone or slot name for depth-0 rows and their channels. */
  target: string;
  /** Tracks shown on this row (all keyed channels for a summary row). */
  tracks: Track[];
  expandable: boolean;
  expanded: boolean;
}

export interface RowOptions {
  expanded: Set<string>;
  /** Show bones and slots without keys too. */
  showAll: boolean;
  selectedBone?: string | null;
  selectedSlot?: string | null;
}

const CHANNEL_LABEL: Record<string, string> = {
  rotate: '회전',
  translate: '이동',
  scale: '크기',
  color: '색',
  alpha: '투명도',
  attachment: '그림',
  mix: 'IK 비율',
};

export function channelLabel(channel: string): string {
  return CHANNEL_LABEL[channel] ?? channel;
}

/** Rows for the timeline: events, then bones (skeleton order), slots and IK constraints. */
export function timelineRows(anim: L2DAnimation, data: SkeletonData, o: RowOptions): Row[] {
  const rows: Row[] = [{ id: 'events', label: '이벤트', depth: 0, kind: 'events', target: '', tracks: [EVENTS], expandable: false, expanded: false }];
  for (const b of data.bones) {
    const tl = anim.bones?.[b.name];
    const keyed = BONE_CHANNEL_LIST.filter((ch) => tl?.[ch]?.length);
    if (!keyed.length && !o.showAll && o.selectedBone !== b.name) continue;
    const id = `bone/${b.name}`;
    const expanded = o.expanded.has(id);
    rows.push({
      id,
      label: b.name,
      depth: 0,
      kind: 'bone',
      target: b.name,
      tracks: keyed.map((channel) => ({ group: 'bones', target: b.name, channel })),
      expandable: true,
      expanded,
    });
    if (expanded)
      for (const channel of BONE_CHANNEL_LIST)
        rows.push({ id: `${id}/${channel}`, label: channelLabel(channel), depth: 1, kind: 'channel', target: b.name, tracks: [{ group: 'bones', target: b.name, channel }], expandable: false, expanded: false });
  }
  for (const s of data.slots) {
    const tl = anim.slots?.[s.name];
    const keyed = SLOT_CHANNEL_LIST.filter((ch) => tl?.[ch]?.length);
    if (!keyed.length && !o.showAll && o.selectedSlot !== s.name) continue;
    const id = `slot/${s.name}`;
    const expanded = o.expanded.has(id);
    rows.push({
      id,
      label: `▣ ${s.name}`,
      depth: 0,
      kind: 'slot',
      target: s.name,
      tracks: keyed.map((channel) => ({ group: 'slots', target: s.name, channel })),
      expandable: true,
      expanded,
    });
    if (expanded)
      for (const channel of SLOT_CHANNEL_LIST)
        rows.push({ id: `${id}/${channel}`, label: channelLabel(channel), depth: 1, kind: 'channel', target: s.name, tracks: [{ group: 'slots', target: s.name, channel }], expandable: false, expanded: false });
  }
  for (const c of data.ik) {
    if (!anim.ik?.[c.name]?.mix?.length && !o.showAll) continue;
    rows.push({ id: `ik/${c.name}`, label: `IK ${c.name}`, depth: 0, kind: 'ik', target: c.name, tracks: [{ group: 'ik', target: c.name, channel: 'mix' }], expandable: false, expanded: false });
  }
  return rows;
}

// ---------------- Pose <-> keys ----------------

/**
 * A key that reproduces the current pose of a bone channel at `time`. Values are relative to
 * setup like the format: rotation and translation added, scale multiplied.
 */
export function boneKeyFromPose(data: SkeletonData, sk: Skeleton, bone: string, channel: BoneChannel, time: number): AnyKey {
  const b = data.findBone(bone);
  if (b < 0) throw new Error(`Unknown bone ${bone}`);
  const o = b * BONE_CHANNELS;
  const now = sk.channels;
  const setup = data.setupChannels;
  if (channel === 'rotate') return { time, value: round(now[o + CH_ROT] - setup[o + CH_ROT], 2) };
  if (channel === 'translate') return { time, x: round(now[o + CH_X] - setup[o + CH_X], 2), y: round(now[o + CH_Y] - setup[o + CH_Y], 2) };
  const ratio = (c: number) => (Math.abs(setup[o + c]) > 1e-9 ? now[o + c] / setup[o + c] : 1);
  return { time, x: round(ratio(CH_SX), 4), y: round(ratio(CH_SY), 4) };
}

/** A key that reproduces a slot channel as currently shown. */
export function slotKeyFromPose(data: SkeletonData, sk: Skeleton, slot: string, channel: SlotChannel, time: number): AnyKey {
  const s = data.findSlot(slot);
  if (s < 0) throw new Error(`Unknown slot ${slot}`);
  if (channel === 'attachment') {
    const a = sk.attachments[s];
    return { time, name: a < 0 ? null : data.attachments[s][a].name };
  }
  const o = data.slotChannelBase + s * SLOT_CHANNELS;
  const c = sk.channels;
  if (channel === 'alpha') return { time, value: round(c[o + 3], 3) };
  return { time, value: toHex({ r: c[o], g: c[o + 1], b: c[o + 2], a: c[o + 3] }) };
}

/** Current local value of a bone, relative to setup (as stored in keys). */
export function boneOffsets(data: SkeletonData, sk: Skeleton, bone: string) {
  const o = data.findBone(bone) * BONE_CHANNELS;
  const now = sk.channels;
  const setup = data.setupChannels;
  const ratio = (c: number) => (Math.abs(setup[o + c]) > 1e-9 ? now[o + c] / setup[o + c] : 1);
  return {
    rotate: now[o + CH_ROT] - setup[o + CH_ROT],
    x: now[o + CH_X] - setup[o + CH_X],
    y: now[o + CH_Y] - setup[o + CH_Y],
    scaleX: ratio(CH_SX),
    scaleY: ratio(CH_SY),
  };
}

// ---------------- Copy & paste ----------------

export interface Clip {
  items: { track: Track; key: AnyKey }[];
}

/** Copies keys with times relative to the earliest one. */
export function copyKeys(anim: L2DAnimation, refs: KeyRef[]): Clip | null {
  const found = uniqueRefs(refs).flatMap((r) =>
    r.group === 'events'
      ? keysOf(anim, r).filter((k) => sameTime(k.time, r.time)).map((key) => ({ track: toTrack(r), key }))
      : [getKey(anim, r)].filter((k): k is AnyKey => !!k).map((key) => ({ track: toTrack(r), key })),
  );
  if (!found.length) return null;
  const t0 = Math.min(...found.map((f) => f.key.time));
  return { items: found.map((f) => ({ track: f.track, key: structuredClone({ ...f.key, time: round(f.key.time - t0, 4) }) })) };
}

/** Pastes copied keys starting at `at` (replacing keys there, curve included); returns the new keys. */
export function pasteKeys(anim: L2DAnimation, clip: Clip, at: number): KeyRef[] {
  return uniqueRefs(
    clip.items.map(({ track, key }) => {
      const time = round(at + key.time, 4);
      setKey(anim, track, { ...structuredClone(key), time }, false);
      return { ...track, time } as KeyRef;
    }),
  );
}

// ---------------- Undo ----------------

/** Snapshot history (snapshots are strings, e.g. JSON of all animations). */
export class History {
  private past: string[] = [];
  private future: string[] = [];
  private readonly limit: number;

  constructor(limit = 200) {
    this.limit = limit;
  }

  /** Records the state before a change. */
  push(before: string): void {
    if (this.past[this.past.length - 1] === before) return;
    this.past.push(before);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }

  undo(current: string): string | null {
    const prev = this.past.pop();
    if (prev === undefined) return null;
    this.future.push(current);
    return prev;
  }

  redo(current: string): string | null {
    const next = this.future.pop();
    if (next === undefined) return null;
    this.past.push(current);
    return next;
  }

  /** Forgets the last recorded state (a change that turned out to change nothing). */
  dropLast(): void {
    this.past.pop();
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }
  get canRedo(): boolean {
    return this.future.length > 0;
  }

  clear(): void {
    this.past = [];
    this.future = [];
  }
}
